import { OpStorage } from "./op-storage";
import type { StorageBackend } from "./storage";
import type { Op, LocalState, RegistryEntry, Checkpoint, Head, CreateOp, ModifyOp, DeleteOp, RenameOp } from "./types";

export interface VaultAdapter {
  getFiles(): Array<{ path: string; stat: { mtime: number; size: number } }>;
  readBinary(path: string): ArrayBuffer | null | Promise<ArrayBuffer | null>;
  createBinary(path: string, data: ArrayBuffer): void | Promise<void>;
  modifyBinary(path: string, data: ArrayBuffer): void | Promise<void>;
  deletePath(path: string): void | Promise<void>;
  renamePath(oldPath: string, newPath: string): void | Promise<void>;
  exists(path: string): boolean;
  ensureFolder(path: string): void | Promise<void>;
}

export interface SyncEngineV2Config {
  backend: StorageBackend;
  vault: VaultAdapter;
  deviceId: string;
}

export class SyncEngineV2 {
  private opStorage: OpStorage;
  private vault: VaultAdapter;
  private deviceId: string;
  private state: LocalState;
  private knownHashes = new Set<string>();

  constructor(config: SyncEngineV2Config) {
    this.opStorage = new OpStorage(config.backend);
    this.vault = config.vault;
    this.deviceId = config.deviceId;
    this.state = {
      version: 2,
      deviceId: config.deviceId,
      lastSeq: 0,
      outbox: [],
      registry: {},
    };
  }

  getState(): LocalState {
    return this.state;
  }

  serialize(): string {
    return JSON.stringify(this.state);
  }

  restore(serialized: string): void {
    this.state = JSON.parse(serialized) as LocalState;
    for (const entry of Object.values(this.state.registry)) {
      this.knownHashes.add(entry.hash);
    }
  }

  async initialize(): Promise<void> {
    const headResult = await this.opStorage.getHead();
    const localFiles = this.vault.getFiles();

    if (!headResult) {
      if (localFiles.length === 0) {
        await this.opStorage.writeHead({ version: 2, seq: 0, chunk: "" }, null);
        return;
      }
      await this.initFromLocalVault(localFiles);
      return;
    }

    if (localFiles.length === 0) {
      await this.initFromRemote();
      return;
    }

    // Remote exists and local has files — reconcile by hash matching (cases 4, 5, 6)
    await this.reconcile(localFiles, headResult.head.seq);
  }

  private async reconcile(
    localFiles: Array<{ path: string; stat: { mtime: number; size: number } }>,
    headSeq: number,
  ): Promise<void> {
    // Build local hash map
    const localByHash = new Map<string, string[]>();   // hash → [path, ...]
    const localHashes = new Map<string, string>();     // path → hash
    for (const file of localFiles) {
      const content = await this.vault.readBinary(file.path);
      if (!content) continue;
      const hash = this.hashBytesSync(content);
      localHashes.set(file.path, hash);
      const existing = localByHash.get(hash) ?? [];
      existing.push(file.path);
      localByHash.set(hash, existing);
    }

    // Build remote state from checkpoint + ops
    const checkpoint = await this.opStorage.readCheckpoint();
    const remoteState = new Map<string, { path: string; hash: string }>();  // fileId → entry

    if (checkpoint) {
      for (const [fileId, entry] of Object.entries(checkpoint.files)) {
        remoteState.set(fileId, { path: entry.path, hash: entry.hash });
      }
      const ops = await this.opStorage.readOpsAfter(checkpoint.seq);
      for (const op of ops) {
        switch (op.type) {
          case "create": remoteState.set(op.fileId, { path: op.path, hash: op.hash }); break;
          case "modify": { const e = remoteState.get(op.fileId); if (e) e.hash = op.hash; break; }
          case "delete": remoteState.delete(op.fileId); break;
          case "rename": { const e = remoteState.get(op.fileId); if (e) e.path = op.newPath; break; }
        }
      }
    } else {
      // No checkpoint — replay all ops
      const ops = await this.opStorage.readOpsAfter(0);
      for (const op of ops) {
        switch (op.type) {
          case "create": remoteState.set(op.fileId, { path: op.path, hash: op.hash }); break;
          case "modify": { const e = remoteState.get(op.fileId); if (e) e.hash = op.hash; break; }
          case "delete": remoteState.delete(op.fileId); break;
          case "rename": { const e = remoteState.get(op.fileId); if (e) e.path = op.newPath; break; }
        }
      }
    }

    const unmatchedLocal = new Set(localHashes.keys());
    const unmatchedRemote = new Set(remoteState.keys());

    // Pass 1: match by hash AND path
    for (const [fileId, remote] of remoteState) {
      const localHash = localHashes.get(remote.path);
      if (localHash === remote.hash) {
        this.state.registry[fileId] = { path: remote.path, hash: remote.hash };
        this.knownHashes.add(remote.hash);
        unmatchedLocal.delete(remote.path);
        unmatchedRemote.delete(fileId);
      }
    }

    // Pass 2: match by hash only (for renamed files)
    for (const fileId of [...unmatchedRemote]) {
      const remote = remoteState.get(fileId)!;
      const candidates = (localByHash.get(remote.hash) ?? []).filter(p => unmatchedLocal.has(p));
      if (candidates.length === 0) continue;

      // Pick closest path by edit distance, fall back to first
      const localPath = candidates.length === 1
        ? candidates[0]
        : candidates.reduce((best, p) =>
            editDistance(p, remote.path) < editDistance(best, remote.path) ? p : best
          );

      // Rename local file to remote canonical path
      if (localPath !== remote.path) {
        await this.vault.ensureFolder(remote.path);
        await this.vault.renamePath(localPath, remote.path);
      }

      this.state.registry[fileId] = { path: remote.path, hash: remote.hash };
      this.knownHashes.add(remote.hash);
      unmatchedLocal.delete(localPath);
      unmatchedRemote.delete(fileId);
    }

    // Build a path→fileId map for unmatched remote entries (for conflict detection)
    const unmatchedRemoteByPath = new Map<string, string>();
    for (const fileId of unmatchedRemote) {
      unmatchedRemoteByPath.set(remoteState.get(fileId)!.path, fileId);
    }

    // Remaining unmatched local files
    for (const localPath of unmatchedLocal) {
      const localHash = localHashes.get(localPath)!;
      const conflictingRemoteId = unmatchedRemoteByPath.get(localPath);

      if (conflictingRemoteId) {
        // Same path, different hash → conflict fork
        const remote = remoteState.get(conflictingRemoteId)!;
        const blob = await this.opStorage.getBlob(remote.hash);
        if (blob) {
          const cp = this.conflictPath(localPath, "remote");
          await this.vault.ensureFolder(cp);
          await this.vault.createBinary(cp, blob);
        }
        // Local keeps its path, gets fresh UUID, will be pushed
        const content = await this.vault.readBinary(localPath);
        if (!content) continue;
        const newId = crypto.randomUUID();
        this.state.registry[newId] = { path: localPath, hash: localHash };
        this.knownHashes.add(localHash);
        const file = localFiles.find(f => f.path === localPath);
        this.state.outbox.push({
          seq: 0, device: this.deviceId, ts: Date.now(),
          type: "create", fileId: newId, path: localPath,
          hash: localHash, size: file?.stat.size ?? content.byteLength,
        } as CreateOp);
        unmatchedRemote.delete(conflictingRemoteId);
        unmatchedRemoteByPath.delete(localPath);
      } else {
        // Genuinely new local file — assign UUID, queue create op
        const content = await this.vault.readBinary(localPath);
        if (!content) continue;
        const newId = crypto.randomUUID();
        this.state.registry[newId] = { path: localPath, hash: localHash };
        this.knownHashes.add(localHash);
        const file = localFiles.find(f => f.path === localPath);
        this.state.outbox.push({
          seq: 0, device: this.deviceId, ts: Date.now(),
          type: "create", fileId: newId, path: localPath,
          hash: localHash, size: file?.stat.size ?? content.byteLength,
        } as CreateOp);
      }
    }

    // Remaining unmatched remote (not conflicting with local) → pull them down
    for (const fileId of unmatchedRemote) {
      const remote = remoteState.get(fileId)!;
      const blob = await this.opStorage.getBlob(remote.hash);
      if (!blob) continue;
      await this.vault.ensureFolder(remote.path);
      await this.vault.createBinary(remote.path, blob);
      this.state.registry[fileId] = { path: remote.path, hash: remote.hash };
      this.knownHashes.add(remote.hash);
    }

    this.state.lastSeq = headSeq;
  }

  private async initFromLocalVault(files: Array<{ path: string; stat: { mtime: number; size: number } }>): Promise<void> {
    const checkpointFiles: Checkpoint["files"] = {};

    for (const file of files) {
      const content = await this.vault.readBinary(file.path);
      if (!content) continue;

      const hash = await this.hashBytes(content);
      const fileId = crypto.randomUUID();

      this.state.registry[fileId] = { path: file.path, hash };
      checkpointFiles[fileId] = { path: file.path, hash, size: file.stat.size };
      await this.opStorage.putBlob(hash, content);
      this.knownHashes.add(hash);
    }

    const checkpoint: Checkpoint = {
      seq: 0,
      ts: Date.now(),
      files: checkpointFiles,
      tombstones: {},
    };

    await this.opStorage.writeCheckpoint(checkpoint);
    await this.opStorage.writeHead({ version: 2, seq: 0, chunk: "" }, null);
  }

  private async initFromRemote(): Promise<void> {
    const checkpoint = await this.opStorage.readCheckpoint();
    const fromSeq = checkpoint?.seq ?? -1;

    if (checkpoint) {
      for (const [fileId, entry] of Object.entries(checkpoint.files)) {
        const blob = await this.opStorage.getBlob(entry.hash);
        if (!blob) continue;
        await this.vault.ensureFolder(entry.path);
        await this.vault.createBinary(entry.path, blob);
        this.state.registry[fileId] = { path: entry.path, hash: entry.hash };
        this.knownHashes.add(entry.hash);
      }
    }

    const headResult = await this.opStorage.getHead();
    if (!headResult) return;

    const ops = await this.opStorage.readOpsAfter(fromSeq);
    for (const op of ops) {
      await this.applyRemoteOp(op);
      this.state.lastSeq = op.seq;
    }

    this.state.lastSeq = headResult.head.seq;
  }

  onFileCreate(path: string): void {
    const result = this.vault.readBinary(path);
    const content = result instanceof Promise ? null : result;
    if (!content) return;

    const hash = this.hashBytesSync(content);
    const fileId = crypto.randomUUID();

    this.state.registry[fileId] = { path, hash };
    this.knownHashes.add(hash);

    const file = this.vault.getFiles().find(f => f.path === path);
    const size = file?.stat.size ?? content.byteLength;

    const op: CreateOp = {
      seq: 0,
      device: this.deviceId,
      ts: Date.now(),
      type: "create",
      fileId,
      path,
      hash,
      size,
    };
    this.state.outbox.push(op);
  }

  async onFileCreateAsync(path: string): Promise<void> {
    const content = await this.vault.readBinary(path);
    if (!content) return;

    const hash = this.hashBytesSync(content);
    const fileId = crypto.randomUUID();

    this.state.registry[fileId] = { path, hash };
    this.knownHashes.add(hash);

    const file = this.vault.getFiles().find(f => f.path === path);
    const size = file?.stat.size ?? content.byteLength;

    const op: CreateOp = {
      seq: 0,
      device: this.deviceId,
      ts: Date.now(),
      type: "create",
      fileId,
      path,
      hash,
      size,
    };
    this.state.outbox.push(op);
  }

  onFileModify(path: string): void {
    const result = this.vault.readBinary(path);
    const content = result instanceof Promise ? null : result;
    if (!content) return;

    const fileId = this.findFileIdByPath(path);
    if (!fileId) return;

    const previousHash = this.state.registry[fileId].hash;
    const hash = this.hashBytesSync(content);

    if (hash === previousHash) return;

    this.state.registry[fileId].hash = hash;
    this.knownHashes.add(hash);

    const file = this.vault.getFiles().find(f => f.path === path);
    const size = file?.stat.size ?? content.byteLength;

    const op: ModifyOp = {
      seq: 0,
      device: this.deviceId,
      ts: Date.now(),
      type: "modify",
      fileId,
      hash,
      previousHash,
      size,
      basedOnSeq: this.state.lastSeq,
    };
    this.state.outbox.push(op);
  }

  async onFileModifyAsync(path: string): Promise<void> {
    const content = await this.vault.readBinary(path);
    if (!content) return;

    const fileId = this.findFileIdByPath(path);
    if (!fileId) return;

    const previousHash = this.state.registry[fileId].hash;
    const hash = this.hashBytesSync(content);

    if (hash === previousHash) return;

    this.state.registry[fileId].hash = hash;
    this.knownHashes.add(hash);

    const file = this.vault.getFiles().find(f => f.path === path);
    const size = file?.stat.size ?? content.byteLength;

    const op: ModifyOp = {
      seq: 0,
      device: this.deviceId,
      ts: Date.now(),
      type: "modify",
      fileId,
      hash,
      previousHash,
      size,
      basedOnSeq: this.state.lastSeq,
    };
    this.state.outbox.push(op);
  }

  onFileDelete(path: string): void {
    const fileId = this.findFileIdByPath(path);
    if (!fileId) return;

    const op: DeleteOp = {
      seq: 0,
      device: this.deviceId,
      ts: Date.now(),
      type: "delete",
      fileId,
      basedOnSeq: this.state.lastSeq,
    };
    this.state.outbox.push(op);
  }

  onFileRename(oldPath: string, newPath: string): void {
    const fileId = this.findFileIdByPath(oldPath);
    if (!fileId) return;

    this.state.registry[fileId].path = newPath;

    const op: RenameOp = {
      seq: 0,
      device: this.deviceId,
      ts: Date.now(),
      type: "rename",
      fileId,
      oldPath,
      newPath,
      basedOnSeq: this.state.lastSeq,
    };
    this.state.outbox.push(op);
  }

  async flush(): Promise<void> {
    if (this.state.outbox.length === 0) return;

    let headResult = await this.opStorage.getHead();

    if (!headResult) {
      await this.opStorage.writeHead({ version: 2, seq: 0, chunk: "" }, null);
      headResult = await this.opStorage.getHead();
      if (!headResult) return;
    }

    let currentSeq = headResult.head.seq;
    let etag = headResult.etag;

    if (currentSeq > this.state.lastSeq) {
      await this.pull();
      const refreshed = await this.opStorage.getHead();
      if (refreshed) {
        currentSeq = refreshed.head.seq;
        etag = refreshed.etag;
      }
    }

    const ops = [...this.state.outbox];
    for (let i = 0; i < ops.length; i++) {
      ops[i] = { ...ops[i], seq: currentSeq + i + 1 };
    }

    for (const op of ops) {
      if (op.type === "create" || op.type === "modify") {
        if (await this.opStorage.hasBlob(op.hash)) continue;
        const path = op.type === "create" ? op.path : this.state.registry[op.fileId]?.path ?? "";
        const content = await this.vault.readBinary(path);
        if (content) {
          await this.opStorage.putBlob(op.hash, content);
        }
      }
    }

    const startSeq = currentSeq + 1;
    const chunkKey = await this.opStorage.writeChunk(startSeq, ops, this.deviceId);

    const newSeq = currentSeq + ops.length;
    const newHead: Head = {
      version: 2,
      seq: newSeq,
      chunk: chunkKey,
    };

    const ok = await this.opStorage.writeHead(newHead, etag!);
    if (!ok) {
      const retryHead = await this.opStorage.getHead();
      if (!retryHead) return;
      await this.pull();
      const afterPull = await this.opStorage.getHead();
      if (!afterPull) return;

      const retrySeq = afterPull.head.seq;
      for (let i = 0; i < ops.length; i++) {
        ops[i] = { ...ops[i], seq: retrySeq + i + 1 };
      }
      const retryStartSeq = retrySeq + 1;
      const retryChunkKey = await this.opStorage.writeChunk(retryStartSeq, ops, this.deviceId);

      const retryNewHead: Head = {
        version: 2,
        seq: retrySeq + ops.length,
        chunk: retryChunkKey,
      };
      const retryOk = await this.opStorage.writeHead(retryNewHead, afterPull.etag);
      if (!retryOk) return;

      this.state.lastSeq = retrySeq + ops.length;
      this.state.outbox = [];
      return;
    }

    this.state.lastSeq = newSeq;
    this.state.outbox = [];
  }

  async pull(): Promise<void> {
    const headResult = await this.opStorage.getHead();
    if (!headResult) return;

    const remoteSeq = headResult.head.seq;

    // Remote seq went backwards — remote was reset. Drop our local seq tracking
    // so we can re-sync, but never auto-delete local files. User must run
    // force pull explicitly if they want local replaced.
    if (remoteSeq < this.state.lastSeq) {
      this.state.lastSeq = 0;
      this.state.registry = {};
      this.knownHashes.clear();
      await this.initFromRemote();
      return;
    }

    if (remoteSeq <= this.state.lastSeq) return;

    const ops = await this.opStorage.readOpsAfter(this.state.lastSeq);

    for (const op of ops) {
      if (op.device === this.deviceId) {
        this.state.lastSeq = op.seq;
        continue;
      }
      await this.applyRemoteOp(op);
      this.state.lastSeq = op.seq;
    }
  }

  async forceReset(): Promise<void> {
    await this.opStorage.deleteAll();
    this.state.outbox = [];
    const localFiles = this.vault.getFiles();
    if (localFiles.length === 0) {
      await this.opStorage.writeHead({ version: 2, seq: 0, chunk: "" }, null);
    } else {
      await this.initFromLocalVault(localFiles);
    }
  }

  async forcePull(): Promise<void> {
    const allFiles = this.vault.getFiles();
    for (const file of allFiles) {
      await this.vault.deletePath(file.path);
    }
    this.state.registry = {};
    this.state.outbox = [];
    this.state.lastSeq = 0;
    this.knownHashes.clear();

    const checkpoint = await this.opStorage.readCheckpoint();
    if (checkpoint) {
      await this.initFromRemote();
      return;
    }

    // No checkpoint — replay all ops from seq 0
    const ops = await this.opStorage.readOpsAfter(0);
    for (const op of ops) {
      await this.applyRemoteOp(op);
      this.state.lastSeq = op.seq;
    }
  }

  private findOutboxOpForFile(fileId: string): Op | undefined {
    for (let i = this.state.outbox.length - 1; i >= 0; i--) {
      if (this.state.outbox[i].fileId === fileId) return this.state.outbox[i];
    }
    return undefined;
  }

  private isConcurrent(remoteOp: { seq: number; basedOnSeq: number }, localOp: { basedOnSeq: number }): boolean {
    // Local didn't know about remote: local.basedOnSeq < remote.seq
    // Remote never knew about local (local is still in outbox, seq=0).
    // If local.basedOnSeq >= remote.seq, local was created after seeing remote → fast-forward.
    return localOp.basedOnSeq < remoteOp.seq;
  }

  private conflictPath(path: string, deviceId: string): string {
    const dot = path.lastIndexOf(".");
    const stem = dot > -1 ? path.slice(0, dot) : path;
    const ext = dot > -1 ? path.slice(dot) : "";
    return `${stem}.conflict-${deviceId}${ext}`;
  }

  private async applyRemoteOp(op: Op): Promise<void> {
    switch (op.type) {
      case "create": {
        const blob = await this.opStorage.getBlob(op.hash);
        if (!blob) return;
        await this.vault.ensureFolder(op.path);
        if (this.vault.exists(op.path)) {
          await this.vault.modifyBinary(op.path, blob);
        } else {
          await this.vault.createBinary(op.path, blob);
        }
        this.state.registry[op.fileId] = { path: op.path, hash: op.hash };
        this.knownHashes.add(op.hash);
        break;
      }
      case "modify": {
        const entry = this.state.registry[op.fileId];
        if (!entry) return;

        const localOp = this.findOutboxOpForFile(op.fileId);
        if (localOp && (localOp.type === "modify" || localOp.type === "create")) {
          const localBasedOnSeq = localOp.type === "modify" ? localOp.basedOnSeq : 0;
          if (this.isConcurrent(op, { basedOnSeq: localBasedOnSeq })) {
            // Both modified the same file — LWW by timestamp, conflict file for loser
            const blob = await this.opStorage.getBlob(op.hash);
            if (!blob) return;
            if (op.ts >= localOp.ts) {
              // Remote wins: save local as conflict, apply remote
              const localContent = await this.vault.readBinary(entry.path);
              if (localContent) {
                const cp = this.conflictPath(entry.path, this.deviceId);
                await this.vault.ensureFolder(cp);
                await this.vault.createBinary(cp, localContent);
              }
              await this.vault.modifyBinary(entry.path, blob);
              entry.hash = op.hash;
              this.state.outbox = this.state.outbox.filter(o => o !== localOp);
            } else {
              // Local wins: save remote as conflict file, keep local + outbox op
              const cp = this.conflictPath(entry.path, op.device);
              await this.vault.ensureFolder(cp);
              await this.vault.createBinary(cp, blob);
            }
            return;
          }
        }

        const blob = await this.opStorage.getBlob(op.hash);
        if (!blob) return;
        if (this.vault.exists(entry.path)) {
          await this.vault.modifyBinary(entry.path, blob);
        } else {
          await this.vault.ensureFolder(entry.path);
          await this.vault.createBinary(entry.path, blob);
        }
        entry.hash = op.hash;
        this.knownHashes.add(op.hash);
        break;
      }
      case "delete": {
        const entry = this.state.registry[op.fileId];
        if (!entry) return;

        const localOp = this.findOutboxOpForFile(op.fileId);
        if (localOp && (localOp.type === "modify" || localOp.type === "create")) {
          const localBasedOnSeq = localOp.type === "modify" ? localOp.basedOnSeq : 0;
          if (this.isConcurrent(op, { basedOnSeq: localBasedOnSeq })) {
            // Remote deleted, local modified — local wins, keep file, keep outbox op
            return;
          }
        }

        if (this.vault.exists(entry.path)) {
          await this.vault.deletePath(entry.path);
        }
        delete this.state.registry[op.fileId];
        break;
      }
      case "rename": {
        const entry = this.state.registry[op.fileId];
        if (!entry) return;
        if (this.vault.exists(entry.path)) {
          await this.vault.ensureFolder(op.newPath);
          await this.vault.renamePath(entry.path, op.newPath);
        }
        entry.path = op.newPath;
        break;
      }
    }
  }

  private applyOp(op: Op): void {
    switch (op.type) {
      case "create":
        this.state.registry[op.fileId] = { path: op.path, hash: op.hash };
        this.knownHashes.add(op.hash);
        break;
      case "modify": {
        const entry = this.state.registry[op.fileId];
        if (entry) { entry.hash = op.hash; this.knownHashes.add(op.hash); }
        break;
      }
      case "delete":
        delete this.state.registry[op.fileId];
        break;
      case "rename": {
        const entry = this.state.registry[op.fileId];
        if (entry) entry.path = op.newPath;
        break;
      }
    }
  }

  private findFileIdByPath(path: string): string | null {
    for (const [id, entry] of Object.entries(this.state.registry)) {
      if (entry.path === path) return id;
    }
    return null;
  }

  private hashBytesSync(data: ArrayBuffer): string {
    const arr = new Uint8Array(data);
    let hash = 0x811c9dc5;
    for (let i = 0; i < arr.length; i++) {
      hash ^= arr[i];
      hash = Math.imul(hash, 0x01000193);
    }
    const h = (hash >>> 0).toString(16).padStart(8, "0");
    const len = arr.length.toString(16).padStart(8, "0");
    return h + len;
  }

  private async hashBytes(data: ArrayBuffer): Promise<string> {
    return this.hashBytesSync(data);
  }
}

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}
