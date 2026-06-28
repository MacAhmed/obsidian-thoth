import { describe, it, expect } from "vitest";
import { SyncEngineV2 } from "../src/sync-engine";
import type { StorageBackend } from "../src/storage";

class MemoryBackend implements StorageBackend {
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

class MockVault {
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

function createEngine(config: { backend: MemoryBackend; vault?: MockVault; deviceId: string }) {
  const vault = config.vault ?? new MockVault();
  const engine = new SyncEngineV2({
    backend: config.backend,
    vault: {
      getFiles: () => vault.getAllFiles().map(f => ({ path: f.path, stat: { mtime: f.mtime, size: f.size } })),
      readBinary: (path: string) => vault.readBinary(path),
      createBinary: (path: string, data: ArrayBuffer) => { vault.addFile(path, new TextDecoder().decode(data)); },
      modifyBinary: (path: string, data: ArrayBuffer) => { vault.modifyFile(path, new TextDecoder().decode(data)); },
      deletePath: (path: string) => { vault.deleteFile(path); },
      renamePath: (oldPath: string, newPath: string) => { vault.renameFile(oldPath, newPath); },
      exists: (path: string) => vault.files.has(path),
      ensureFolder: () => {},
    },
    deviceId: config.deviceId,
  });
  return { engine, vault };
}

describe("bulk rename (the V1 killer)", () => {
  it("renames 100 files without data loss or ghost resurrection", async () => {
    const backend = new MemoryBackend();

    const { engine: engineA, vault: vaultA } = createEngine({ backend, deviceId: "A" });
    for (let i = 0; i < 100; i++) {
      vaultA.addFile(`old/note-${i}.md`, `content ${i}`);
      await engineA.onFileCreate(`old/note-${i}.md`);
    }
    await engineA.flush();

    const { engine: engineB, vault: vaultB } = createEngine({ backend, deviceId: "B" });
    await engineB.pull();

    for (let i = 0; i < 100; i++) {
      expect(vaultB.getFile(`old/note-${i}.md`)).not.toBeNull();
    }

    for (let i = 0; i < 100; i++) {
      vaultA.renameFile(`old/note-${i}.md`, `new/note-${i}.md`);
      engineA.onFileRename(`old/note-${i}.md`, `new/note-${i}.md`);
    }
    await engineA.flush();

    await engineB.pull();

    for (let i = 0; i < 100; i++) {
      expect(vaultB.getFile(`old/note-${i}.md`)).toBeNull();
      expect(vaultB.getFile(`new/note-${i}.md`)).not.toBeNull();
      const content = new TextDecoder().decode(vaultB.readBinary(`new/note-${i}.md`)!);
      expect(content).toBe(`content ${i}`);
    }
  });

  it("rename + edit on same file by different devices", async () => {
    const backend = new MemoryBackend();

    const { engine: engineA, vault: vaultA } = createEngine({ backend, deviceId: "A" });
    vaultA.addFile("shared.md", "original");
    await engineA.onFileCreate("shared.md");
    await engineA.flush();

    const { engine: engineB, vault: vaultB } = createEngine({ backend, deviceId: "B" });
    await engineB.pull();

    vaultA.renameFile("shared.md", "renamed.md");
    engineA.onFileRename("shared.md", "renamed.md");
    await engineA.flush();

    vaultB.modifyFile("shared.md", "edited content");
    await engineB.onFileModify("shared.md");
    await engineB.flush();

    await engineB.pull();
    expect(vaultB.getFile("renamed.md")).not.toBeNull();
  });

  it("delete propagation — no ghost resurrection", async () => {
    const backend = new MemoryBackend();

    const { engine: engineA, vault: vaultA } = createEngine({ backend, deviceId: "A" });
    vaultA.addFile("to-delete.md", "doomed");
    await engineA.onFileCreate("to-delete.md");
    await engineA.flush();

    const { engine: engineB, vault: vaultB } = createEngine({ backend, deviceId: "B" });
    await engineB.pull();
    expect(vaultB.getFile("to-delete.md")).not.toBeNull();

    vaultA.deleteFile("to-delete.md");
    engineA.onFileDelete("to-delete.md");
    await engineA.flush();

    await engineB.pull();
    expect(vaultB.getFile("to-delete.md")).toBeNull();

    await engineB.pull();
    expect(vaultB.getFile("to-delete.md")).toBeNull();
  });
});

describe("concurrent push (sequence conflict)", () => {
  it("both devices flush — second device retries with rebased seqs", async () => {
    const backend = new MemoryBackend();

    const { engine: engineA, vault: vaultA } = createEngine({ backend, deviceId: "A" });
    await engineA.initialize();

    const { engine: engineB, vault: vaultB } = createEngine({ backend, deviceId: "B" });

    vaultA.addFile("from-a.md", "aaa");
    await engineA.onFileCreate("from-a.md");

    vaultB.addFile("from-b.md", "bbb");
    await engineB.onFileCreate("from-b.md");

    await engineA.flush();
    await engineB.flush();

    expect(engineA.getState().lastSeq).toBe(1);
    expect(engineB.getState().lastSeq).toBe(2);
  });
});
