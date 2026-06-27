/**
 * Integration tests against a real R2 bucket.
 *
 * Requires environment variables (set in .env.test or CI secrets):
 *   R2_ENDPOINT   — https://<account>.r2.cloudflarestorage.com
 *   R2_ACCESS_KEY
 *   R2_SECRET_KEY
 *   R2_BUCKET     — test bucket name (e.g. obsidian-sync-test)
 *
 * Tests are skipped when credentials are absent.
 * The bucket is wiped before each test — never point at the production bucket.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { S3Backend } from "../src/backends/s3";
import { SyncEngineV2 } from "../src/sync-engine";
import { MockVault } from "./helpers";
import type { VaultAdapter } from "../src/sync-engine";

const ENDPOINT   = process.env.R2_ENDPOINT   ?? "";
const ACCESS_KEY = process.env.R2_ACCESS_KEY  ?? "";
const SECRET_KEY = process.env.R2_SECRET_KEY  ?? "";
const BUCKET     = process.env.R2_BUCKET      ?? "";

const HAVE_CREDS = !!(ENDPOINT && ACCESS_KEY && SECRET_KEY && BUCKET);

function makeBackend() {
  return new S3Backend({ endpoint: ENDPOINT, region: "auto", accessKey: ACCESS_KEY, secretKey: SECRET_KEY, bucket: BUCKET });
}

async function wipe() {
  const backend = makeBackend();
  const keys = await backend.list("");
  await Promise.all(keys.map(k => backend.delete(k)));
}

function vaultAdapter(vault: MockVault): VaultAdapter {
  return {
    getFiles: () => vault.getAllFiles().map(f => ({ path: f.path, stat: { mtime: f.mtime, size: f.size } })),
    readBinary: (path) => vault.readBinary(path),
    createBinary: (path, data) => { vault.addFile(path, new TextDecoder().decode(data)); },
    modifyBinary: (path, data) => { vault.modifyFile(path, new TextDecoder().decode(data)); },
    deletePath: (path) => { vault.deleteFile(path); },
    renamePath: (old, next) => { vault.renameFile(old, next); },
    exists: (path) => vault.files.has(path),
    ensureFolder: () => {},
  };
}

function makeEngine(vault: MockVault, deviceId: string) {
  return new SyncEngineV2({ backend: makeBackend(), vault: vaultAdapter(vault), deviceId });
}

describe.skipIf(!HAVE_CREDS)("integration: real R2 bucket", () => {
  beforeEach(async () => { await wipe(); }, 30_000);

  it("fresh sync: A pushes 10 files, B pulls from scratch", async () => {
    const vaultA = new MockVault();
    for (let i = 0; i < 10; i++) vaultA.addFile(`note-${i}.md`, `content ${i}`);
    const engineA = makeEngine(vaultA, "A");
    await engineA.initialize();

    const vaultB = new MockVault();
    const engineB = makeEngine(vaultB, "B");
    await engineB.initialize();

    for (let i = 0; i < 10; i++) {
      expect(vaultB.getFile(`note-${i}.md`)).not.toBeNull();
      expect(new TextDecoder().decode(vaultB.readBinary(`note-${i}.md`)!)).toBe(`content ${i}`);
    }
  }, 30_000);

  it("concurrent edits no conflict: A and B modify different files, both converge", async () => {
    const vaultA = new MockVault();
    vaultA.addFile("a.md", "original a");
    vaultA.addFile("b.md", "original b");
    const engineA = makeEngine(vaultA, "A");
    await engineA.initialize();

    const vaultB = new MockVault();
    const engineB = makeEngine(vaultB, "B");
    await engineB.initialize();

    vaultA.modifyFile("a.md", "A edited a");
    engineA.onFileModify("a.md");
    await engineA.flush();

    vaultB.modifyFile("b.md", "B edited b");
    engineB.onFileModify("b.md");
    await engineB.flush();

    await engineA.pull();
    await engineB.pull();

    expect(new TextDecoder().decode(vaultA.readBinary("a.md")!)).toBe("A edited a");
    expect(new TextDecoder().decode(vaultA.readBinary("b.md")!)).toBe("B edited b");
    expect(new TextDecoder().decode(vaultB.readBinary("a.md")!)).toBe("A edited a");
    expect(new TextDecoder().decode(vaultB.readBinary("b.md")!)).toBe("B edited b");
  }, 30_000);

  it("bulk rename: A renames 20 files, B gets new structure zero data loss", async () => {
    const vaultA = new MockVault();
    for (let i = 0; i < 20; i++) vaultA.addFile(`old/note-${i}.md`, `content ${i}`);
    const engineA = makeEngine(vaultA, "A");
    await engineA.initialize();

    const vaultB = new MockVault();
    const engineB = makeEngine(vaultB, "B");
    await engineB.initialize();

    for (let i = 0; i < 20; i++) {
      vaultA.renameFile(`old/note-${i}.md`, `new/note-${i}.md`);
      engineA.onFileRename(`old/note-${i}.md`, `new/note-${i}.md`);
    }
    await engineA.flush();
    await engineB.pull();

    for (let i = 0; i < 20; i++) {
      expect(vaultB.getFile(`old/note-${i}.md`)).toBeNull();
      expect(vaultB.getFile(`new/note-${i}.md`)).not.toBeNull();
      expect(new TextDecoder().decode(vaultB.readBinary(`new/note-${i}.md`)!)).toBe(`content ${i}`);
    }
  }, 30_000);

  it("delete propagation: A deletes, B receives — no ghost resurrection", async () => {
    const vaultA = new MockVault();
    vaultA.addFile("to-delete.md", "doomed");
    vaultA.addFile("keeper.md", "stays");
    const engineA = makeEngine(vaultA, "A");
    await engineA.initialize();

    const vaultB = new MockVault();
    const engineB = makeEngine(vaultB, "B");
    await engineB.initialize();

    expect(vaultB.getFile("to-delete.md")).not.toBeNull();

    vaultA.deleteFile("to-delete.md");
    engineA.onFileDelete("to-delete.md");
    await engineA.flush();
    await engineB.pull();

    expect(vaultB.getFile("to-delete.md")).toBeNull();
    expect(vaultB.getFile("keeper.md")).not.toBeNull();

    // Second pull — no ghost resurrection
    await engineB.pull();
    expect(vaultB.getFile("to-delete.md")).toBeNull();
  }, 30_000);

  it("interrupted push: crashed mid-flush resumes via serialized outbox", async () => {
    const vaultA = new MockVault();
    vaultA.addFile("a.md", "hello");
    const engineA = makeEngine(vaultA, "A");
    await engineA.initialize();
    vaultA.addFile("b.md", "world");
    engineA.onFileCreate("b.md");

    // Simulate crash: save state without flushing
    const savedState = engineA.serialize();

    // Resume from saved state
    const engineA2 = makeEngine(vaultA, "A");
    engineA2.restore(savedState);
    await engineA2.flush();

    const vaultB = new MockVault();
    const engineB = makeEngine(vaultB, "B");
    await engineB.initialize();

    expect(vaultB.getFile("a.md")).not.toBeNull();
    expect(vaultB.getFile("b.md")).not.toBeNull();
  }, 30_000);

  it("concurrent push: A and B flush simultaneously — both ops land, head consistent", async () => {
    const vaultA = new MockVault();
    const engineA = makeEngine(vaultA, "A");
    await engineA.initialize();

    const vaultB = new MockVault();
    const engineB = makeEngine(vaultB, "B");

    vaultA.addFile("from-a.md", "from A");
    engineA.onFileCreate("from-a.md");

    vaultB.addFile("from-b.md", "from B");
    engineB.onFileCreate("from-b.md");

    // Flush both simultaneously
    await Promise.all([engineA.flush(), engineB.flush()]);

    // Both ops should be in remote
    const vaultC = new MockVault();
    const engineC = makeEngine(vaultC, "C");
    await engineC.initialize();

    expect(vaultC.getFile("from-a.md")).not.toBeNull();
    expect(vaultC.getFile("from-b.md")).not.toBeNull();
  }, 30_000);

  it("V1 killer: B has old paths, A restructures entire vault, B converges zero data loss", async () => {
    // A has the vault, pushes it
    const vaultA = new MockVault();
    for (let i = 0; i < 10; i++) vaultA.addFile(`flat/note-${i}.md`, `note ${i}`);
    const engineA = makeEngine(vaultA, "A");
    await engineA.initialize();

    // B syncs
    const vaultB = new MockVault();
    const engineB = makeEngine(vaultB, "B");
    await engineB.initialize();

    // A restructures everything
    for (let i = 0; i < 10; i++) {
      vaultA.renameFile(`flat/note-${i}.md`, `structured/folder-${i % 3}/note-${i}.md`);
      engineA.onFileRename(`flat/note-${i}.md`, `structured/folder-${i % 3}/note-${i}.md`);
    }
    await engineA.flush();
    await engineB.pull();

    // B should have the restructured layout, old paths gone, content intact
    for (let i = 0; i < 10; i++) {
      expect(vaultB.getFile(`flat/note-${i}.md`)).toBeNull();
      const newPath = `structured/folder-${i % 3}/note-${i}.md`;
      expect(vaultB.getFile(newPath)).not.toBeNull();
      expect(new TextDecoder().decode(vaultB.readBinary(newPath)!)).toBe(`note ${i}`);
    }
  }, 30_000);

  it("cold start case 4 against real R2: new device with existing vault reconciles", async () => {
    // A initializes remote
    const vaultA = new MockVault();
    vaultA.addFile("a.md", "aaa");
    vaultA.addFile("b.md", "bbb");
    const engineA = makeEngine(vaultA, "A");
    await engineA.initialize();

    // B has same content, different path for one file — no registry
    const vaultB = new MockVault();
    vaultB.addFile("a.md", "aaa");     // hash+path match → adopt UUID
    vaultB.addFile("renamed.md", "bbb"); // hash match only → rename to b.md
    vaultB.addFile("local.md", "local"); // new file → push
    const engineB = makeEngine(vaultB, "B");
    await engineB.initialize();

    const stateA = engineA.getState();
    const stateB = engineB.getState();

    // a.md UUID adopted
    const aIdInA = Object.keys(stateA.registry).find(id => stateA.registry[id].path === "a.md");
    const aIdInB = Object.keys(stateB.registry).find(id => stateB.registry[id].path === "a.md");
    expect(aIdInB).toBe(aIdInA);

    // renamed.md → b.md
    expect(vaultB.getFile("renamed.md")).toBeNull();
    expect(vaultB.getFile("b.md")).not.toBeNull();

    // local.md queued
    expect(stateB.outbox.filter(op => op.type === "create")).toHaveLength(1);

    await engineB.flush();

    // C joins and gets all 3 files
    const vaultC = new MockVault();
    const engineC = makeEngine(vaultC, "C");
    await engineC.initialize();
    expect(vaultC.getFile("a.md")).not.toBeNull();
    expect(vaultC.getFile("b.md")).not.toBeNull();
    expect(vaultC.getFile("local.md")).not.toBeNull();
  }, 30_000);
});
