import type { StorageBackend } from "../src/storage";
import { SyncEngineV2 } from "../src/sync-engine";

export class MemoryBackend implements StorageBackend {
  store = new Map<string, ArrayBuffer>();
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

export class MockVault {
  files = new Map<string, { path: string; content: ArrayBuffer; mtime: number; size: number }>();

  addFile(path: string, content: string): void {
    const encoded = new TextEncoder().encode(content);
    this.files.set(path, { path, content: encoded.buffer, mtime: Date.now(), size: encoded.byteLength });
  }

  modifyFile(path: string, content: string): void {
    const encoded = new TextEncoder().encode(content);
    this.files.set(path, { path, content: encoded.buffer, mtime: Date.now(), size: encoded.byteLength });
  }

  deleteFile(path: string): void { this.files.delete(path); }

  renameFile(oldPath: string, newPath: string): void {
    const file = this.files.get(oldPath);
    if (!file) return;
    this.files.delete(oldPath);
    this.files.set(newPath, { ...file, path: newPath });
  }

  getFile(path: string) { return this.files.get(path) ?? null; }
  getAllFiles() { return [...this.files.values()]; }
  readBinary(path: string) { return this.files.get(path)?.content ?? null; }
}

export function createEngine(config: { backend: MemoryBackend; vault?: MockVault; deviceId?: string }) {
  const vault = config.vault ?? new MockVault();
  const deviceId = config.deviceId ?? "desktop";
  const engine = new SyncEngineV2({
    backend: config.backend,
    vault: {
      getFiles: () => vault.getAllFiles().map(f => ({ path: f.path, stat: { mtime: f.mtime, size: f.size } })),
      readBinary: (path: string) => vault.readBinary(path),
      createBinary: async (path: string, data: ArrayBuffer) => { vault.addFile(path, new TextDecoder().decode(data)); },
      modifyBinary: async (path: string, data: ArrayBuffer) => { vault.modifyFile(path, new TextDecoder().decode(data)); },
      deletePath: async (path: string) => { vault.deleteFile(path); },
      renamePath: async (oldPath: string, newPath: string) => { vault.renameFile(oldPath, newPath); },
      exists: (path: string) => vault.files.has(path),
      ensureFolder: async (_path: string) => {},
    },
    deviceId,
  });
  return { engine, vault };
}
