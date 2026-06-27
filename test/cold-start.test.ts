import { describe, it, expect } from "vitest";
import { MemoryBackend, MockVault, createEngine } from "./helpers";

describe("cold start case 4: new device with existing vault, no registry", () => {
  it("pass 1: matches by hash AND path — adopts remote UUIDs, zero deletions", async () => {
    const backend = new MemoryBackend();

    // Device A initializes remote
    const vaultA = new MockVault();
    vaultA.addFile("a.md", "aaa");
    vaultA.addFile("b.md", "bbb");
    vaultA.addFile("c.md", "ccc");
    const { engine: engineA } = createEngine({ backend, vault: vaultA, deviceId: "A" });
    await engineA.initialize();

    // Device B has same files at same paths (e.g. copy from git) — no registry
    const vaultB = new MockVault();
    vaultB.addFile("a.md", "aaa");
    vaultB.addFile("b.md", "bbb");
    vaultB.addFile("c.md", "ccc");
    const { engine: engineB } = createEngine({ backend, vault: vaultB, deviceId: "B" });
    await engineB.initialize();

    // All files matched by hash+path — UUIDs adopted from remote, nothing deleted
    const stateB = engineB.getState();
    const stateA = engineA.getState();

    expect(Object.keys(stateB.registry)).toHaveLength(3);

    // UUIDs should match A's
    const aIds = Object.keys(stateA.registry).sort();
    const bIds = Object.keys(stateB.registry).sort();
    expect(bIds).toEqual(aIds);

    // No files deleted from vault B
    expect(vaultB.getFile("a.md")).not.toBeNull();
    expect(vaultB.getFile("b.md")).not.toBeNull();
    expect(vaultB.getFile("c.md")).not.toBeNull();

    // No spurious push ops queued
    expect(stateB.outbox).toHaveLength(0);
  });

  it("pass 2: matches by hash only — adopts UUID, renames local file to remote path", async () => {
    const backend = new MemoryBackend();

    const vaultA = new MockVault();
    vaultA.addFile("docs/original.md", "unique content");
    const { engine: engineA } = createEngine({ backend, vault: vaultA, deviceId: "A" });
    await engineA.initialize();

    // B has same content but at a different path
    const vaultB = new MockVault();
    vaultB.addFile("docs/renamed.md", "unique content");
    const { engine: engineB } = createEngine({ backend, vault: vaultB, deviceId: "B" });
    await engineB.initialize();

    const stateB = engineB.getState();
    const stateA = engineA.getState();

    // UUID adopted from A
    const aId = Object.keys(stateA.registry)[0];
    const bId = Object.keys(stateB.registry)[0];
    expect(bId).toBe(aId);

    // Local file renamed to match remote canonical path
    expect(vaultB.getFile("docs/original.md")).not.toBeNull();
    expect(vaultB.getFile("docs/renamed.md")).toBeNull();

    // No deletions, no spurious creates
    expect(stateB.outbox).toHaveLength(0);
  });

  it("local-only files pushed as new creates", async () => {
    const backend = new MemoryBackend();

    const vaultA = new MockVault();
    vaultA.addFile("shared.md", "shared");
    const { engine: engineA } = createEngine({ backend, vault: vaultA, deviceId: "A" });
    await engineA.initialize();

    // B has the shared file + 2 local-only files
    const vaultB = new MockVault();
    vaultB.addFile("shared.md", "shared");
    vaultB.addFile("local1.md", "only on B");
    vaultB.addFile("local2.md", "also only on B");
    const { engine: engineB } = createEngine({ backend, vault: vaultB, deviceId: "B" });
    await engineB.initialize();

    const stateB = engineB.getState();
    // 3 files in registry (1 adopted + 2 new)
    expect(Object.keys(stateB.registry)).toHaveLength(3);

    // local-only files are queued as create ops
    const createOps = stateB.outbox.filter(op => op.type === "create");
    const createdPaths = createOps.map(op => (op as any).path).sort();
    expect(createdPaths).toEqual(["local1.md", "local2.md"]);

    // After flush, remote has all 3 files
    await engineB.flush();
    const { engine: engineC, vault: vaultC } = createEngine({ backend, vault: new MockVault(), deviceId: "C" });
    await engineC.initialize();
    expect(vaultC.getFile("shared.md")).not.toBeNull();
    expect(vaultC.getFile("local1.md")).not.toBeNull();
    expect(vaultC.getFile("local2.md")).not.toBeNull();
  });

  it("remote-only files pulled down", async () => {
    const backend = new MemoryBackend();

    const vaultA = new MockVault();
    vaultA.addFile("remote1.md", "r1");
    vaultA.addFile("remote2.md", "r2");
    vaultA.addFile("shared.md", "shared");
    const { engine: engineA } = createEngine({ backend, vault: vaultA, deviceId: "A" });
    await engineA.initialize();

    // B only has the shared file
    const vaultB = new MockVault();
    vaultB.addFile("shared.md", "shared");
    const { engine: engineB } = createEngine({ backend, vault: vaultB, deviceId: "B" });
    await engineB.initialize();

    // remote-only files pulled into B
    expect(vaultB.getFile("remote1.md")).not.toBeNull();
    expect(vaultB.getFile("remote2.md")).not.toBeNull();
    expect(new TextDecoder().decode(vaultB.readBinary("remote1.md")!)).toBe("r1");

    // Nothing deleted
    expect(vaultB.getFile("shared.md")).not.toBeNull();

    // No pending creates (shared matched, remote-only pulled, nothing local-only)
    expect(engineB.getState().outbox).toHaveLength(0);
  });

  it("same path but different content — conflict fork, both versions preserved", async () => {
    const backend = new MemoryBackend();

    const vaultA = new MockVault();
    vaultA.addFile("doc.md", "remote version");
    const { engine: engineA } = createEngine({ backend, vault: vaultA, deviceId: "A" });
    await engineA.initialize();

    // B has same path but different content
    const vaultB = new MockVault();
    vaultB.addFile("doc.md", "local version");
    const { engine: engineB } = createEngine({ backend, vault: vaultB, deviceId: "B" });
    await engineB.initialize();

    // Both versions preserved — original + conflict file
    const keys = [...vaultB.files.keys()];
    const hasConflict = keys.some(k => k.includes(".conflict-"));
    expect(hasConflict).toBe(true);
    expect(vaultB.getFile("doc.md")).not.toBeNull();

    // B's local version gets a new UUID and is pushed; the remote UUID is not tracked
    // (its content lives in the conflict file, not in a registry-managed path)
    const stateB = engineB.getState();
    expect(Object.keys(stateB.registry)).toHaveLength(1);
  });

  it("no data loss across all cases mixed together", async () => {
    const backend = new MemoryBackend();

    const vaultA = new MockVault();
    vaultA.addFile("match-exact.md", "exact");       // will match by hash+path
    vaultA.addFile("match-hash.md", "hash-only");     // B has this at different path
    vaultA.addFile("remote-only.md", "remote");       // B doesn't have it
    const { engine: engineA } = createEngine({ backend, vault: vaultA, deviceId: "A" });
    await engineA.initialize();

    const vaultB = new MockVault();
    vaultB.addFile("match-exact.md", "exact");        // exact match
    vaultB.addFile("renamed.md", "hash-only");        // hash match (should rename to match-hash.md)
    vaultB.addFile("local-only.md", "local");         // local only

    const { engine: engineB } = createEngine({ backend, vault: vaultB, deviceId: "B" });
    await engineB.initialize();

    // Zero deletions
    expect(vaultB.getFile("match-exact.md")).not.toBeNull();
    expect(vaultB.getFile("match-hash.md")).not.toBeNull();  // renamed from renamed.md
    expect(vaultB.getFile("renamed.md")).toBeNull();          // old name gone
    expect(vaultB.getFile("remote-only.md")).not.toBeNull(); // pulled
    expect(vaultB.getFile("local-only.md")).not.toBeNull();  // kept, queued as create

    const stateB = engineB.getState();
    expect(Object.keys(stateB.registry)).toHaveLength(4);
    const creates = stateB.outbox.filter(op => op.type === "create");
    expect(creates).toHaveLength(1);
    expect((creates[0] as any).path).toBe("local-only.md");
  });
});

describe("cold start case 5: registry lost, files still present", () => {
  it("rebuilds registry from hash matching — resumes normal operation", async () => {
    const backend = new MemoryBackend();

    // A and B in sync
    const vaultA = new MockVault();
    vaultA.addFile("a.md", "aaa");
    vaultA.addFile("b.md", "bbb");
    const { engine: engineA } = createEngine({ backend, vault: vaultA, deviceId: "A" });
    await engineA.initialize();

    const { engine: engineB, vault: vaultB } = createEngine({ backend, vault: new MockVault(), deviceId: "B" });
    await engineB.initialize();

    const originalBIds = Object.keys(engineB.getState().registry).sort();

    // B "loses" its registry (simulated by creating a fresh engine with same vault)
    const { engine: engineB2 } = createEngine({ backend, vault: vaultB, deviceId: "B" });
    await engineB2.initialize();

    const rebuiltIds = Object.keys(engineB2.getState().registry).sort();
    expect(rebuiltIds).toEqual(originalBIds);
    expect(engineB2.getState().outbox).toHaveLength(0);
  });

  it("case 5 with local edits: modified files become conflicts", async () => {
    const backend = new MemoryBackend();

    const vaultShared = new MockVault();
    vaultShared.addFile("notes.md", "original");
    vaultShared.addFile("clean.md", "unchanged");
    const { engine: engineA } = createEngine({ backend, vault: vaultShared, deviceId: "A" });
    await engineA.initialize();

    const { engine: engineB, vault: vaultB } = createEngine({ backend, vault: new MockVault(), deviceId: "B" });
    await engineB.initialize();

    // B edits notes.md, then loses its registry
    vaultB.modifyFile("notes.md", "edited locally");

    const { engine: engineB2 } = createEngine({ backend, vault: vaultB, deviceId: "B" });
    await engineB2.initialize();

    // notes.md was modified — doesn't hash-match remote → conflict
    const keys = [...vaultB.files.keys()];
    const hasConflict = keys.some(k => k.includes(".conflict-"));
    expect(hasConflict).toBe(true);
    expect(vaultB.getFile("notes.md")).not.toBeNull();

    // clean.md matched perfectly — no conflict
    expect(vaultB.getFile("clean.md")).not.toBeNull();
  });
});

describe("cold start idempotency", () => {
  it("running reconciliation twice produces no new ops", async () => {
    const backend = new MemoryBackend();

    const vaultA = new MockVault();
    vaultA.addFile("a.md", "aaa");
    vaultA.addFile("b.md", "bbb");
    const { engine: engineA } = createEngine({ backend, vault: vaultA, deviceId: "A" });
    await engineA.initialize();

    const vaultB = new MockVault();
    vaultB.addFile("a.md", "aaa");
    vaultB.addFile("b.md", "bbb");
    vaultB.addFile("local.md", "local only");

    // First reconciliation
    const { engine: engineB1 } = createEngine({ backend, vault: vaultB, deviceId: "B" });
    await engineB1.initialize();
    await engineB1.flush();

    // Second reconciliation (simulate losing state again)
    const { engine: engineB2 } = createEngine({ backend, vault: vaultB, deviceId: "B" });
    await engineB2.initialize();

    // No new ops — everything already in sync
    expect(engineB2.getState().outbox).toHaveLength(0);
  });
});
