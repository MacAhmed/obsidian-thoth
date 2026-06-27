export type Op =
  | CreateOp
  | ModifyOp
  | DeleteOp
  | RenameOp;

export interface CreateOp {
  seq: number;
  device: string;
  ts: number;
  type: "create";
  fileId: string;
  path: string;
  hash: string;
  size: number;
}

export interface ModifyOp {
  seq: number;
  device: string;
  ts: number;
  type: "modify";
  fileId: string;
  hash: string;
  previousHash: string;
  size: number;
  basedOnSeq: number;
}

export interface DeleteOp {
  seq: number;
  device: string;
  ts: number;
  type: "delete";
  fileId: string;
  basedOnSeq: number;
}

export interface RenameOp {
  seq: number;
  device: string;
  ts: number;
  type: "rename";
  fileId: string;
  oldPath: string;
  newPath: string;
  basedOnSeq: number;
}

export interface Head {
  version: number;
  seq: number;
  chunk: string;
}

export interface Checkpoint {
  seq: number;
  ts: number;
  files: Record<string, CheckpointFile>;
  tombstones: Record<string, Tombstone>;
}

export interface CheckpointFile {
  path: string;
  hash: string;
  size: number;
}

export interface Tombstone {
  deletedAt: number;
  byDevice: string;
  atSeq: number;
}

export interface RegistryEntry {
  path: string;
  hash: string;
}

export interface LocalState {
  version: number;
  deviceId: string;
  lastSeq: number;
  outbox: Op[];
  registry: Record<string, RegistryEntry>;
}
