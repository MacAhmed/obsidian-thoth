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
    return JSON.parse(text);
  }

  async putManifest(manifest: Manifest): Promise<void> {
    const data = new TextEncoder().encode(JSON.stringify(manifest));
    await this.backend.put("_thoth/manifest.json", data.buffer);
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    return this.backend.test();
  }
}
