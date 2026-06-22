import { Vault, TFile } from "obsidian";
import type { FileManager } from "obsidian";
import { Storage, Manifest, FileEntry } from "./storage";
import { History } from "./history";
import { Logger } from "./logger";
import { threeWayMerge } from "./merge";

interface SyncError {
  name: string;
  message: string;
  $metadata?: Record<string, unknown>;
}

export type Action =
  | { type: "push"; path: string }
  | { type: "pull"; path: string; entry: FileEntry }
  | { type: "deleteLocal"; path: string }
  | { type: "deleteRemote"; path: string }
  | { type: "conflict"; path: string; entry: FileEntry };

export interface ComputeOptions {
  remoteUpdatedAt?: number;
  lastSyncedAt?: number;
  remoteDeviceId?: string;
  localDeviceId?: string;
}

export function computeActions(
  localFiles: Record<string, FileEntry>,
  remoteFiles: Record<string, FileEntry>,
  historyFiles: Record<string, FileEntry>,
  options: ComputeOptions = {}
): Action[] {
  const remoteIsNewer = !!(
    options.remoteUpdatedAt &&
    options.lastSyncedAt &&
    options.remoteDeviceId &&
    options.localDeviceId &&
    options.remoteDeviceId !== options.localDeviceId &&
    options.remoteUpdatedAt > options.lastSyncedAt
  );
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
      if (local?.deleted) {
        actions.push({ type: "deleteRemote", path });
      } else {
        actions.push({ type: "pull", path, entry: remoteEntry });
      }
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
      if (remoteEntry?.deleted || remoteIsNewer) {
        if (local.hash === prev.hash) {
          actions.push({ type: "deleteLocal", path });
        } else {
          actions.push({ type: "push", path });
        }
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
  private fileManager: FileManager;
  private storage: Storage;
  private history: History;
  private log: Logger;
  private deviceId: string;
  private mergeStrategy: "auto-merge" | "conflict-file";
  private localManifest: Manifest;
  private pendingChanges: Set<string> = new Set();
  private failedPaths: Set<string> = new Set();
  private pulledPaths: Set<string> = new Set();
  private debounceTimer: number | null = null;
  private syncing = false;
  private pulling = false;

  constructor(vault: Vault, fileManager: FileManager, storage: Storage, history: History, deviceId: string, logger: Logger, mergeStrategy: "auto-merge" | "conflict-file") {
    this.vault = vault;
    this.fileManager = fileManager;
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
    this.log.info("initialize: starting");
    try {
      await this.buildLocalManifest();
      const remote = await this.storage.getManifest();
      const localCount = Object.keys(this.localManifest.files).length;
      const remoteCount = remote ? Object.keys(remote.files).length : 0;
      const historyCount = Object.keys(this.history.files).length;

      this.log.info(`initialize: local=${localCount}, remote=${remoteCount}, history=${historyCount}`);

      if (localCount > 0 && remoteCount === 0 && historyCount === 0) {
        await this.pushAll();
      } else if (remoteCount > 0 || historyCount > 0) {
        await this.sync(remote);
      } else {
        this.log.info("Nothing to sync — all empty");
      }
    } catch (e: unknown) {
      const err = e as SyncError;
      this.log.notice(`Thoth init failed: ${err.name}: ${err.message}`, 10000);
      this.log.error("initialize() threw", err);
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
        } catch (e: unknown) {
          failed++;
          this.log.error(`pushAll: failed on ${path}`, e as SyncError);
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
      this.history.files,
      {
        remoteUpdatedAt: remote?.updatedAt,
        lastSyncedAt: this.history.syncedAt,
        remoteDeviceId: remote?.deviceId,
        localDeviceId: this.deviceId,
      }
    );
  }

  async sync(remote: Manifest | null): Promise<void> {
    if (this.syncing) {
      this.log.info("sync: already in progress, skipping");
      return;
    }
    this.syncing = true;
    this.pulling = true;
    this.log.info("sync: starting three-way comparison");

    let actions: Action[] = [];
    try {
      if (!remote) remote = await this.storage.getManifest();
      this.log.info(`sync: remote manifest has ${remote ? Object.keys(remote.files).length : 0} files, deviceId=${remote?.deviceId || "none"}`);

      // Update manifest with pending local changes before computing actions
      for (const path of this.pendingChanges) {
        const file = this.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          const existing = this.localManifest.files[path];
          // Re-hash if new or if mtime changed (file was modified)
          if (!existing || existing.mtime !== file.stat.mtime || existing.size !== file.stat.size) {
            const { hash } = await this.readAndHash(file);
            this.localManifest.files[path] = {
              hash,
              mtime: file.stat.mtime,
              size: file.stat.size,
            };
          }
        }
      }

      actions = this.computeActions(remote);
      const pushes = actions.filter(a => a.type === "push");
      const pulls = actions.filter(a => a.type === "pull") as { type: "pull"; path: string; entry: FileEntry }[];
      const deleteLocals = actions.filter(a => a.type === "deleteLocal");
      const deleteRemotes = actions.filter(a => a.type === "deleteRemote");
      const conflicts = actions.filter(a => a.type === "conflict") as { type: "conflict"; path: string; entry: FileEntry }[];

      this.log.info(`sync: ${pushes.length} push, ${pulls.length} pull, ${deleteLocals.length} deleteLocal, ${deleteRemotes.length} deleteRemote, ${conflicts.length} conflicts`);

      for (const a of deleteLocals) {
        const local = this.localManifest.files[a.path];
        const prev = this.history.files[a.path];
        const rem = remote?.files?.[a.path];
        this.log.info(`sync: deleteLocal ${a.path} | local.hash=${local?.hash?.slice(0, 8)} prev.hash=${prev?.hash?.slice(0, 8)} remote=${rem ? `hash=${rem.hash?.slice(0, 8)} deleted=${rem.deleted}` : "MISSING"} | pending=${this.pendingChanges.has(a.path)}`);
      }

      for (const a of pulls) {
        const local = this.localManifest.files[a.path];
        const prev = this.history.files[a.path];
        this.log.info(`sync: pull ${a.path} | local=${local ? `hash=${local.hash?.slice(0, 8)}` : "MISSING"} prev=${prev ? `hash=${prev.hash?.slice(0, 8)}` : "MISSING"} remote.hash=${a.entry.hash?.slice(0, 8)}`);
      }

      if (actions.length === 0) {
        this.log.info("sync: nothing to do");
        return;
      }

      const CONCURRENCY = 20;

      // Pull files (parallel download, sequential write)
      for (let i = 0; i < pulls.length; i += CONCURRENCY) {
        const batch = pulls.slice(i, i + CONCURRENCY);
        const results = await Promise.all(
          batch.map(async ({ path }) => {
            try {
              return { path, data: await this.storage.getFile(path) };
            } catch (e: unknown) {
              this.log.error(`sync: download failed ${path}`, e as SyncError);
              return { path, data: null };
            }
          })
        );

        for (const { path, data } of results) {
          if (!data) continue;
          this.pulledPaths.add(path);
          const existing = this.vault.getAbstractFileByPath(path);
          if (existing instanceof TFile) {
            await this.vault.modifyBinary(existing, data);
          } else {
            await this.ensureFolder(path);
            await this.vault.createBinary(path, data);
          }
          const written = this.vault.getAbstractFileByPath(path);
          const action = batch.find(b => b.path === path);
          if (action && written instanceof TFile) {
            this.localManifest.files[path] = {
              hash: action.entry.hash,
              mtime: written.stat.mtime,
              size: written.stat.size,
            };
          } else if (action) {
            this.localManifest.files[path] = action.entry;
          }
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
          } catch (e: unknown) {
            this.log.error(`sync: upload failed ${path}`, e as SyncError);
          }
        }));
      }

      // Delete local files (skip if user has pending changes)
      for (const { path } of deleteLocals) {
        if (this.pendingChanges.has(path)) {
          this.log.info(`sync: skipping deleteLocal ${path} — has pending changes`);
          continue;
        }
        const file = this.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          await this.fileManager.trashFile(file);
          this.log.info(`sync: deleted local ${path}`);
        }
        this.localManifest.files[path] = {
          hash: "",
          mtime: Date.now(),
          size: 0,
          deleted: true,
        };
      }

      // Delete remote files
      for (const { path } of deleteRemotes) {
        await this.storage.deleteFile(path);
        this.log.info(`sync: deleted remote ${path}`);
        this.localManifest.files[path] = {
          hash: "",
          mtime: Date.now(),
          size: 0,
          deleted: true,
        };
      }

      // Handle conflicts — attempt three-way merge for markdown, fall back to conflict file
      for (const { path } of conflicts) {
        const isMarkdown = path.endsWith(".md");
        const baseHash = this.history.files[path]?.hash;
        let remoteData: ArrayBuffer | null = null;

        if (isMarkdown && this.mergeStrategy === "auto-merge" && baseHash) {
          try {
            const [rd, baseData] = await Promise.all([
              this.storage.getFile(path),
              this.storage.getBlob(baseHash),
            ]);
            remoteData = rd;

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
          } catch (e: unknown) {
            this.log.error(`sync: merge error for ${path}`, e as SyncError);
            this.log.notice(`Thoth: merge failed for ${path}, created conflict file`);
          }
        }

        // Fallback: create conflict file
        try {
          const data = remoteData || await this.storage.getFile(path);
          if (!data) continue;
          const ext = path.lastIndexOf(".") > -1 ? path.slice(path.lastIndexOf(".")) : "";
          const stem = path.slice(0, path.length - ext.length);
          const conflictPath = `${stem}.conflict-${remote?.deviceId || "remote"}${ext}`;
          await this.ensureFolder(conflictPath);
          await this.vault.createBinary(conflictPath, data);
          this.log.info(`sync: conflict saved as ${conflictPath}`);
        } catch (e: unknown) {
          this.log.error(`sync: conflict download failed ${path}`, e as SyncError);
        }
      }

      // Update manifest and history
      this.localManifest.updatedAt = Date.now();
      this.localManifest.deviceId = this.deviceId;
      await this.storage.putManifest(this.localManifest);
      await this.history.record(this.localManifest.files);

      const total = pushes.length + pulls.length + deleteLocals.length + deleteRemotes.length + conflicts.length;
      if (total > 0) {
        this.log.notice(`Thoth: synced — ↑${pushes.length} ↓${pulls.length} 🗑${deleteLocals.length + deleteRemotes.length} ⚠${conflicts.length}`);
      }
    } catch (e: unknown) {
      const err = e as SyncError;
      this.log.notice(`Thoth sync failed: ${err.name}: ${err.message}`, 10000);
      this.log.error("sync() threw", err);
    } finally {
      this.pulling = false;
      this.syncing = false;
      for (const a of actions) {
        if (a.type === "pull" || a.type === "deleteLocal" || a.type === "push" || a.type === "deleteRemote") {
          this.pendingChanges.delete(a.path);
        }
      }
    }
  }

  async pull(): Promise<void> {
    await this.sync(null);
  }

  async push(): Promise<void> {
    if (this.syncing || this.pendingChanges.size === 0) return;
    this.syncing = true;

    // Pull-before-push: incorporate remote changes before pushing ours
    try {
      const remote = await this.storage.getManifest();
      const actions = computeActions(this.localManifest.files, remote?.files || {}, this.history.files, {
        remoteUpdatedAt: remote?.updatedAt,
        lastSyncedAt: this.history.syncedAt,
        remoteDeviceId: remote?.deviceId,
        localDeviceId: this.deviceId,
      });
      const hasRemoteChanges = actions.some(a => a.type === "pull" || a.type === "deleteLocal" || a.type === "conflict");
      if (hasRemoteChanges) {
        this.syncing = false;
        await this.sync(remote);
        if (this.pendingChanges.size > 0) this.schedulePush();
        return;
      }
    } catch (e: unknown) {
      this.log.error("push: pull-before-push failed, continuing", e as SyncError);
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
            this.localManifest.files[path] = {
              hash: "",
              mtime: Date.now(),
              size: 0,
              deleted: true,
            };
          } catch (e: unknown) {
            this.log.error(`push: delete failed ${path}`, e as SyncError);
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
        } catch (e: unknown) {
          this.log.error(`push: failed ${path}`, e as SyncError);
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
    } catch (e: unknown) {
      const err = e as SyncError;
      this.log.notice(`Thoth push failed: ${err.name}: ${err.message}`, 10000);
      this.log.error("push() threw", err);
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
    if (this.pulledPaths.delete(path)) return;
    if (path.startsWith(".") || path.startsWith("_thoth")) return;
    this.pendingChanges.add(path);
    this.schedulePush();
  }

  onFileDelete(path: string): void {
    if (this.pulling) return;
    if (this.pulledPaths.delete(path)) return;
    if (path.startsWith(".") || path.startsWith("_thoth")) return;
    this.localManifest.files[path] = {
      hash: "",
      mtime: Date.now(),
      size: 0,
      deleted: true,
    };
    this.pendingChanges.add(path);
    this.schedulePush();
  }

  onFileRename(oldPath: string, newPath: string): void {
    this.onFileDelete(oldPath);
    this.onFileChange(newPath);
  }

  private schedulePush(): void {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => { void this.push(); }, 2000);
  }
}
