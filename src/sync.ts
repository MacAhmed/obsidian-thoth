import { Vault, TFile } from "obsidian";
import { Storage, Manifest } from "./storage";
import { Logger } from "./logger";

export class SyncEngine {
  private vault: Vault;
  private storage: Storage;
  private log: Logger;
  private deviceId: string;
  private localManifest: Manifest;
  private pendingChanges: Set<string> = new Set();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private pulling = false;

  constructor(vault: Vault, storage: Storage, deviceId: string, logger: Logger) {
    this.vault = vault;
    this.storage = storage;
    this.deviceId = deviceId;
    this.log = logger;
    this.localManifest = {
      version: 1,
      deviceId,
      updatedAt: Date.now(),
      files: {},
    };
  }

  async initialize(): Promise<void> {
    this.log.notice("Thoth: initializing...");
    try {
      await this.buildLocalManifest();
      const remote = await this.storage.getManifest();
      const localCount = Object.keys(this.localManifest.files).length;
      const remoteCount = remote ? Object.keys(remote.files).length : 0;

      this.log.notice(`Thoth: local=${localCount}, remote=${remoteCount}`);

      if (localCount > 0 && remoteCount === 0) {
        await this.pushAll();
      } else if (remoteCount > 0) {
        await this.pull();
      } else {
        this.log.info("Nothing to sync — both local and remote are empty");
      }
    } catch (e: any) {
      this.log.notice(`Thoth init failed: ${e.name}: ${e.message}`, 10000);
      this.log.error("initialize() threw", e);
    }
  }

  private async pushAll(): Promise<void> {
    const paths = Object.keys(this.localManifest.files);
    const total = paths.length;
    let pushed = 0;
    let failed = 0;
    const CONCURRENCY = 20;

    this.log.notice(`Thoth: initial push — ${total} files (${CONCURRENCY} parallel)`);

    for (let i = 0; i < paths.length; i += CONCURRENCY) {
      const batch = paths.slice(i, i + CONCURRENCY);
      const promises = batch.map(async (path) => {
        const file = this.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return;

        try {
          const content = await this.vault.readBinary(file);
          await this.storage.putFile(path, content);
          pushed++;
        } catch (e: any) {
          failed++;
          this.log.error(`pushAll: failed on ${path}`, e);
        }
      });

      await Promise.all(promises);

      if ((i + CONCURRENCY) % 100 < CONCURRENCY) {
        this.log.info(`pushAll: ${pushed}/${total} (${failed} failed)`);
      }
    }

    this.localManifest.updatedAt = Date.now();
    await this.storage.putManifest(this.localManifest);
    this.log.notice(`Thoth: initial push complete — ${pushed}/${total} files (${failed} failed)`);
  }

  private async buildLocalManifest(): Promise<void> {
    const files = this.vault.getFiles();
    this.log.info(`buildLocalManifest: vault.getFiles() returned ${files.length} files`);

    let skipped = 0;
    for (const file of files) {
      if (file.path.startsWith(".") || file.path.startsWith("_thoth")) {
        skipped++;
        continue;
      }
      this.localManifest.files[file.path] = {
        hash: await this.hashFile(file),
        mtime: file.stat.mtime,
        size: file.stat.size,
      };
    }
    this.log.info(`buildLocalManifest: indexed ${Object.keys(this.localManifest.files).length}, skipped ${skipped}`);
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = path.split("/");
    parts.pop(); // remove filename
    if (parts.length === 0) return;

    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.vault.createFolder(current);
      }
    }
  }

  private async hashFile(file: TFile): Promise<string> {
    const content = await this.vault.readBinary(file);
    const hashBuffer = await crypto.subtle.digest("SHA-256", content);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  onFileChange(path: string): void {
    if (this.pulling) return;
    if (path.startsWith(".") || path.startsWith("_thoth") || path === "_thoth-log.md") return;
    this.pendingChanges.add(path);
    this.schedulePush();
  }

  onFileDelete(path: string): void {
    if (this.pulling) return;
    if (path.startsWith(".") || path.startsWith("_thoth") || path === "_thoth-log.md") return;
    if (this.localManifest.files[path]) {
      this.localManifest.files[path].deleted = true;
      this.localManifest.files[path].mtime = Date.now();
    }
    this.pendingChanges.add(path);
    this.schedulePush();
  }

  onFileRename(oldPath: string, newPath: string): void {
    this.onFileDelete(oldPath);
    this.onFileChange(newPath);
  }

  private schedulePush(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.push(), 2000);
  }

  async push(): Promise<void> {
    if (this.syncing || this.pendingChanges.size === 0) return;
    this.syncing = true;

    const changes = [...this.pendingChanges];
    this.log.info(`push: ${changes.length} files queued`);

    try {
      this.pendingChanges.clear();

      for (const path of changes) {
        const entry = this.localManifest.files[path];

        if (entry?.deleted) {
          this.log.info(`push: deleting ${path}`);
          await this.storage.deleteFile(path);
          continue;
        }

        const file = this.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) continue;

        const content = await this.vault.readBinary(file);
        const hash = await this.hashFile(file);

        this.log.info(`push: uploading ${path} (${content.byteLength} bytes)`);
        await this.storage.putFile(path, content);
        this.localManifest.files[path] = {
          hash,
          mtime: file.stat.mtime,
          size: file.stat.size,
        };
      }

      this.localManifest.updatedAt = Date.now();
      this.localManifest.deviceId = this.deviceId;
      await this.storage.putManifest(this.localManifest);
      this.log.info(`push: done, manifest updated`);
    } catch (e: any) {
      this.log.notice(`Thoth push failed: ${e.name}: ${e.message}`, 10000);
      this.log.error("push() threw", e);
    } finally {
      this.syncing = false;
    }
  }

  async pull(): Promise<void> {
    if (this.syncing) {
      this.log.notice("Thoth: sync already in progress");
      return;
    }
    this.syncing = true;
    this.pulling = true;
    this.log.info("pull: starting");

    try {
      const remote = await this.storage.getManifest();
      if (!remote) {
        this.log.info("pull: no remote manifest, uploading local");
        await this.storage.putManifest(this.localManifest);
        return;
      }

      this.log.info(`pull: remote deviceId=${remote.deviceId}, files=${Object.keys(remote.files).length}, updatedAt=${new Date(remote.updatedAt).toISOString()}`);

      const remoteFileCount = Object.keys(remote.files).length;
      const localFileCount = Object.keys(this.localManifest.files).length;

      if (remote.deviceId === this.deviceId && remote.updatedAt <= this.localManifest.updatedAt && remoteFileCount <= localFileCount) {
        this.log.info("pull: remote is same device, not newer, and no more files — skipping");
        return;
      }

      let pulled = 0;
      let deleted = 0;
      let conflicts = 0;
      const CONCURRENCY = 20;

      // Separate into deletes and downloads
      const toDelete: [string, typeof remote.files[string]][] = [];
      const toDownload: [string, typeof remote.files[string]][] = [];

      for (const [path, entry] of Object.entries(remote.files)) {
        const local = this.localManifest.files[path];

        if (entry.deleted) {
          if (local && !local.deleted) toDelete.push([path, entry]);
          continue;
        }
        if (local && local.hash === entry.hash) continue;
        if (local && local.mtime > entry.mtime && local.hash !== entry.hash) {
          toDownload.push([path, { ...entry, _conflict: true } as any]);
          continue;
        }
        toDownload.push([path, entry]);
      }

      this.log.info(`pull: ${toDelete.length} to delete, ${toDownload.length} to download`);

      // Process deletes sequentially (fast, vault ops)
      for (const [path, entry] of toDelete) {
        const file = this.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          await this.vault.delete(file);
          deleted++;
        }
        this.localManifest.files[path] = entry;
      }

      // Download in parallel batches
      for (let i = 0; i < toDownload.length; i += CONCURRENCY) {
        const batch = toDownload.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map(async ([path, entry]) => {
            try {
              const data = await this.storage.getFile(path);
              return { path, entry, data };
            } catch (e: any) {
              this.log.error(`pull: download failed for ${path}`, e);
              return { path, entry, data: null };
            }
          })
        );

        // Apply to vault sequentially (vault ops aren't safe to parallelize)
        for (const { path, entry, data } of results) {
          if (!data) continue;

          if ((entry as any)._conflict) {
            const conflictPath = path.replace(/\.md$/, `.conflict-${remote.deviceId}.md`);
            await this.ensureFolder(conflictPath);
            await this.vault.createBinary(conflictPath, data);
            conflicts++;
            continue;
          }

          const existing = this.vault.getAbstractFileByPath(path);
          if (existing instanceof TFile) {
            await this.vault.modifyBinary(existing, data);
          } else {
            await this.ensureFolder(path);
            await this.vault.createBinary(path, data);
          }
          this.localManifest.files[path] = entry;
          pulled++;
        }

        if ((i + CONCURRENCY) % 100 < CONCURRENCY) {
          this.log.info(`pull: ${pulled}/${toDownload.length} downloaded`);
        }
      }

      this.localManifest.updatedAt = Date.now();

      this.log.notice(`Thoth: pulled ${pulled}, deleted ${deleted}, conflicts ${conflicts}`);
    } catch (e: any) {
      this.log.notice(`Thoth pull failed: ${e.name}: ${e.message}`, 10000);
      this.log.error("pull() threw", e);
    } finally {
      this.pulling = false;
      this.syncing = false;
      this.pendingChanges.clear();
    }
  }
}
