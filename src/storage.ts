export interface Manifest {
  version: number;
  deviceId: string;
  updatedAt: number;
  files: Record<string, FileEntry>;
}

export interface FileEntry {
  hash: string;
  mtime: number;
  size: number;
  deleted?: boolean;
}

export interface StorageBackend {
  put(key: string, data: ArrayBuffer): Promise<void>;
  get(key: string): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  test(): Promise<{ ok: boolean; error?: string }>;
}

export class Storage {
  private backend: StorageBackend;

  constructor(backend: StorageBackend) {
    this.backend = backend;
  }

  async putFile(key: string, data: ArrayBuffer): Promise<void> {
    await this.backend.put(`files/${key}`, data);
  }

  async getFile(key: string): Promise<ArrayBuffer | null> {
    return this.backend.get(`files/${key}`);
  }

  async deleteFile(key: string): Promise<void> {
    await this.backend.delete(`files/${key}`);
  }

  async putBlob(hash: string, data: ArrayBuffer): Promise<void> {
    await this.backend.put(`_thoth/blobs/${hash}`, data);
  }

  async getBlob(hash: string): Promise<ArrayBuffer | null> {
    return this.backend.get(`_thoth/blobs/${hash}`);
  }

  async getManifest(): Promise<Manifest | null> {
    const data = await this.backend.get("_thoth/manifest.json");
    if (!data) return null;
    const text = new TextDecoder().decode(data);
    return JSON.parse(text) as Manifest;
  }

  async putManifest(manifest: Manifest): Promise<void> {
    const data = new TextEncoder().encode(JSON.stringify(manifest));
    await this.backend.put("_thoth/manifest.json", data.buffer);
  }

  async deleteAll(): Promise<number> {
    const keys = await this.backend.list("");
    const CONCURRENCY = 50;
    let deleted = 0;
    for (let i = 0; i < keys.length; i += CONCURRENCY) {
      const batch = keys.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(k => this.backend.delete(k)));
      deleted += batch.length;
    }
    return deleted;
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    return this.backend.test();
  }
}
