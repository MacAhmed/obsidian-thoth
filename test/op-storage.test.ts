import { describe, it, expect, beforeEach } from "vitest";
import { OpStorage } from "../src/op-storage";
import type { StorageBackend } from "../src/storage";
import type { Op, Head } from "../src/types";

class MemoryBackend implements StorageBackend {
  private store = new Map<string, ArrayBuffer>();
  private etags = new Map<string, string>();
  private counter = 0;

  async put(key: string, data: ArrayBuffer): Promise<void> {
    this.store.set(key, data);
    this.etags.set(key, String(++this.counter));
  }

  async putConditional(key: string, data: ArrayBuffer, ifMatch: string): Promise<boolean> {
    const current = this.etags.get(key);
    if (current !== ifMatch) return false;
    this.store.set(key, data);
    this.etags.set(key, String(++this.counter));
    return true;
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    return this.store.get(key) ?? null;
  }

  async getWithEtag(key: string): Promise<{ data: ArrayBuffer; etag: string } | null> {
    const data = this.store.get(key);
    if (!data) return null;
    return { data, etag: this.etags.get(key)! };
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
    this.etags.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.store.keys()].filter(k => k.startsWith(prefix));
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    return { ok: true };
  }
}

function makeOp(seq: number, type: "create" | "modify" | "delete" | "rename" = "create"): Op {
  if (type === "create") {
    return { seq, device: "dev1", ts: Date.now(), type: "create", fileId: `file-${seq}`, path: `notes/note-${seq}.md`, hash: `hash-${seq}`, size: 100 };
  }
  if (type === "modify") {
    return { seq, device: "dev1", ts: Date.now(), type: "modify", fileId: `file-${seq}`, hash: `hash-${seq}`, previousHash: `hash-${seq - 1}`, size: 200, basedOnSeq: seq - 1 };
  }
  if (type === "delete") {
    return { seq, device: "dev1", ts: Date.now(), type: "delete", fileId: `file-${seq}`, basedOnSeq: seq - 1 };
  }
  return { seq, device: "dev1", ts: Date.now(), type: "rename", fileId: `file-${seq}`, oldPath: `old-${seq}.md`, newPath: `new-${seq}.md`, basedOnSeq: seq - 1 };
}

describe("OpStorage", () => {
  let backend: MemoryBackend;
  let opStorage: OpStorage;

  beforeEach(() => {
    backend = new MemoryBackend();
    opStorage = new OpStorage(backend);
  });

  describe("head.json", () => {
    it("returns null head when nothing exists", async () => {
      const result = await opStorage.getHead();
      expect(result).toBeNull();
    });

    it("writes and reads head", async () => {
      await opStorage.writeHead({ version: 2, seq: 5, chunk: "ops/000001.jsonl" }, null);
      const result = await opStorage.getHead();
      expect(result).not.toBeNull();
      expect(result!.head.seq).toBe(5);
      expect(result!.head.version).toBe(2);
    });

    it("conditional write succeeds with correct etag", async () => {
      await opStorage.writeHead({ version: 2, seq: 0, chunk: "" }, null);
      const first = await opStorage.getHead();
      const ok = await opStorage.writeHead({ version: 2, seq: 5, chunk: "ops/000001.jsonl" }, first!.etag);
      expect(ok).toBe(true);
      const after = await opStorage.getHead();
      expect(after!.head.seq).toBe(5);
    });

    it("conditional write fails with stale etag", async () => {
      await opStorage.writeHead({ version: 2, seq: 0, chunk: "" }, null);
      const first = await opStorage.getHead();
      await opStorage.writeHead({ version: 2, seq: 5, chunk: "ops/000001.jsonl" }, first!.etag);
      const ok = await opStorage.writeHead({ version: 2, seq: 10, chunk: "ops/000006.jsonl" }, first!.etag);
      expect(ok).toBe(false);
    });
  });

  describe("op chunks", () => {
    it("writes a chunk and reads it back", async () => {
      const ops: Op[] = [makeOp(1), makeOp(2), makeOp(3)];
      await opStorage.writeChunk(1, ops);
      const read = await opStorage.readChunk("ops/000001.jsonl");
      expect(read).toHaveLength(3);
      expect(read[0].seq).toBe(1);
      expect(read[2].seq).toBe(3);
    });

    it("generates correct chunk key from start seq", async () => {
      const ops: Op[] = [makeOp(501), makeOp(502)];
      await opStorage.writeChunk(501, ops);
      const read = await opStorage.readChunk("ops/000501.jsonl");
      expect(read).toHaveLength(2);
    });

    it("returns empty array for missing chunk", async () => {
      const read = await opStorage.readChunk("ops/999999.jsonl");
      expect(read).toHaveLength(0);
    });

    it("handles all op types in a chunk", async () => {
      const ops: Op[] = [
        makeOp(1, "create"),
        makeOp(2, "modify"),
        makeOp(3, "delete"),
        makeOp(4, "rename"),
      ];
      await opStorage.writeChunk(1, ops);
      const read = await opStorage.readChunk("ops/000001.jsonl");
      expect(read[0].type).toBe("create");
      expect(read[1].type).toBe("modify");
      expect(read[2].type).toBe("delete");
      expect(read[3].type).toBe("rename");
    });
  });

  describe("listChunks", () => {
    it("lists chunks after a given seq", async () => {
      await opStorage.writeChunk(1, [makeOp(1), makeOp(2)]);
      await opStorage.writeChunk(3, [makeOp(3), makeOp(4)]);
      await opStorage.writeChunk(5, [makeOp(5)]);

      const all = await opStorage.listChunksAfter(0);
      expect(all).toHaveLength(3);

      const after2 = await opStorage.listChunksAfter(2);
      expect(after2).toHaveLength(2);
      expect(after2[0]).toBe("ops/000003.jsonl");

      const after4 = await opStorage.listChunksAfter(4);
      expect(after4).toHaveLength(1);
      expect(after4[0]).toBe("ops/000005.jsonl");
    });
  });

  describe("readOpsAfter", () => {
    it("reads all ops after a given seq", async () => {
      await opStorage.writeChunk(1, [makeOp(1), makeOp(2), makeOp(3)]);
      await opStorage.writeChunk(4, [makeOp(4), makeOp(5)]);

      const ops = await opStorage.readOpsAfter(2);
      expect(ops).toHaveLength(3);
      expect(ops[0].seq).toBe(3);
      expect(ops[1].seq).toBe(4);
      expect(ops[2].seq).toBe(5);
    });

    it("returns empty when already at head", async () => {
      await opStorage.writeChunk(1, [makeOp(1), makeOp(2)]);
      const ops = await opStorage.readOpsAfter(2);
      expect(ops).toHaveLength(0);
    });
  });

  describe("checkpoint", () => {
    it("writes and reads checkpoint", async () => {
      const checkpoint = {
        seq: 100,
        ts: Date.now(),
        files: { "file-1": { path: "notes/a.md", hash: "abc", size: 50 } },
        tombstones: {},
      };
      await opStorage.writeCheckpoint(checkpoint);
      const read = await opStorage.readCheckpoint();
      expect(read).not.toBeNull();
      expect(read!.seq).toBe(100);
      expect(read!.files["file-1"].path).toBe("notes/a.md");
    });

    it("returns null when no checkpoint", async () => {
      const read = await opStorage.readCheckpoint();
      expect(read).toBeNull();
    });
  });

  describe("blobs", () => {
    it("puts and gets a blob", async () => {
      const data = new TextEncoder().encode("hello world").buffer;
      await opStorage.putBlob("abc123", data);
      const read = await opStorage.getBlob("abc123");
      expect(read).not.toBeNull();
      expect(new TextDecoder().decode(read!)).toBe("hello world");
    });

    it("checks blob existence", async () => {
      expect(await opStorage.hasBlob("missing")).toBe(false);
      const data = new TextEncoder().encode("x").buffer;
      await opStorage.putBlob("exists", data);
      expect(await opStorage.hasBlob("exists")).toBe(true);
    });
  });
});
