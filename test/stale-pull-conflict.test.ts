/**
 * Regression test for the stale-pull false conflict:
 *
 * Device B downloads a file from the checkpoint. Device A then edits that
 * file and pushes updates. B's state is never saved (old bug). On restart,
 * B has the checkpoint version of the file on disk. Reconcile sees same path,
 * different hash — but this is NOT a real conflict, it's a stale pull.
 * B should silently overwrite with the current remote, not fork.
 */
import { describe, it, expect } from "vitest";
import { MemoryBackend, MockVault, createEngine } from "./helpers";
import { SyncEngineV2 } from "../src/sync-engine";
import type { VaultAdapter } from "../src/sync-engine";

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

describe("stale-pull false conflict", () => {
  it("does not fork when local has checkpoint version and remote has newer version", async () => {
    const backend = new MemoryBackend();

    // A initializes with a daily note
    const vaultA = new MockVault();
    vaultA.addFile("02_Tracker/Daily/2026_06_30.md", "morning notes");
    const { engine: engineA } = createEngine({ backend, vault: vaultA, deviceId: "A" });
    await engineA.initialize(); // writes checkpoint with "morning notes"

    // B does a partial pull — gets the checkpoint version, but state save fails (lastSeq stays 0)
    const vaultB = new MockVault();
    vaultB.addFile("02_Tracker/Daily/2026_06_30.md", "morning notes"); // simulates what B downloaded
    // Note: B has NO registry — state was never saved

    // A keeps editing throughout the day and pushes updates
    vaultA.modifyFile("02_Tracker/Daily/2026_06_30.md", "morning notes\nafternoon notes\nevening notes");
    await engineA.onFileModify("02_Tracker/Daily/2026_06_30.md");
    await engineA.flush();

    // B restarts with no saved state — has checkpoint version on disk, remote is now newer
    const engineB = new SyncEngineV2({
      backend,
      vault: vaultAdapter(vaultB),
      deviceId: "B",
      onProgress: async () => {},
    });
    await engineB.initialize();

    // B should have the current remote version — no conflict file
    const files = [...vaultB.files.keys()];
    const conflictFiles = files.filter(f => f.includes(".conflict-"));
    expect(conflictFiles).toHaveLength(0);

    // B has the updated content
    const content = new TextDecoder().decode(vaultB.readBinary("02_Tracker/Daily/2026_06_30.md")!);
    expect(content).toBe("morning notes\nafternoon notes\nevening notes");

    // No spurious push ops
    expect(engineB.getState().outbox).toHaveLength(0);

    // UUID matches A's
    const aId = Object.keys(engineA.getState().registry)[0];
    const bId = Object.keys(engineB.getState().registry)[0];
    expect(bId).toBe(aId);
  });

  it("DOES fork when B genuinely edited the file independently", async () => {
    const backend = new MemoryBackend();

    const vaultA = new MockVault();
    vaultA.addFile("doc.md", "original");
    const { engine: engineA } = createEngine({ backend, vault: vaultA, deviceId: "A" });
    await engineA.initialize();

    // A updates the file
    vaultA.modifyFile("doc.md", "A's version");
    await engineA.onFileModify("doc.md");
    await engineA.flush();

    // B has a genuinely different version — not the checkpoint, not A's version
    const vaultB = new MockVault();
    vaultB.addFile("doc.md", "B's independent edit");
    const engineB = new SyncEngineV2({
      backend,
      vault: vaultAdapter(vaultB),
      deviceId: "B",
      onProgress: async () => {},
    });
    await engineB.initialize();

    // This IS a real conflict — should fork
    const files = [...vaultB.files.keys()];
    const conflictFiles = files.filter(f => f.includes(".conflict-"));
    expect(conflictFiles).toHaveLength(1);
    expect(vaultB.getFile("doc.md")).not.toBeNull();
  });

  it("no false conflict across multiple edits — B always gets latest", async () => {
    const backend = new MemoryBackend();

    const vaultA = new MockVault();
    vaultA.addFile("note.md", "v1");
    const { engine: engineA } = createEngine({ backend, vault: vaultA, deviceId: "A" });
    await engineA.initialize(); // checkpoint = "v1"

    // A edits 3 times
    for (const version of ["v2", "v3", "v4"]) {
      vaultA.modifyFile("note.md", version);
      await engineA.onFileModify("note.md");
      await engineA.flush();
    }

    // B has v1 (checkpoint) on disk, no registry
    const vaultB = new MockVault();
    vaultB.addFile("note.md", "v1");
    const engineB = new SyncEngineV2({
      backend,
      vault: vaultAdapter(vaultB),
      deviceId: "B",
      onProgress: async () => {},
    });
    await engineB.initialize();

    const files = [...vaultB.files.keys()];
    expect(files.filter(f => f.includes(".conflict-"))).toHaveLength(0);
    expect(new TextDecoder().decode(vaultB.readBinary("note.md")!)).toBe("v4");
  });
});
