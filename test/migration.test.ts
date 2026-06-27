import { describe, it, expect } from "vitest";
import { MemoryBackend, MockVault, createEngine } from "./helpers";
import type { Manifest } from "../src/storage";

function writeV1Manifest(backend: MemoryBackend, manifest: Manifest): void {
  const data = new TextEncoder().encode(JSON.stringify(manifest)).buffer;
  backend.put("_thoth/manifest.json", data);
}

describe("V1 migration", () => {
  it("detects V1 state and migrates to V2", async () => {
    const backend = new MemoryBackend();

    const v1Manifest: Manifest = {
      version: 1,
      deviceId: "old-device",
      updatedAt: Date.now(),
      files: {
        "notes/a.md": { hash: "aaa", mtime: 1000, size: 100 },
        "notes/b.md": { hash: "bbb", mtime: 2000, size: 200 },
      },
    };
    await writeV1Manifest(backend, v1Manifest);

    const blobA = new TextEncoder().encode("content A").buffer;
    const blobB = new TextEncoder().encode("content B").buffer;
    await backend.put("files/notes/a.md", blobA);
    await backend.put("files/notes/b.md", blobB);

    const vault = new MockVault();
    vault.addFile("notes/a.md", "content A");
    vault.addFile("notes/b.md", "content B");

    const { engine } = createEngine({ backend, vault, deviceId: "migrated" });
    await engine.initialize();

    const headResult = await backend.getWithEtag("head.json");
    expect(headResult).not.toBeNull();
    const head = JSON.parse(new TextDecoder().decode(headResult!.data));
    expect(head.version).toBe(2);
    expect(head.seq).toBe(0);

    const cpData = await backend.get("checkpoint.json");
    expect(cpData).not.toBeNull();
    const cp = JSON.parse(new TextDecoder().decode(cpData!));
    expect(Object.keys(cp.files)).toHaveLength(2);

    const state = engine.getState();
    expect(Object.keys(state.registry)).toHaveLength(2);
  });

  it("V2 device joining after migration pulls correctly", async () => {
    const backend = new MemoryBackend();

    const v1Manifest: Manifest = {
      version: 1,
      deviceId: "old",
      updatedAt: Date.now(),
      files: {
        "notes/x.md": { hash: "xxx", mtime: 1000, size: 50 },
      },
    };
    await writeV1Manifest(backend, v1Manifest);
    await backend.put("files/notes/x.md", new TextEncoder().encode("xxx content").buffer);

    const vaultA = new MockVault();
    vaultA.addFile("notes/x.md", "xxx content");
    const { engine: engineA } = createEngine({ backend, vault: vaultA, deviceId: "A" });
    await engineA.initialize();

    const vaultB = new MockVault();
    const { engine: engineB } = createEngine({ backend, vault: vaultB, deviceId: "B" });
    await engineB.initialize();

    expect(vaultB.getFile("notes/x.md")).not.toBeNull();
    expect(new TextDecoder().decode(vaultB.readBinary("notes/x.md")!)).toBe("xxx content");
  });
});

describe("crash recovery (outbox persistence)", () => {
  it("restores outbox from serialized state and flushes", async () => {
    const backend = new MemoryBackend();
    const vault = new MockVault();
    vault.addFile("a.md", "content");

    const { engine: engine1 } = createEngine({ backend, vault, deviceId: "dev1" });
    engine1.onFileCreate("a.md");

    const serialized = engine1.serialize();

    const { engine: engine2 } = createEngine({ backend, vault, deviceId: "dev1" });
    engine2.restore(serialized);

    expect(engine2.getState().outbox).toHaveLength(1);
    await engine2.flush();
    expect(engine2.getState().outbox).toHaveLength(0);
    expect(engine2.getState().lastSeq).toBe(1);
  });

  it("restore preserves registry", async () => {
    const backend = new MemoryBackend();
    const vault = new MockVault();
    vault.addFile("a.md", "aaa");
    vault.addFile("b.md", "bbb");

    const { engine: engine1 } = createEngine({ backend, vault, deviceId: "dev1" });
    engine1.onFileCreate("a.md");
    engine1.onFileCreate("b.md");
    await engine1.flush();

    const serialized = engine1.serialize();
    const { engine: engine2 } = createEngine({ backend, vault, deviceId: "dev1" });
    engine2.restore(serialized);

    expect(Object.keys(engine2.getState().registry)).toHaveLength(2);
    expect(engine2.getState().lastSeq).toBe(2);
  });
});
