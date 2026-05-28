import { Vault, TFile, Notice } from "obsidian";
import { Storage, Manifest, FileEntry } from "./storage";

export class SyncEngine {
  private vault: Vault;
  private storage: Storage;
  private deviceId: string;
  private localManifest: Manifest;
  private pendingChanges: Set<string> = new Set();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;

  constructor(vault: Vault, storage: Storage, deviceId: string) {
    this.vault = vault;
    this.storage = storage;
    this.deviceId = deviceId;
    this.localManifest = {
      version: 1,
      deviceId,
      updatedAt: Date.now(),
      files: {},
    };
  }

  async initialize(): Promise<void> {
    await this.buildLocalManifest();
    const remote = await this.storage.getManifest();
    const localCount = Object.keys(this.localManifest.files).length;
    const remoteCount = remote ? Object.keys(remote.files).length : 0;

    console.log(`[thoth] init: local=${localCount} files, remote=${remoteCount} files`);

    if (localCount > 0 && remoteCount === 0) {
      await this.pushAll();
    } else if (remoteCount > 0) {
      await this.pull();
    }
  }

  private async pushAll(): Promise<void> {
    const paths = Object.keys(this.localManifest.files);
    const total = paths.length;
    let pushed = 0;

    new Notice(`Thoth: initial push — ${total} files`);
    console.log(`[thoth] pushAll: uploading ${total} files`);

    for (const path of paths) {
      const file = this.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) continue;

      const content = await this.vault.readBinary(file);
      await this.storage.putFile(path, content);
      pushed++;

      if (pushed % 50 === 0) {
        console.log(`[thoth] pushAll: ${pushed}/${total}`);
      }
    }

    this.localManifest.updatedAt = Date.now();
    await this.storage.putManifest(this.localManifest);
    new Notice(`Thoth: initial push complete — ${pushed} files`);
    console.log(`[thoth] pushAll: done, ${pushed} files uploaded`);
  }

  private async buildLocalManifest(): Promise<void> {
    const files = this.vault.getFiles();
    console.log(`[thoth] buildLocalManifest: vault.getFiles() returned ${files.length} files`);
    if (files.length > 0) {
      console.log(`[thoth] buildLocalManifest: first 3 paths:`, files.slice(0, 3).map(f => f.path));
    }

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
    console.log(`[thoth] buildLocalManifest: indexed ${Object.keys(this.localManifest.files).length}, skipped ${skipped}`);
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
    if (path.startsWith(".") || path.startsWith("_thoth")) return;
    this.pendingChanges.add(path);
    this.schedulePush();
  }

  onFileDelete(path: string): void {
    if (path.startsWith(".") || path.startsWith("_thoth")) return;
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

    try {
      const changes = [...this.pendingChanges];
      this.pendingChanges.clear();

      for (const path of changes) {
        const entry = this.localManifest.files[path];

        if (entry?.deleted) {
          await this.storage.deleteFile(`files/${path}`);
          continue;
        }

        const file = this.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) continue;

        const content = await this.vault.readBinary(file);
        const hash = await this.hashFile(file);

        await this.storage.putFile(`files/${path}`, content);
        this.localManifest.files[path] = {
          hash,
          mtime: file.stat.mtime,
          size: file.stat.size,
        };
      }

      this.localManifest.updatedAt = Date.now();
      this.localManifest.deviceId = this.deviceId;
      await this.storage.putManifest(this.localManifest);
    } catch (e: any) {
      new Notice(`Thoth push failed: ${e.name}: ${e.message}`, 10000);
      console.error("[thoth] push error:", e);
    } finally {
      this.syncing = false;
    }
  }

  async pull(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;

    try {
      const remote = await this.storage.getManifest();
      if (!remote) {
        await this.storage.putManifest(this.localManifest);
        return;
      }

      if (remote.deviceId === this.deviceId && remote.updatedAt <= this.localManifest.updatedAt) {
        return;
      }

      let pulled = 0;
      let deleted = 0;

      for (const [path, entry] of Object.entries(remote.files)) {
        const local = this.localManifest.files[path];

        if (entry.deleted) {
          if (local && !local.deleted) {
            const file = this.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
              await this.vault.delete(file);
              deleted++;
            }
            this.localManifest.files[path] = entry;
          }
          continue;
        }

        if (local && local.hash === entry.hash) continue;

        if (local && local.mtime > entry.mtime && local.hash !== entry.hash) {
          // Local is newer — conflict, keep local, save remote as .conflict
          const data = await this.storage.getFile(`files/${path}`);
          if (data) {
            const conflictPath = path.replace(/\.md$/, `.conflict-${remote.deviceId}.md`);
            await this.vault.createBinary(conflictPath, data);
          }
          continue;
        }

        const data = await this.storage.getFile(`files/${path}`);
        if (!data) continue;

        const existing = this.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) {
          await this.vault.modifyBinary(existing, data);
        } else {
          await this.vault.createBinary(path, data);
        }

        this.localManifest.files[path] = entry;
        pulled++;
      }

      // Handle files deleted remotely that we still have
      for (const [path, local] of Object.entries(this.localManifest.files)) {
        if (!remote.files[path] && !local.deleted) {
          // File exists locally but not in remote manifest — it's new locally, push it
        }
      }

      this.localManifest.updatedAt = Date.now();

      if (pulled > 0 || deleted > 0) {
        new Notice(`Thoth: pulled ${pulled} files, deleted ${deleted}`);
      }
    } catch (e: any) {
      new Notice(`Thoth pull failed: ${e.name}: ${e.message}`, 10000);
      console.error("[thoth] pull error:", e);
    } finally {
      this.syncing = false;
    }
  }
}
