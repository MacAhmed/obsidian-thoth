/**
 * Integration tests against a real R2 bucket + real filesystem vaults.
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
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { S3Backend } from "../src/backends/s3";
import { SyncEngineV2 } from "../src/sync-engine";
import type { VaultAdapter } from "../src/sync-engine";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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

// Real filesystem vault — no mocking
function makeFsVault(root: string): { adapter: VaultAdapter; dir: string } {
  fs.mkdirSync(root, { recursive: true });

  const adapter: VaultAdapter = {
    getFiles() {
      const results: Array<{ path: string; stat: { mtime: number; size: number } }> = [];
      function walk(dir: string) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, entry.name);
          if (entry.isDirectory()) { walk(abs); continue; }
          const rel = path.relative(root, abs).replace(/\\/g, "/");
          const stat = fs.statSync(abs);
          results.push({ path: rel, stat: { mtime: stat.mtimeMs, size: stat.size } });
        }
      }
      if (fs.existsSync(root)) walk(root);
      return results;
    },
    async readBinary(filePath: string) {
      const abs = path.join(root, filePath);
      if (!fs.existsSync(abs)) return null;
      const buf = fs.readFileSync(abs);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    },
    async createBinary(filePath: string, data: ArrayBuffer) {
      const abs = path.join(root, filePath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, Buffer.from(data));
    },
    async modifyBinary(filePath: string, data: ArrayBuffer) {
      const abs = path.join(root, filePath);
      fs.writeFileSync(abs, Buffer.from(data));
    },
    async deletePath(filePath: string) {
      const abs = path.join(root, filePath);
      if (fs.existsSync(abs)) fs.rmSync(abs);
    },
    async renamePath(oldPath: string, newPath: string) {
      const absOld = path.join(root, oldPath);
      const absNew = path.join(root, newPath);
      fs.mkdirSync(path.dirname(absNew), { recursive: true });
      fs.renameSync(absOld, absNew);
    },
    exists(filePath: string) {
      return fs.existsSync(path.join(root, filePath));
    },
    async ensureFolder(filePath: string) {
      const abs = path.join(root, path.dirname(filePath));
      fs.mkdirSync(abs, { recursive: true });
    },
  };

  return { adapter, dir: root };
}

function makeEngine(vaultDir: string, deviceId: string) {
  const { adapter } = makeFsVault(vaultDir);
  return new SyncEngineV2({ backend: makeBackend(), vault: adapter, deviceId });
}

function writeFile(vaultDir: string, filePath: string, content: string) {
  const abs = path.join(vaultDir, filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

function readFile(vaultDir: string, filePath: string): string | null {
  const abs = path.join(vaultDir, filePath);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
}

function listFiles(vaultDir: string): string[] {
  const results: string[] = [];
  function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      results.push(path.relative(vaultDir, abs).replace(/\\/g, "/"));
    }
  }
  walk(vaultDir);
  return results;
}

// Temp dirs — cleaned up after each test
const tmpDirs: string[] = [];
function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thoth-test-"));
  tmpDirs.push(dir);
  return dir;
}

describe.skipIf(!HAVE_CREDS)("integration: real R2 bucket + real filesystem", () => {
  beforeEach(async () => { await wipe(); }, 30_000);

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fresh sync: A pushes 10 files, B pulls from scratch", async () => {
    const dirA = makeTmpDir();
    for (let i = 0; i < 10; i++) writeFile(dirA, `note-${i}.md`, `content ${i}`);
    await makeEngine(dirA, "A").initialize();

    const dirB = makeTmpDir();
    await makeEngine(dirB, "B").initialize();

    for (let i = 0; i < 10; i++) {
      expect(readFile(dirB, `note-${i}.md`)).toBe(`content ${i}`);
    }
  }, 30_000);

  it("concurrent edits no conflict: A and B modify different files, both converge", async () => {
    const dirA = makeTmpDir();
    writeFile(dirA, "a.md", "original a");
    writeFile(dirA, "b.md", "original b");
    const engineA = makeEngine(dirA, "A");
    await engineA.initialize();

    const dirB = makeTmpDir();
    const engineB = makeEngine(dirB, "B");
    await engineB.initialize();

    writeFile(dirA, "a.md", "A edited a");
    await engineA.onFileModify("a.md");
    await engineA.flush();

    writeFile(dirB, "b.md", "B edited b");
    await engineB.onFileModify("b.md");
    await engineB.flush();

    await engineA.pull();
    await engineB.pull();

    expect(readFile(dirA, "a.md")).toBe("A edited a");
    expect(readFile(dirA, "b.md")).toBe("B edited b");
    expect(readFile(dirB, "a.md")).toBe("A edited a");
    expect(readFile(dirB, "b.md")).toBe("B edited b");
  }, 30_000);

  it("bulk rename: A renames 20 files, B gets new structure with zero data loss", async () => {
    const dirA = makeTmpDir();
    for (let i = 0; i < 20; i++) writeFile(dirA, `old/note-${i}.md`, `content ${i}`);
    const engineA = makeEngine(dirA, "A");
    await engineA.initialize();

    const dirB = makeTmpDir();
    const engineB = makeEngine(dirB, "B");
    await engineB.initialize();

    for (let i = 0; i < 20; i++) {
      fs.renameSync(path.join(dirA, `old/note-${i}.md`), (() => {
        const dest = path.join(dirA, `new/note-${i}.md`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        return dest;
      })());
      engineA.onFileRename(`old/note-${i}.md`, `new/note-${i}.md`);
    }
    await engineA.flush();
    await engineB.pull();

    for (let i = 0; i < 20; i++) {
      expect(readFile(dirB, `old/note-${i}.md`)).toBeNull();
      expect(readFile(dirB, `new/note-${i}.md`)).toBe(`content ${i}`);
    }
  }, 30_000);

  it("delete propagation: A deletes, B receives — no ghost resurrection", async () => {
    const dirA = makeTmpDir();
    writeFile(dirA, "to-delete.md", "doomed");
    writeFile(dirA, "keeper.md", "stays");
    const engineA = makeEngine(dirA, "A");
    await engineA.initialize();

    const dirB = makeTmpDir();
    const engineB = makeEngine(dirB, "B");
    await engineB.initialize();
    expect(readFile(dirB, "to-delete.md")).toBe("doomed");

    fs.rmSync(path.join(dirA, "to-delete.md"));
    engineA.onFileDelete("to-delete.md");
    await engineA.flush();
    await engineB.pull();

    expect(readFile(dirB, "to-delete.md")).toBeNull();
    expect(readFile(dirB, "keeper.md")).toBe("stays");

    await engineB.pull();
    expect(readFile(dirB, "to-delete.md")).toBeNull();
  }, 30_000);

  it("interrupted push: crashed mid-flush resumes via serialized outbox", async () => {
    const dirA = makeTmpDir();
    writeFile(dirA, "a.md", "hello");
    const engineA = makeEngine(dirA, "A");
    await engineA.initialize();

    writeFile(dirA, "b.md", "world");
    await engineA.onFileCreate("b.md");
    const savedState = engineA.serialize();

    // Resume from saved state
    const engineA2 = makeEngine(dirA, "A");
    engineA2.restore(savedState);
    await engineA2.flush();

    const dirB = makeTmpDir();
    await makeEngine(dirB, "B").initialize();

    expect(readFile(dirB, "a.md")).toBe("hello");
    expect(readFile(dirB, "b.md")).toBe("world");
  }, 30_000);

  it("concurrent push: A and B flush simultaneously — both ops land", async () => {
    const dirA = makeTmpDir();
    const engineA = makeEngine(dirA, "A");
    await engineA.initialize();

    const dirB = makeTmpDir();
    const engineB = makeEngine(dirB, "B");

    writeFile(dirA, "from-a.md", "from A");
    await engineA.onFileCreate("from-a.md");

    writeFile(dirB, "from-b.md", "from B");
    await engineB.onFileCreate("from-b.md");

    await Promise.all([engineA.flush(), engineB.flush()]);

    const dirC = makeTmpDir();
    await makeEngine(dirC, "C").initialize();

    expect(readFile(dirC, "from-a.md")).toBe("from A");
    expect(readFile(dirC, "from-b.md")).toBe("from B");
  }, 30_000);

  it("V1 killer: B has old paths, A restructures entire vault, B converges zero data loss", async () => {
    const dirA = makeTmpDir();
    for (let i = 0; i < 10; i++) writeFile(dirA, `flat/note-${i}.md`, `note ${i}`);
    const engineA = makeEngine(dirA, "A");
    await engineA.initialize();

    const dirB = makeTmpDir();
    const engineB = makeEngine(dirB, "B");
    await engineB.initialize();

    for (let i = 0; i < 10; i++) {
      const dest = path.join(dirA, `structured/folder-${i % 3}/note-${i}.md`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(path.join(dirA, `flat/note-${i}.md`), dest);
      engineA.onFileRename(`flat/note-${i}.md`, `structured/folder-${i % 3}/note-${i}.md`);
    }
    await engineA.flush();
    await engineB.pull();

    for (let i = 0; i < 10; i++) {
      expect(readFile(dirB, `flat/note-${i}.md`)).toBeNull();
      const newPath = `structured/folder-${i % 3}/note-${i}.md`;
      expect(readFile(dirB, newPath)).toBe(`note ${i}`);
    }
  }, 30_000);

  it("cold start case 4: new device with existing files reconciles against real R2", async () => {
    const dirA = makeTmpDir();
    writeFile(dirA, "a.md", "aaa");
    writeFile(dirA, "b.md", "bbb");
    const engineA = makeEngine(dirA, "A");
    await engineA.initialize();

    // B has same content at different paths + one local-only
    const dirB = makeTmpDir();
    writeFile(dirB, "a.md", "aaa");       // hash+path match
    writeFile(dirB, "renamed.md", "bbb"); // hash match only → rename to b.md
    writeFile(dirB, "local.md", "local"); // local only → push
    const engineB = makeEngine(dirB, "B");
    await engineB.initialize();

    const stateA = engineA.getState();
    const stateB = engineB.getState();

    // a.md UUID matches A's
    const aIdInA = Object.keys(stateA.registry).find(id => stateA.registry[id].path === "a.md");
    const aIdInB = Object.keys(stateB.registry).find(id => stateB.registry[id].path === "a.md");
    expect(aIdInB).toBe(aIdInA);

    expect(listFiles(dirB)).not.toContain("renamed.md");
    expect(readFile(dirB, "b.md")).toBe("bbb");

    await engineB.flush();

    const dirC = makeTmpDir();
    await makeEngine(dirC, "C").initialize();
    expect(readFile(dirC, "a.md")).toBe("aaa");
    expect(readFile(dirC, "b.md")).toBe("bbb");
    expect(readFile(dirC, "local.md")).toBe("local");
  }, 30_000);

  it("zero conflict files: two active devices editing different files then syncing", async () => {
    const dirA = makeTmpDir();
    for (let i = 0; i < 20; i++) writeFile(dirA, `notes/note-${i}.md`, `v1 content ${i}`);
    const engineA = makeEngine(dirA, "A");
    await engineA.initialize();

    const dirB = makeTmpDir();
    const engineB = makeEngine(dirB, "B");
    await engineB.initialize();

    // Both devices edit different files concurrently
    for (let i = 0; i < 10; i++) {
      writeFile(dirA, `notes/note-${i}.md`, `A edited ${i}`);
      await engineA.onFileModify(`notes/note-${i}.md`);
    }
    for (let i = 10; i < 20; i++) {
      writeFile(dirB, `notes/note-${i}.md`, `B edited ${i}`);
      await engineB.onFileModify(`notes/note-${i}.md`);
    }

    await engineA.flush();
    await engineB.flush();
    await engineA.pull();
    await engineB.pull();

    // Zero conflict files on either device
    expect(listFiles(dirA).filter(f => f.includes(".conflict-"))).toHaveLength(0);
    expect(listFiles(dirB).filter(f => f.includes(".conflict-"))).toHaveLength(0);

    // Both devices converge on same content
    for (let i = 0; i < 10; i++) {
      expect(readFile(dirA, `notes/note-${i}.md`)).toBe(`A edited ${i}`);
      expect(readFile(dirB, `notes/note-${i}.md`)).toBe(`A edited ${i}`);
    }
    for (let i = 10; i < 20; i++) {
      expect(readFile(dirA, `notes/note-${i}.md`)).toBe(`B edited ${i}`);
      expect(readFile(dirB, `notes/note-${i}.md`)).toBe(`B edited ${i}`);
    }
  }, 30_000);

  it("zero conflict files: B has partial checkpoint version, A edits, B reconciles", async () => {
    // Regression: the stale-pull false conflict scenario against real R2
    const dirA = makeTmpDir();
    writeFile(dirA, "02_Tracker/Daily/today.md", "morning notes");
    writeFile(dirA, "01_Inbox/note.md", "inbox");
    const engineA = makeEngine(dirA, "A");
    await engineA.initialize(); // checkpoint written

    // A edits the daily note throughout the day
    writeFile(dirA, "02_Tracker/Daily/today.md", "morning notes\nafternoon notes\nevening notes");
    await engineA.onFileModify("02_Tracker/Daily/today.md");
    await engineA.flush();

    // B has the checkpoint version on disk (simulates partial pull with no saved state)
    const dirB = makeTmpDir();
    writeFile(dirB, "02_Tracker/Daily/today.md", "morning notes");
    writeFile(dirB, "01_Inbox/note.md", "inbox");
    // B has NO registry — simulates lost state
    const engineB = makeEngine(dirB, "B");
    await engineB.initialize();

    // Zero conflict files
    expect(listFiles(dirB).filter(f => f.includes(".conflict-"))).toHaveLength(0);

    // B has the latest version
    expect(readFile(dirB, "02_Tracker/Daily/today.md")).toBe("morning notes\nafternoon notes\nevening notes");
  }, 30_000);
});
