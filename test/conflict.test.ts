import { describe, it, expect } from "vitest";
import { MemoryBackend, MockVault, createEngine } from "./helpers";

describe("conflict detection (basedOnSeq)", () => {
  it("fast-forward: B pulls A's change then edits — A should get B's result", async () => {
    const backend = new MemoryBackend();

    const { engine: engineA, vault: vaultA } = createEngine({ backend, deviceId: "A" });
    vaultA.addFile("a.md", "v1");
    await engineA.onFileCreate("a.md");
    await engineA.flush(); // seq 1

    const { engine: engineB, vault: vaultB } = createEngine({ backend, deviceId: "B" });
    await engineB.pull(); // sees seq 1

    vaultA.modifyFile("a.md", "v2 from A");
    await engineA.onFileModify("a.md");
    await engineA.flush(); // seq 2

    // B explicitly pulls first, THEN edits — so B.lastSeq=2 before creating modify op
    await engineB.pull(); // B sees seq 2, lastSeq becomes 2
    vaultB.modifyFile("a.md", "v3 from B based on v2");
    await engineB.onFileModify("a.md"); // basedOnSeq=2
    await engineB.flush(); // seq 3

    await engineA.pull();

    // No conflict — B saw A's version before editing. A should get B's content.
    expect(new TextDecoder().decode(vaultA.readBinary("a.md")!)).toBe("v3 from B based on v2");
  });

  it("concurrent modify creates conflict file (LWW: higher ts wins)", async () => {
    const backend = new MemoryBackend();

    const { engine: engineA, vault: vaultA } = createEngine({ backend, deviceId: "A" });
    vaultA.addFile("shared.md", "original");
    await engineA.onFileCreate("shared.md");
    await engineA.flush(); // seq 1

    const { engine: engineB, vault: vaultB } = createEngine({ backend, deviceId: "B" });
    await engineB.pull(); // both at seq 1

    // Both devices modify without pulling from each other — concurrent ops
    vaultA.modifyFile("shared.md", "A's version");
    await engineA.onFileModify("shared.md");

    vaultB.modifyFile("shared.md", "B's version");
    await engineB.onFileModify("shared.md");

    // A flushes first → seq 2
    await engineA.flush();
    // B flushes → B had basedOnSeq=1, A's op is at seq 2 > B's basedOnSeq=1 → concurrent.
    // B pulls A's op during flush → conflict detected in B's vault.
    await engineB.flush();

    // B should have a conflict file (from when it pulled A's concurrent modify)
    const hasConflict = [...vaultB.files.keys()].some(k => k.includes(".conflict-"));
    expect(hasConflict).toBe(true);

    // Winner file still present in B's vault
    expect(vaultB.getFile("shared.md")).not.toBeNull();
  });

  it("concurrent delete vs modify — local modify wins, re-pushes as create", async () => {
    const backend = new MemoryBackend();

    const { engine: engineA, vault: vaultA } = createEngine({ backend, deviceId: "A" });
    vaultA.addFile("doc.md", "content");
    await engineA.onFileCreate("doc.md");
    await engineA.flush(); // seq 1

    const { engine: engineB, vault: vaultB } = createEngine({ backend, deviceId: "B" });
    await engineB.pull(); // both at seq 1

    // A deletes, B edits — concurrent
    vaultA.deleteFile("doc.md");
    engineA.onFileDelete("doc.md");
    await engineA.flush(); // seq 2

    vaultB.modifyFile("doc.md", "B's edit");
    await engineB.onFileModify("doc.md");
    await engineB.flush(); // seq 3 (sees seq 2 before flush, pulls A's delete, keeps local since modified)

    // After sync, B should retain its edit (local modify wins over remote delete)
    expect(vaultB.getFile("doc.md")).not.toBeNull();
    expect(new TextDecoder().decode(vaultB.readBinary("doc.md")!)).toBe("B's edit");
  });
});

describe("force reset", () => {
  it("wipes remote and pushes local state", async () => {
    const backend = new MemoryBackend();

    const { engine: engineA, vault: vaultA } = createEngine({ backend, deviceId: "A" });
    vaultA.addFile("a.md", "original");
    await engineA.onFileCreate("a.md");
    await engineA.flush();

    const { engine: engineB, vault: vaultB } = createEngine({ backend, deviceId: "B" });
    await engineB.pull();

    vaultA.modifyFile("a.md", "local version after reset");
    await engineA.onFileModify("a.md");
    await engineA.forceReset();

    await engineB.pull();
    expect(new TextDecoder().decode(vaultB.readBinary("a.md")!)).toBe("local version after reset");
  });
});

describe("force pull", () => {
  it("replaces local files with remote state", async () => {
    const backend = new MemoryBackend();

    const { engine: engineA, vault: vaultA } = createEngine({ backend, deviceId: "A" });
    vaultA.addFile("remote.md", "remote content");
    await engineA.onFileCreate("remote.md");
    await engineA.flush();

    const vaultB = new MockVault();
    vaultB.addFile("local-only.md", "should be gone after force pull");
    const { engine: engineB } = createEngine({ backend, vault: vaultB, deviceId: "B" });

    await engineB.forcePull();

    expect(vaultB.getFile("local-only.md")).toBeNull();
    expect(vaultB.getFile("remote.md")).not.toBeNull();
    expect(new TextDecoder().decode(vaultB.readBinary("remote.md")!)).toBe("remote content");
  });
});
