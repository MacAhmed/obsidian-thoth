import { describe, it, expect, beforeEach, vi } from "vitest";
import { SyncEngineV2 } from "../src/sync-engine";
import type { StorageBackend } from "../src/storage";
import type { Op, LocalState } from "../src/types";

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

interface MockFile {
  path: string;
  content: ArrayBuffer;
  mtime: number;
  size: number;
}

class MockVault {
  files = new Map<string, MockFile>();

  addFile(path: string, content: string): void {
    const encoded = new TextEncoder().encode(content);
    this.files.set(path, {
      path,
      content: encoded.buffer,
      mtime: Date.now(),
      size: encoded.byteLength,
    });
  }

  modifyFile(path: string, content: string): void {
    const encoded = new TextEncoder().encode(content);
    const existing = this.files.get(path);
    this.files.set(path, {
      path,
      content: encoded.buffer,
      mtime: Date.now(),
      size: encoded.byteLength,
    });
  }

  deleteFile(path: string): void {
    this.files.delete(path);
  }

  renameFile(oldPath: string, newPath: string): void {
    const file = this.files.get(oldPath);
    if (!file) return;
    this.files.delete(oldPath);
    this.files.set(newPath, { ...file, path: newPath });
  }

  getFile(path: string): MockFile | null {
    return this.files.get(path) ?? null;
  }

  getAllFiles(): MockFile[] {
    return [...this.files.values()];
  }

  readBinary(path: string): ArrayBuffer | null {
    return this.files.get(path)?.content ?? null;
  }
}

interface EngineConfig {
  backend: MemoryBackend;
  vault: MockVault;
  deviceId: string;
}

function createEngine(config?: Partial<EngineConfig>) {
  const backend = config?.backend ?? new MemoryBackend();
  const vault = config?.vault ?? new MockVault();
  const deviceId = config?.deviceId ?? "desktop";

  const engine = new SyncEngineV2({
    backend,
    vault: {
      getFiles: () => vault.getAllFiles().map(f => ({ path: f.path, stat: { mtime: f.mtime, size: f.size } })),
      readBinary: (path: string) => vault.readBinary(path),
      createBinary: (path: string, data: ArrayBuffer) => { vault.addFile(path, new TextDecoder().decode(data)); },
      modifyBinary: (path: string, data: ArrayBuffer) => { vault.modifyFile(path, new TextDecoder().decode(data)); },
      deletePath: (path: string) => { vault.deleteFile(path); },
      renamePath: (oldPath: string, newPath: string) => { vault.renameFile(oldPath, newPath); },
      exists: (path: string) => vault.files.has(path),
      ensureFolder: (_path: string) => {},
    },
    deviceId,
  });

  return { engine, backend, vault };
}

describe("SyncEngineV2", () => {
  describe("UUID assignment", () => {
    it("assigns a UUID to a new file on create", async () => {
      const { engine, vault } = createEngine();
      vault.addFile("notes/hello.md", "hello world");
      await engine.onFileCreate("notes/hello.md");
      const state = engine.getState();
      const entries = Object.entries(state.registry);
      expect(entries).toHaveLength(1);
      expect(entries[0][1].path).toBe("notes/hello.md");
    });

    it("assigns unique UUIDs to different files", async () => {
      const { engine, vault } = createEngine();
      vault.addFile("a.md", "aaa");
      vault.addFile("b.md", "bbb");
      await engine.onFileCreate("a.md");
      await engine.onFileCreate("b.md");
      const state = engine.getState();
      const ids = Object.keys(state.registry);
      expect(ids).toHaveLength(2);
      expect(ids[0]).not.toBe(ids[1]);
    });

    it("does not reassign UUID on modify", async () => {
      const { engine, vault } = createEngine();
      vault.addFile("a.md", "v1");
      await engine.onFileCreate("a.md");
      const state1 = engine.getState();
      const id = Object.keys(state1.registry)[0];

      vault.modifyFile("a.md", "v2");
      await engine.onFileModify("a.md");
      const state2 = engine.getState();
      expect(Object.keys(state2.registry)[0]).toBe(id);
    });
  });

  describe("op creation", () => {
    it("creates a create op for new file", async () => {
      const { engine, vault } = createEngine();
      vault.addFile("notes/test.md", "content");
      await engine.onFileCreate("notes/test.md");
      const state = engine.getState();
      expect(state.outbox).toHaveLength(1);
      expect(state.outbox[0].type).toBe("create");
      const op = state.outbox[0] as Op & { type: "create" };
      expect(op.path).toBe("notes/test.md");
      expect(op.device).toBe("desktop");
    });

    it("creates a modify op for changed file", async () => {
      const { engine, vault } = createEngine();
      vault.addFile("a.md", "v1");
      await engine.onFileCreate("a.md");

      vault.modifyFile("a.md", "v2");
      await engine.onFileModify("a.md");
      const state = engine.getState();
      expect(state.outbox).toHaveLength(2);
      expect(state.outbox[1].type).toBe("modify");
    });

    it("creates a delete op", async () => {
      const { engine, vault } = createEngine();
      vault.addFile("a.md", "content");
      await engine.onFileCreate("a.md");

      vault.deleteFile("a.md");
      engine.onFileDelete("a.md");
      const state = engine.getState();
      expect(state.outbox).toHaveLength(2);
      expect(state.outbox[1].type).toBe("delete");
    });

    it("creates a rename op with stable UUID", async () => {
      const { engine, vault } = createEngine();
      vault.addFile("old.md", "content");
      await engine.onFileCreate("old.md");
      const id = Object.keys(engine.getState().registry)[0];

      vault.renameFile("old.md", "new.md");
      engine.onFileRename("old.md", "new.md");
      const state = engine.getState();
      expect(state.outbox).toHaveLength(2);
      const renameOp = state.outbox[1];
      expect(renameOp.type).toBe("rename");
      expect(renameOp.fileId).toBe(id);
      expect((renameOp as any).oldPath).toBe("old.md");
      expect((renameOp as any).newPath).toBe("new.md");
      expect(state.registry[id].path).toBe("new.md");
    });

    it("sets basedOnSeq on mutating ops", async () => {
      const { engine, vault } = createEngine();
      vault.addFile("a.md", "v1");
      await engine.onFileCreate("a.md");

      vault.modifyFile("a.md", "v2");
      await engine.onFileModify("a.md");
      const state = engine.getState();
      const modOp = state.outbox[1] as Op & { type: "modify" };
      expect(modOp.basedOnSeq).toBe(0);
    });
  });

  describe("flush (push to remote)", () => {
    it("flushes outbox to remote as a new chunk + updates head", async () => {
      const { engine, vault, backend } = createEngine();
      vault.addFile("a.md", "hello");
      await engine.onFileCreate("a.md");

      await engine.flush();

      const headResult = await backend.getWithEtag("head.json");
      expect(headResult).not.toBeNull();
      const head = JSON.parse(new TextDecoder().decode(headResult!.data));
      expect(head.seq).toBe(1);

      const chunkKeys = await backend.list("ops/");
      expect(chunkKeys).toHaveLength(1);

      const state = engine.getState();
      expect(state.outbox).toHaveLength(0);
      expect(state.lastSeq).toBe(1);
    });

    it("uploads blob on create", async () => {
      const { engine, vault, backend } = createEngine();
      vault.addFile("a.md", "hello");
      await engine.onFileCreate("a.md");
      await engine.flush();

      const blobs = await backend.list("blobs/");
      expect(blobs).toHaveLength(1);
    });

    it("skips blob upload if hash already exists", async () => {
      const { engine, vault, backend } = createEngine();
      vault.addFile("a.md", "same content");
      await engine.onFileCreate("a.md");
      await engine.flush();

      vault.addFile("b.md", "same content");
      await engine.onFileCreate("b.md");

      const putSpy = vi.spyOn(backend, "put");
      await engine.flush();

      const blobPuts = putSpy.mock.calls.filter(([key]) => (key as string).startsWith("blobs/"));
      expect(blobPuts).toHaveLength(0);
    });

    it("assigns sequential seq numbers across flushes", async () => {
      const { engine, vault } = createEngine();
      vault.addFile("a.md", "a");
      await engine.onFileCreate("a.md");
      await engine.flush();

      vault.addFile("b.md", "b");
      await engine.onFileCreate("b.md");
      await engine.flush();

      expect(engine.getState().lastSeq).toBe(2);
    });

    it("handles empty outbox gracefully", async () => {
      const { engine } = createEngine();
      await engine.flush();
      expect(engine.getState().lastSeq).toBe(0);
    });
  });

  describe("pull (remote → local)", () => {
    it("pulls create ops and creates local files", async () => {
      const backend = new MemoryBackend();

      const { engine: engineA, vault: vaultA } = createEngine({ backend, deviceId: "A" });
      vaultA.addFile("notes/from-a.md", "from device A");
      await engineA.onFileCreate("notes/from-a.md");
      await engineA.flush();

      const { engine: engineB, vault: vaultB } = createEngine({ backend, deviceId: "B" });
      await engineB.pull();

      expect(vaultB.getFile("notes/from-a.md")).not.toBeNull();
      const content = new TextDecoder().decode(vaultB.readBinary("notes/from-a.md")!);
      expect(content).toBe("from device A");
    });

    it("pulls modify ops and updates local files", async () => {
      const backend = new MemoryBackend();

      const { engine: engineA, vault: vaultA } = createEngine({ backend, deviceId: "A" });
      vaultA.addFile("a.md", "v1");
      await engineA.onFileCreate("a.md");
      await engineA.flush();

      const { engine: engineB, vault: vaultB } = createEngine({ backend, deviceId: "B" });
      await engineB.pull();

      vaultA.modifyFile("a.md", "v2");
      await engineA.onFileModify("a.md");
      await engineA.flush();

      await engineB.pull();
      const content = new TextDecoder().decode(vaultB.readBinary("a.md")!);
      expect(content).toBe("v2");
    });

    it("pulls delete ops and removes local files", async () => {
      const backend = new MemoryBackend();

      const { engine: engineA, vault: vaultA } = createEngine({ backend, deviceId: "A" });
      vaultA.addFile("a.md", "content");
      await engineA.onFileCreate("a.md");
      await engineA.flush();

      const { engine: engineB, vault: vaultB } = createEngine({ backend, deviceId: "B" });
      await engineB.pull();
      expect(vaultB.getFile("a.md")).not.toBeNull();

      vaultA.deleteFile("a.md");
      engineA.onFileDelete("a.md");
      await engineA.flush();

      await engineB.pull();
      expect(vaultB.getFile("a.md")).toBeNull();
    });

    it("pulls rename ops and renames local files", async () => {
      const backend = new MemoryBackend();

      const { engine: engineA, vault: vaultA } = createEngine({ backend, deviceId: "A" });
      vaultA.addFile("old.md", "content");
      await engineA.onFileCreate("old.md");
      await engineA.flush();

      const { engine: engineB, vault: vaultB } = createEngine({ backend, deviceId: "B" });
      await engineB.pull();
      expect(vaultB.getFile("old.md")).not.toBeNull();

      vaultA.renameFile("old.md", "new.md");
      engineA.onFileRename("old.md", "new.md");
      await engineA.flush();

      await engineB.pull();
      expect(vaultB.getFile("old.md")).toBeNull();
      expect(vaultB.getFile("new.md")).not.toBeNull();
    });

    it("does not re-pull ops already seen", async () => {
      const backend = new MemoryBackend();

      const { engine: engineA, vault: vaultA } = createEngine({ backend, deviceId: "A" });
      vaultA.addFile("a.md", "content");
      await engineA.onFileCreate("a.md");
      await engineA.flush();

      const { engine: engineB, vault: vaultB } = createEngine({ backend, deviceId: "B" });
      await engineB.pull();

      const createSpy = vi.fn();
      const origCreate = vaultB.addFile.bind(vaultB);
      vaultB.addFile = (...args: [string, string]) => { createSpy(); origCreate(...args); };

      await engineB.pull();
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  describe("cold start case 1: empty remote, empty vault", () => {
    it("initializes head.json at seq 0", async () => {
      const backend = new MemoryBackend();
      const { engine } = createEngine({ backend });
      await engine.initialize();

      const headResult = await backend.getWithEtag("head.json");
      expect(headResult).not.toBeNull();
      const head = JSON.parse(new TextDecoder().decode(headResult!.data));
      expect(head.seq).toBe(0);
      expect(head.version).toBe(2);
    });
  });

  describe("cold start case 2: empty remote, existing vault", () => {
    it("writes checkpoint with all files, uploads blobs", async () => {
      const backend = new MemoryBackend();
      const vault = new MockVault();
      vault.addFile("a.md", "aaa");
      vault.addFile("b.md", "bbb");
      vault.addFile("sub/c.md", "ccc");

      const { engine } = createEngine({ backend, vault });
      await engine.initialize();

      const cpData = await backend.get("checkpoint.json");
      expect(cpData).not.toBeNull();
      const cp = JSON.parse(new TextDecoder().decode(cpData!));
      expect(Object.keys(cp.files)).toHaveLength(3);

      const blobs = await backend.list("blobs/");
      expect(blobs).toHaveLength(3);

      const headData = await backend.getWithEtag("head.json");
      const head = JSON.parse(new TextDecoder().decode(headData!.data));
      expect(head.seq).toBe(0);
    });
  });

  describe("cold start case 3: existing remote, empty vault", () => {
    it("pulls all files from checkpoint", async () => {
      const backend = new MemoryBackend();
      const vaultA = new MockVault();
      vaultA.addFile("x.md", "xxx");
      vaultA.addFile("y.md", "yyy");

      const { engine: engineA } = createEngine({ backend, vault: vaultA, deviceId: "A" });
      await engineA.initialize();

      const vaultB = new MockVault();
      const { engine: engineB } = createEngine({ backend, vault: vaultB, deviceId: "B" });
      await engineB.initialize();

      expect(vaultB.getFile("x.md")).not.toBeNull();
      expect(vaultB.getFile("y.md")).not.toBeNull();
      expect(new TextDecoder().decode(vaultB.readBinary("x.md")!)).toBe("xxx");
    });
  });
});
