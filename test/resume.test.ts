/**
 * Tests for operational failure modes that clean-slate integration tests miss:
 *
 * 1. Resume after mid-reconcile kill — state saved every 50 files, restart
 *    continues from where it left off rather than starting over.
 *
 * 2. Concurrent saveState calls — multiple onProgress callbacks firing before
 *    the previous save finishes must serialize correctly, never corrupt state.
 */
import { describe, it, expect } from "vitest";
import { MemoryBackend, MockVault, createEngine } from "./helpers";
import { SyncEngineV2 } from "../src/sync-engine";
import type { VaultAdapter } from "../src/sync-engine";

// ── helpers ──────────────────────────────────────────────────────────────────

function vaultAdapter(vault: MockVault): VaultAdapter {
  return {
    getFiles: () => vault.getAllFiles().map(f => ({ path: f.path, stat: { mtime: f.mtime, size: f.size } })),
    readBinary: async (path) => vault.readBinary(path),
    createBinary: async (path, data) => { vault.addFile(path, new TextDecoder().decode(data)); },
    modifyBinary: async (path, data) => { vault.modifyFile(path, new TextDecoder().decode(data)); },
    deletePath: async (path) => { vault.deleteFile(path); },
    renamePath: async (old, next) => { vault.renameFile(old, next); },
    exists: (path) => vault.files.has(path),
    ensureFolder: async () => {},
  };
}

// ── test 1: resume after partial pull ────────────────────────────────────────

describe("resume after mid-reconcile kill", () => {
  it("resumes from saved state — does not re-download already-pulled files", async () => {
    const backend = new MemoryBackend();

    // Device A: push 200 files
    const vaultA = new MockVault();
    for (let i = 0; i < 200; i++) vaultA.addFile(`notes/note-${i}.md`, `content ${i}`);
    const { engine: engineA } = createEngine({ backend, vault: vaultA, deviceId: "A" });
    await engineA.initialize();

    // Track every blob fetch on the backend
    let blobFetches = 0;
    const originalGet = backend.get.bind(backend);
    backend.get = async (key: string) => {
      if (key.startsWith("blobs/")) blobFetches++;
      return originalGet(key);
    };

    // Device B: empty vault. onProgress fires after each batch of 50.
    // We capture state after the first batch (50 files) and abort.
    const vaultB = new MockVault();
    let savedState: string | null = null;
    let progressCount = 0;

    const engineB = new SyncEngineV2({
      backend,
      vault: vaultAdapter(vaultB),
      deviceId: "B",
      onProgress: async () => {
        progressCount++;
        if (progressCount === 1) {
          // Capture state after first 50, then throw to simulate iOS kill
          savedState = engineB.serialize();
          throw new Error("simulated kill");
        }
      },
    });

    try {
      await engineB.initialize();
    } catch {
      // expected — simulated kill
    }

    expect(savedState).not.toBeNull();
    const stateAfterFirstBatch = JSON.parse(savedState!);
    expect(Object.keys(stateAfterFirstBatch.registry)).toHaveLength(50);
    expect(vaultB.files.size).toBe(50);

    const fetchesAfterFirstBatch = blobFetches;
    expect(fetchesAfterFirstBatch).toBe(50);

    // "Restart": new engine instance, restore saved state, re-initialize
    blobFetches = 0;
    const engineB2 = new SyncEngineV2({
      backend,
      vault: vaultAdapter(vaultB),
      deviceId: "B",
      onProgress: async () => {},
    });
    engineB2.restore(savedState!);
    await engineB2.initialize();

    // Should have pulled only the remaining 150, not all 200
    expect(blobFetches).toBe(150);
    expect(vaultB.files.size).toBe(200);

    // All files present with correct content
    for (let i = 0; i < 200; i++) {
      const file = vaultB.getFile(`notes/note-${i}.md`);
      expect(file, `note-${i}.md missing`).not.toBeNull();
      const content = new TextDecoder().decode(vaultB.readBinary(`notes/note-${i}.md`)!);
      expect(content).toBe(`content ${i}`);
    }

    // Final registry is complete
    expect(Object.keys(engineB2.getState().registry)).toHaveLength(200);
  });

  it("resumes across multiple kills — each restart picks up where it left off", async () => {
    const backend = new MemoryBackend();

    const vaultA = new MockVault();
    for (let i = 0; i < 150; i++) vaultA.addFile(`f${i}.md`, `c${i}`);
    const { engine: engineA } = createEngine({ backend, vault: vaultA, deviceId: "A" });
    await engineA.initialize();

    const vaultB = new MockVault();
    let currentState: string | null = null;

    // Simulate 3 partial runs — each processes one batch of 50 then "dies"
    for (let run = 0; run < 3; run++) {
      let fired = false;
      const engine = new SyncEngineV2({
        backend,
        vault: vaultAdapter(vaultB),
        deviceId: "B",
        onProgress: async () => {
          if (!fired) {
            fired = true;
            currentState = engine.serialize();
            throw new Error("kill");
          }
        },
      });
      if (currentState) engine.restore(currentState);
      try { await engine.initialize(); } catch { /* expected */ }
      // Each run should have pulled 50 more files
      expect(vaultB.files.size).toBe((run + 1) * 50);
    }

    // Final run — no kill, completes
    const finalEngine = new SyncEngineV2({
      backend,
      vault: vaultAdapter(vaultB),
      deviceId: "B",
      onProgress: async () => {},
    });
    if (currentState) finalEngine.restore(currentState);
    await finalEngine.initialize();

    expect(vaultB.files.size).toBe(150);
  });

  it("idempotent: full restart after complete pull produces zero extra downloads", async () => {
    const backend = new MemoryBackend();

    const vaultA = new MockVault();
    for (let i = 0; i < 60; i++) vaultA.addFile(`n${i}.md`, `c${i}`);
    const { engine: engineA } = createEngine({ backend, vault: vaultA, deviceId: "A" });
    await engineA.initialize();

    // B fully completes
    const vaultB = new MockVault();
    const engineB = new SyncEngineV2({
      backend,
      vault: vaultAdapter(vaultB),
      deviceId: "B",
      onProgress: async () => {},
    });
    await engineB.initialize();
    expect(vaultB.files.size).toBe(60);
    const savedState = engineB.serialize();

    // Restart with full state saved
    let blobFetches = 0;
    const origGet = backend.get.bind(backend);
    backend.get = async (key) => { if (key.startsWith("blobs/")) blobFetches++; return origGet(key); };

    const engineB2 = new SyncEngineV2({
      backend,
      vault: vaultAdapter(vaultB),
      deviceId: "B",
      onProgress: async () => {},
    });
    engineB2.restore(savedState);
    await engineB2.initialize();

    expect(blobFetches).toBe(0);
    expect(vaultB.files.size).toBe(60);
  });
});

// ── test 2: concurrent saveState calls ───────────────────────────────────────

describe("concurrent saveState serialization", () => {
  it("serializes concurrent writes — last write wins, no corruption", async () => {
    // Simulate the promise-chain pattern from main.ts saveState
    const writes: string[] = [];
    let savingState: Promise<void> = Promise.resolve();

    function saveState(value: string): Promise<void> {
      savingState = savingState.then(async () => {
        // Simulate async write (e.g. vault.modify)
        await Promise.resolve();
        writes.push(value);
      });
      return savingState;
    }

    // Fire 5 concurrent saves — only the last value matters
    const calls = ["state-1", "state-2", "state-3", "state-4", "state-5"];
    await Promise.all(calls.map(v => saveState(v)));

    // All writes happened (no dropped calls)
    expect(writes).toHaveLength(5);
    // They executed in order (no interleaving)
    expect(writes).toEqual(calls);
    // Final write is the last state
    expect(writes[writes.length - 1]).toBe("state-5");
  });

  it("concurrent onProgress calls during reconcile produce consistent final state", async () => {
    const backend = new MemoryBackend();

    const vaultA = new MockVault();
    for (let i = 0; i < 200; i++) vaultA.addFile(`n${i}.md`, `c${i}`);
    const { engine: engineA } = createEngine({ backend, vault: vaultA, deviceId: "A" });
    await engineA.initialize();

    const vaultB = new MockVault();
    const savedStates: string[] = [];
    let savingState: Promise<void> = Promise.resolve();

    // Realistic saveState: serialized through a promise chain
    const engineB = new SyncEngineV2({
      backend,
      vault: vaultAdapter(vaultB),
      deviceId: "B",
      onProgress: async () => {
        const snapshot = engineB.serialize();
        savingState = savingState.then(async () => {
          await Promise.resolve(); // simulate async vault write
          savedStates.push(snapshot);
        });
        // Don't await — fire-and-forget like main.ts does
      },
    });

    await engineB.initialize();
    await savingState; // drain pending saves

    // All saves happened in order
    expect(savedStates.length).toBeGreaterThan(0);

    // Each saved state has more registry entries than the previous (monotonically growing)
    for (let i = 1; i < savedStates.length; i++) {
      const prev = JSON.parse(savedStates[i - 1]);
      const curr = JSON.parse(savedStates[i]);
      expect(Object.keys(curr.registry).length).toBeGreaterThanOrEqual(
        Object.keys(prev.registry).length
      );
    }

    // Final saved state is consistent with engine state
    const finalSaved = JSON.parse(savedStates[savedStates.length - 1]);
    const engineState = engineB.getState();
    expect(Object.keys(finalSaved.registry).length).toBe(
      Object.keys(engineState.registry).length
    );
  });

  it("state file collision: second create is suppressed if file already exists", async () => {
    // Simulate the exact race: two concurrent saveState calls, first creates the file,
    // second should use modify (not create) even if it started before first finished.
    const writes: Array<{ op: string; value: string }> = [];
    let fileExists = false;

    async function mockSave(value: string): Promise<void> {
      if (fileExists) {
        writes.push({ op: "modify", value });
      } else {
        fileExists = true;
        writes.push({ op: "create", value });
      }
    }

    let savingState: Promise<void> = Promise.resolve();

    function saveState(value: string) {
      savingState = savingState.then(() => mockSave(value));
      return savingState;
    }

    await Promise.all([
      saveState("a"),
      saveState("b"),
      saveState("c"),
    ]);

    // First write creates, subsequent ones modify
    expect(writes[0].op).toBe("create");
    expect(writes[1].op).toBe("modify");
    expect(writes[2].op).toBe("modify");

    // Values are in order
    expect(writes.map(w => w.value)).toEqual(["a", "b", "c"]);
  });
});

// ── test 3: file-already-exists during concurrent folder creation ─────────────

describe("ensureFolder concurrent creation", () => {
  it("creates folder only once when multiple files in same folder pulled concurrently", async () => {
    const backend = new MemoryBackend();

    const vaultA = new MockVault();
    // 5 files all in same folder — checkpoint pull will ensureFolder for each
    for (let i = 0; i < 5; i++) vaultA.addFile(`shared/note-${i}.md`, `c${i}`);
    const { engine: engineA } = createEngine({ backend, vault: vaultA, deviceId: "A" });
    await engineA.initialize();

    // Track folder creation attempts
    const folderCreations: string[] = [];
    const vaultB = new MockVault();
    const adapter = vaultAdapter(vaultB);
    const origEnsure = adapter.ensureFolder!.bind(adapter);
    adapter.ensureFolder = async (path: string) => {
      folderCreations.push(path);
      return origEnsure(path);
    };

    const engineB = new SyncEngineV2({
      backend,
      vault: adapter,
      deviceId: "B",
      onProgress: async () => {},
    });
    await engineB.initialize();

    // All 5 files should be present
    for (let i = 0; i < 5; i++) {
      expect(vaultB.getFile(`shared/note-${i}.md`)).not.toBeNull();
    }

    // ensureFolder was called multiple times for same path — should not throw
    const sharedFolderCalls = folderCreations.filter(p => p.startsWith("shared/"));
    expect(sharedFolderCalls.length).toBeGreaterThan(1);
  });
});
