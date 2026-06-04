import { Vault, TFile } from "obsidian";
import { Storage, Manifest, FileEntry } from "./storage";
import { History } from "./history";
import { Logger } from "./logger";
import { threeWayMerge } from "./merge";

export type Action =
  | { type: "push"; path: string }
  | { type: "pull"; path: string; entry: FileEntry }
  | { type: "deleteLocal"; path: string }
  | { type: "deleteRemote"; path: string }
  | { type: "conflict"; path: string; entry: FileEntry };

export function computeActions(
  localFiles: Record<string, FileEntry>,
  remoteFiles: Record<string, FileEntry>,
  historyFiles: Record<string, FileEntry>
): Action[] {
  const actions: Action[] = [];

  const allPaths = new Set([
    ...Object.keys(localFiles),
    ...Object.keys(remoteFiles),
    ...Object.keys(historyFiles),
  ]);

  for (const path of allPaths) {
    const local = localFiles[path];
    const remoteEntry = remoteFiles[path];
    const prev = historyFiles[path];

    const localExists = local && !local.deleted;
    const remoteExists = remoteEntry && !remoteEntry.deleted;
    const prevExists = !!prev;

    if (localExists && remoteExists && local.hash === remoteEntry.hash) continue;

    if (localExists && !remoteExists && !prevExists) {
      actions.push({ type: "push", path });
      continue;
    }

    if (!localExists && remoteExists && !prevExists) {
      actions.push({ type: "pull", path, entry: remoteEntry });
      continue;
    }

    if (!localExists && prevExists && remoteExists) {
      if (remoteEntry.hash === prev.hash) {
        actions.push({ type: "deleteRemote", path });
      } else {
        actions.push({ type: "pull", path, entry: remoteEntry });
      }
      continue;
    }

    if (localExists && prevExists && !remoteExists) {
      if (local.hash === prev.hash) {
        actions.push({ type: "deleteLocal", path });
      } else {
        actions.push({ type: "push", path });
      }
      continue;
    }

    if (!localExists && !remoteExists) continue;

    if (localExists && remoteExists && prev) {
      if (local.hash === prev.hash && remoteEntry.hash !== prev.hash) {
        actions.push({ type: "pull", path, entry: remoteEntry });
        continue;
      }
      if (local.hash !== prev.hash && remoteEntry.hash === prev.hash) {
        actions.push({ type: "push", path });
        continue;
      }
      if (local.hash !== prev.hash && remoteEntry.hash !== prev.hash) {
        actions.push({ type: "conflict", path, entry: remoteEntry });
        continue;
      }
    }

    if (localExists && remoteExists && !prev) {
      if (local.mtime >= remoteEntry.mtime) {
        actions.push({ type: "push", path });
      } else {
        actions.push({ type: "pull", path, entry: remoteEntry });
      }
      continue;
    }

    if (remoteExists) {
      actions.push({ type: "pull", path, entry: remoteEntry });
    }
  }

  return actions;
}

export class SyncEngine {
  private vault: Vault;
  private storage: Storage;
  private history: History;
  private log: Logger;
  private deviceId: string;
  private mergeStrategy: "auto-merge" | "conflict-file";
  private localManifest: Manifest;
  private pendingChanges: Set<string> = new Set();
  private failedPaths: Set<string> = new Set();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private syncing = false;
  private pulling = false;

  constructor(vault: Vault, storage: Storage, history: History, deviceId: string, logger: Logger, mergeStrategy: "auto-merge" | "conflict-file") {
    this.vault = vault;
    this.storage = storage;
    this.history = history;
    this.deviceId = deviceId;
    this.mergeStrategy = mergeStrategy;
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
      const historyCount = Object.keys(this.history.files).length;

      this.log.notice(`Thoth: local=${localCount}, remote=${remoteCount}, history=${historyCount}`);

      if (localCount > 0 && remoteCount === 0 && historyCount === 0) {
        await this.pushAll();
      } else if (remoteCount > 0 || historyCount > 0) {
        await this.sync(remote);
      } else {
        this.log.info("Nothing to sync — all empty");
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
      await Promise.all(batch.map(async (path) => {
        const file = this.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return;
        try {
          const content = await this.vault.readBinary(file);
          const hash = this.localManifest.files[path].hash;
          await Promise.all([
            this.storage.putFile(path, content),
            this.storage.putBlob(hash, content),
          ]);
          pushed++;
        } catch (e: any) {
          failed++;
          this.log.error(`pushAll: failed on ${path}`, e);
        }
      }));

      if ((i + CONCURRENCY) % 100 < CONCURRENCY) {
        this.log.info(`pushAll: ${pushed}/${total} (${failed} failed)`);
      }
    }

    this.localManifest.updatedAt = Date.now();
    await this.storage.putManifest(this.localManifest);
    await this.history.record(this.localManifest.files);
    this.log.notice(`Thoth: initial push complete — ${pushed}/${total} (${failed} failed)`);
  }

  private computeActions(remote: Manifest | null): Action[] {
    return computeActions(
      this.localManifest.files,
      remote?.files || {},
      this.history.files
    );
  }

  async sync(remote: Manifest | null): Promise<void> {
    if (this.syncing) {
      this.log.notice("Thoth: sync already in progress");
      return;
    }
    this.syncing = true;
    this.pulling = true;
    this.log.info("sync: starting three-way comparison");

    let actions: Action[] = [];
    try {
      if (!remote) remote = await this.storage.getManifest();

      actions = this.computeActions(remote);
      const pushes = actions.filter(a => a.type === "push");
      const pulls = actions.filter(a => a.type === "pull");
      const deleteLocals = actions.filter(a => a.type === "deleteLocal");
      const deleteRemotes = actions.filter(a => a.type === "deleteRemote");
      const conflicts = actions.filter(a => a.type === "conflict");

      this.log.info(`sync: ${pushes.length} push, ${pulls.length} pull, ${deleteLocals.length} deleteLocal, ${deleteRemotes.length} deleteRemote, ${conflicts.length} conflicts`);

      if (actions.length === 0) {
        this.log.info("sync: nothing to do");
        return;
      }

      const CONCURRENCY = 20;

      // Pull files (parallel download, sequential write)
      for (let i = 0; i < pulls.length; i += CONCURRENCY) {
        const batch = pulls.slice(i, i + CONCURRENCY) as { type: "pull"; path: string; entry: FileEntry }[];
        const results = await Promise.all(
          batch.map(async ({ path }) => {
            try {
              return { path, data: await this.storage.getFile(path) };
            } catch (e: any) {
              this.log.error(`sync: download failed ${path}`, e);
              return { path, data: null };
            }
          })
        );

        for (const { path, data } of results) {
          if (!data) continue;
          const existing = this.vault.getAbstractFileByPath(path);
          if (existing instanceof TFile) {
            await this.vault.modifyBinary(existing, data);
          } else {
            await this.ensureFolder(path);
            await this.vault.createBinary(path, data);
          }
          const action = batch.find(b => b.path === path);
          if (action) this.localManifest.files[path] = action.entry;
        }

        if ((i + CONCURRENCY) % 100 < CONCURRENCY && pulls.length > 100) {
          this.log.info(`sync pull: ${Math.min(i + CONCURRENCY, pulls.length)}/${pulls.length}`);
        }
      }

      // Push files (parallel upload + blob)
      for (let i = 0; i < pushes.length; i += CONCURRENCY) {
        const batch = pushes.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map(async ({ path }) => {
          const file = this.vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile)) return;
          try {
            const content = await this.vault.readBinary(file);
            const hash = this.localManifest.files[path]?.hash || await this.hashBytes(content);
            await Promise.all([
              this.storage.putFile(path, content),
              this.storage.putBlob(hash, content),
            ]);
          } catch (e: any) {
            this.log.error(`sync: upload failed ${path}`, e);
          }
        }));
      }

      // Delete local files
      for (const { path } of deleteLocals) {
        const file = this.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          await this.vault.delete(file);
          this.log.info(`sync: deleted local ${path}`);
        }
        delete this.localManifest.files[path];
      }

      // Delete remote files
      for (const { path } of deleteRemotes) {
        await this.storage.deleteFile(path);
        this.log.info(`sync: deleted remote ${path}`);
        delete this.localManifest.files[path];
      }

      // Handle conflicts — attempt three-way merge for markdown, fall back to conflict file
      for (const action of conflicts) {
        const { path, entry } = action as { type: "conflict"; path: string; entry: FileEntry };
        const isMarkdown = path.endsWith(".md");
        const baseHash = this.history.files[path]?.hash;

        if (isMarkdown && this.mergeStrategy === "auto-merge" && baseHash) {
          try {
            const [remoteData, baseData] = await Promise.all([
              this.storage.getFile(path),
              this.storage.getBlob(baseHash),
            ]);

            if (remoteData && baseData) {
              const decoder = new TextDecoder();
              const baseText = decoder.decode(baseData);
              const remoteText = decoder.decode(remoteData);
              const localFile = this.vault.getAbstractFileByPath(path);
              const localText = localFile instanceof TFile
                ? await this.vault.read(localFile)
                : "";

              const result = threeWayMerge(baseText, localText, remoteText);

              if (result.success) {
                const file = this.vault.getAbstractFileByPath(path);
                if (file instanceof TFile) {
                  await this.vault.modify(file, result.merged);
                }
                const mergedBytes = new TextEncoder().encode(result.merged);
                const mergedHash = await this.hashBytes(mergedBytes.buffer);
                this.localManifest.files[path] = {
                  hash: mergedHash,
                  mtime: Date.now(),
                  size: mergedBytes.byteLength,
                };
                await Promise.all([
                  this.storage.putFile(path, mergedBytes.buffer),
                  this.storage.putBlob(mergedHash, mergedBytes.buffer),
                ]);
                this.log.info(`sync: auto-merged ${path}`);
                continue;
              }
            }

            this.log.info(`sync: merge failed for ${path}, falling back to conflict file`);
            this.log.notice(`Thoth: merge failed for ${path}, created conflict file`);
          } catch (e: any) {
            this.log.error(`sync: merge error for ${path}`, e);
            this.log.notice(`Thoth: merge failed for ${path}, created conflict file`);
          }
        }

        // Fallback: create conflict file
        try {
          const data = await this.storage.getFile(path);
          if (!data) continue;
          const ext = path.lastIndexOf(".") > -1 ? path.slice(path.lastIndexOf(".")) : "";
          const stem = path.slice(0, path.length - ext.length);
          const conflictPath = `${stem}.conflict-${remote?.deviceId || "remote"}${ext}`;
          await this.ensureFolder(conflictPath);
          await this.vault.createBinary(conflictPath, data);
          this.log.info(`sync: conflict saved as ${conflictPath}`);
        } catch (e: any) {
          this.log.error(`sync: conflict download failed ${path}`, e);
        }
      }

      // Update manifest and history
      this.localManifest.updatedAt = Date.now();
      this.localManifest.deviceId = this.deviceId;
      await this.storage.putManifest(this.localManifest);
      await this.history.record(this.localManifest.files);

      this.log.notice(`Thoth: synced — ↑${pushes.length} ↓${pulls.length} 🗑${deleteLocals.length + deleteRemotes.length} ⚠${conflicts.length}`);
    } catch (e: any) {
      this.log.notice(`Thoth sync failed: ${e.name}: ${e.message}`, 10000);
      this.log.error("sync() threw", e);
    } finally {
      this.pulling = false;
      this.syncing = false;
      // Only remove paths that were overwritten by pull — preserve user edits queued during sync
      for (const a of actions) {
        if (a.type === "pull" || a.type === "deleteLocal") {
          this.pendingChanges.delete(a.path);
        }
      }
    }
  }

  // Alias for external callers
  async pull(): Promise<void> {
    await this.sync(null);
  }

  async push(): Promise<void> {
    if (this.syncing || this.pendingChanges.size === 0) return;
    this.syncing = true;

    // Pull-before-push: incorporate remote changes before pushing ours
    try {
      const remote = await this.storage.getManifest();
      const actions = computeActions(this.localManifest.files, remote?.files || {}, this.history.files);
      const hasRemoteChanges = actions.some(a => a.type === "pull" || a.type === "deleteLocal" || a.type === "conflict");
      if (hasRemoteChanges) {
        this.syncing = false;
        await this.sync(remote);
        if (this.pendingChanges.size > 0) this.schedulePush();
        return;
      }
    } catch (e: any) {
      this.log.error("push: pull-before-push failed, continuing", e);
    }

    for (const path of this.failedPaths) this.pendingChanges.add(path);
    this.failedPaths.clear();

    const changes = [...this.pendingChanges];
    for (const path of changes) this.pendingChanges.delete(path);
    this.log.info(`push: ${changes.length} files queued`);

    let pushed = 0;
    try {
      for (const path of changes) {
        const file = this.vault.getAbstractFileByPath(path);

        if (!file || !(file instanceof TFile)) {
          this.log.info(`push: deleting ${path}`);
          try {
            await this.storage.deleteFile(path);
            delete this.localManifest.files[path];
          } catch (e: any) {
            this.log.error(`push: delete failed ${path}`, e);
            this.failedPaths.add(path);
          }
          continue;
        }

        try {
          const { content, hash } = await this.readAndHash(file);
          this.log.info(`push: uploading ${path} (${content.byteLength} bytes)`);
          await Promise.all([
            this.storage.putFile(path, content),
            this.storage.putBlob(hash, content),
          ]);
          this.localManifest.files[path] = {
            hash,
            mtime: file.stat.mtime,
            size: file.stat.size,
          };
          pushed++;
        } catch (e: any) {
          this.log.error(`push: failed ${path}`, e);
          this.failedPaths.add(path);
        }
      }

      if (pushed > 0) {
        this.localManifest.updatedAt = Date.now();
        this.localManifest.deviceId = this.deviceId;
        await this.storage.putManifest(this.localManifest);
        await this.history.record(this.localManifest.files);
      }
      this.log.info(`push: done, ${pushed}/${changes.length} succeeded`);
    } catch (e: any) {
      this.log.notice(`Thoth push failed: ${e.name}: ${e.message}`, 10000);
      this.log.error("push() threw", e);
    } finally {
      this.syncing = false;
      if (this.pendingChanges.size > 0 || this.failedPaths.size > 0) {
        this.schedulePush();
      }
    }
  }

  private async buildLocalManifest(): Promise<void> {
    const files = this.vault.getFiles();
    this.log.info(`buildLocalManifest: vault.getFiles() returned ${files.length} files`);

    const cached = this.history.files;
    let skipped = 0;
    let reused = 0;
    let hashed = 0;

    for (const file of files) {
      if (file.path.startsWith(".") || file.path.startsWith("_thoth")) {
        skipped++;
        continue;
      }

      const prev = cached[file.path];
      if (prev && prev.mtime === file.stat.mtime && prev.size === file.stat.size) {
        this.localManifest.files[file.path] = prev;
        reused++;
      } else {
        const { hash } = await this.readAndHash(file);
        this.localManifest.files[file.path] = {
          hash,
          mtime: file.stat.mtime,
          size: file.stat.size,
        };
        hashed++;
      }
    }
    this.log.info(`buildLocalManifest: ${reused} cached, ${hashed} hashed, ${skipped} skipped`);
  }

  private async ensureFolder(path: string): Promise<void> {
    const parts = path.split("/");
    parts.pop();
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

  private async readAndHash(file: TFile): Promise<{ content: ArrayBuffer; hash: string }> {
    const content = await this.vault.readBinary(file);
    const hash = await this.hashBytes(content);
    return { content, hash };
  }

  private async hashBytes(data: ArrayBuffer): Promise<string> {
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  onFileChange(path: string): void {
    if (this.pulling) return;
    if (path.startsWith(".") || path.startsWith("_thoth")) return;
    this.pendingChanges.add(path);
    this.schedulePush();
  }

  onFileDelete(path: string): void {
    if (this.pulling) return;
    if (path.startsWith(".") || path.startsWith("_thoth")) return;
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
}
