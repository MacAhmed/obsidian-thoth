import type { StorageBackend } from "./storage";
import type { Op, Head, Checkpoint } from "./types";

const HEAD_KEY = "head.json";
const CHECKPOINT_KEY = "checkpoint.json";
const OPS_PREFIX = "ops/";
const BLOBS_PREFIX = "blobs/";

export class OpStorage {
  private backend: StorageBackend;

  constructor(backend: StorageBackend) {
    this.backend = backend;
  }

  async getHead(): Promise<{ head: Head; etag: string } | null> {
    const result = await this.backend.getWithEtag(HEAD_KEY);
    if (!result) return null;
    const head = JSON.parse(new TextDecoder().decode(result.data)) as Head;
    return { head, etag: result.etag };
  }

  async writeHead(head: Head, ifMatch: string | null): Promise<boolean> {
    const data = new TextEncoder().encode(JSON.stringify(head)).buffer;
    if (ifMatch === null) {
      await this.backend.put(HEAD_KEY, data);
      return true;
    }
    return this.backend.putConditional(HEAD_KEY, data, ifMatch);
  }

  chunkKey(startSeq: number, nonce?: string): string {
    const base = `${OPS_PREFIX}${String(startSeq).padStart(6, "0")}`;
    return nonce ? `${base}-${nonce}.jsonl` : `${base}.jsonl`;
  }

  async writeChunk(startSeq: number, ops: Op[], nonce?: string): Promise<string> {
    const key = this.chunkKey(startSeq, nonce);
    const lines = ops.map(op => JSON.stringify(op)).join("\n");
    const data = new TextEncoder().encode(lines).buffer;
    await this.backend.put(key, data);
    return key;
  }

  async readChunk(key: string): Promise<Op[]> {
    const data = await this.backend.get(key);
    if (!data) return [];
    const text = new TextDecoder().decode(data);
    if (!text.trim()) return [];
    return text.trim().split("\n").map(line => JSON.parse(line) as Op);
  }

  async listChunksAfter(seq: number): Promise<string[]> {
    const keys = await this.backend.list(OPS_PREFIX);
    return keys
      .filter(k => {
        const startSeq = this.parseChunkStartSeq(k);
        return startSeq > seq;
      })
      .sort();
  }

  async readOpsAfter(seq: number): Promise<Op[]> {
    const keys = await this.backend.list(OPS_PREFIX);
    const sorted = keys.sort();
    const ops: Op[] = [];

    for (const key of sorted) {
      const startSeq = this.parseChunkStartSeq(key);
      const chunk = await this.readChunk(key);
      if (chunk.length === 0) continue;
      const lastSeqInChunk = chunk[chunk.length - 1].seq;
      if (lastSeqInChunk <= seq) continue;
      for (const op of chunk) {
        if (op.seq > seq) ops.push(op);
      }
    }

    return ops;
  }

  private parseChunkStartSeq(key: string): number {
    const match = key.match(/ops\/(\d+)/);
    if (!match) return 0;
    return parseInt(match[1], 10);
  }

  async writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
    const data = new TextEncoder().encode(JSON.stringify(checkpoint)).buffer;
    await this.backend.put(CHECKPOINT_KEY, data);
  }

  async readCheckpoint(): Promise<Checkpoint | null> {
    const data = await this.backend.get(CHECKPOINT_KEY);
    if (!data) return null;
    return JSON.parse(new TextDecoder().decode(data)) as Checkpoint;
  }

  async putBlob(hash: string, data: ArrayBuffer): Promise<void> {
    await this.backend.put(`${BLOBS_PREFIX}${hash}`, data);
  }

  async getBlob(hash: string): Promise<ArrayBuffer | null> {
    return this.backend.get(`${BLOBS_PREFIX}${hash}`);
  }

  async hasBlob(hash: string): Promise<boolean> {
    const data = await this.backend.get(`${BLOBS_PREFIX}${hash}`);
    return data !== null;
  }

  async deleteAll(): Promise<number> {
    const keys = await this.backend.list("");
    for (const key of keys) {
      await this.backend.delete(key);
    }
    return keys.length;
  }
}
