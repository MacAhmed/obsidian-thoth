import { describe, it, expect } from "vitest";
import { computeActions, ComputeOptions } from "../src/sync";
import type { FileEntry } from "../src/storage";

function entry(hash: string, mtime = 1000): FileEntry {
  return { hash, mtime, size: 100 };
}

function deleted(hash: string): FileEntry {
  return { hash, mtime: 1000, size: 0, deleted: true };
}

describe("computeActions", () => {
  it("returns empty when all three match", () => {
    const files = { "a.md": entry("aaa") };
    const actions = computeActions(files, files, files);
    expect(actions).toEqual([]);
  });

  it("pushes new local file (not in remote or history)", () => {
    const actions = computeActions(
      { "new.md": entry("aaa") },
      {},
      {}
    );
    expect(actions).toEqual([{ type: "push", path: "new.md" }]);
  });

  it("pulls new remote file (not in local or history)", () => {
    const remote = { "new.md": entry("bbb") };
    const actions = computeActions({}, remote, {});
    expect(actions).toEqual([{ type: "pull", path: "new.md", entry: remote["new.md"] }]);
  });

  it("deletes remote when file deleted locally and remote unchanged", () => {
    const prev = { "a.md": entry("aaa") };
    const remote = { "a.md": entry("aaa") };
    const actions = computeActions({}, remote, prev);
    expect(actions).toEqual([{ type: "deleteRemote", path: "a.md" }]);
  });

  it("pulls remote when file deleted locally but remote changed", () => {
    const prev = { "a.md": entry("aaa") };
    const remote = { "a.md": entry("bbb") };
    const actions = computeActions({}, remote, prev);
    expect(actions).toEqual([{ type: "pull", path: "a.md", entry: remote["a.md"] }]);
  });

  it("deletes local when remote has explicit delete marker and local unchanged", () => {
    const prev = { "a.md": entry("aaa") };
    const local = { "a.md": entry("aaa") };
    const remote = { "a.md": deleted("aaa") };
    const actions = computeActions(local, remote, prev);
    expect(actions).toEqual([{ type: "deleteLocal", path: "a.md" }]);
  });

  it("pushes when remote has explicit delete marker but local changed", () => {
    const prev = { "a.md": entry("aaa") };
    const local = { "a.md": entry("bbb") };
    const remote = { "a.md": deleted("aaa") };
    const actions = computeActions(local, remote, prev);
    expect(actions).toEqual([{ type: "push", path: "a.md" }]);
  });

  it("pushes when file absent from remote but in history (not a deletion)", () => {
    const prev = { "a.md": entry("aaa") };
    const local = { "a.md": entry("aaa") };
    const actions = computeActions(local, {}, prev);
    expect(actions).toEqual([{ type: "push", path: "a.md" }]);
  });

  it("does nothing when both deleted", () => {
    const prev = { "a.md": entry("aaa") };
    const actions = computeActions({}, {}, prev);
    expect(actions).toEqual([]);
  });

  it("pulls when remote modified and local unchanged", () => {
    const prev = { "a.md": entry("aaa") };
    const local = { "a.md": entry("aaa") };
    const remote = { "a.md": entry("bbb") };
    const actions = computeActions(local, remote, prev);
    expect(actions).toEqual([{ type: "pull", path: "a.md", entry: remote["a.md"] }]);
  });

  it("pushes when local modified and remote unchanged", () => {
    const prev = { "a.md": entry("aaa") };
    const local = { "a.md": entry("bbb") };
    const remote = { "a.md": entry("aaa") };
    const actions = computeActions(local, remote, prev);
    expect(actions).toEqual([{ type: "push", path: "a.md" }]);
  });

  it("conflicts when both modified differently", () => {
    const prev = { "a.md": entry("aaa") };
    const local = { "a.md": entry("bbb") };
    const remote = { "a.md": entry("ccc") };
    const actions = computeActions(local, remote, prev);
    expect(actions).toEqual([{ type: "conflict", path: "a.md", entry: remote["a.md"] }]);
  });

  it("uses mtime fallback when no history exists — local newer wins", () => {
    const local = { "a.md": entry("aaa", 2000) };
    const remote = { "a.md": entry("bbb", 1000) };
    const actions = computeActions(local, remote, {});
    expect(actions).toEqual([{ type: "push", path: "a.md" }]);
  });

  it("uses mtime fallback when no history exists — remote newer wins", () => {
    const local = { "a.md": entry("aaa", 1000) };
    const remote = { "a.md": entry("bbb", 2000) };
    const actions = computeActions(local, remote, {});
    expect(actions).toEqual([{ type: "pull", path: "a.md", entry: remote["a.md"] }]);
  });

  it("uses mtime fallback — local wins on tie", () => {
    const local = { "a.md": entry("aaa", 1000) };
    const remote = { "a.md": entry("bbb", 1000) };
    const actions = computeActions(local, remote, {});
    expect(actions).toEqual([{ type: "push", path: "a.md" }]);
  });

  it("handles multiple files independently", () => {
    const prev = { "a.md": entry("aaa"), "b.md": entry("bbb") };
    const local = { "a.md": entry("aaa"), "c.md": entry("ccc") };
    const remote = { "a.md": entry("xxx"), "b.md": entry("bbb") };
    const actions = computeActions(local, remote, prev);

    const types = actions.map(a => `${a.type}:${a.path}`).sort();
    expect(types).toEqual([
      "deleteRemote:b.md",
      "pull:a.md",
      "push:c.md",
    ]);
  });

  it("skips files marked as deleted in local manifest", () => {
    const local = { "a.md": deleted("aaa") };
    const remote = { "a.md": entry("aaa") };
    const prev = { "a.md": entry("aaa") };
    const actions = computeActions(local, remote, prev);
    expect(actions).toEqual([{ type: "deleteRemote", path: "a.md" }]);
  });

  it("deletes local when remote marks file as deleted and local unchanged", () => {
    const local = { "a.md": entry("aaa") };
    const remote = { "a.md": deleted("aaa") };
    const prev = { "a.md": entry("aaa") };
    const actions = computeActions(local, remote, prev);
    expect(actions).toEqual([{ type: "deleteLocal", path: "a.md" }]);
  });

  it("pushes when remote marks file as deleted but local changed", () => {
    const local = { "a.md": entry("bbb") };
    const remote = { "a.md": deleted("aaa") };
    const prev = { "a.md": entry("aaa") };
    const actions = computeActions(local, remote, prev);
    expect(actions).toEqual([{ type: "push", path: "a.md" }]);
  });

  it("deletes remote when local explicitly deleted but no history (rename scenario)", () => {
    const local = { "old.md": deleted("") };
    const remote = { "old.md": entry("aaa") };
    const actions = computeActions(local, remote, {});
    expect(actions).toEqual([{ type: "deleteRemote", path: "old.md" }]);
  });

  it("handles rename as delete-old + push-new without pulling old back", () => {
    const local = { "old.md": deleted(""), "new.md": entry("aaa") };
    const remote = { "old.md": entry("aaa") };
    const actions = computeActions(local, remote, {});
    const types = actions.map(a => `${a.type}:${a.path}`).sort();
    expect(types).toEqual(["deleteRemote:old.md", "push:new.md"]);
  });

  it("deletes local when remote is newer from another device and file absent from remote", () => {
    const prev = { "old.md": entry("aaa") };
    const local = { "old.md": entry("aaa") };
    const remote = {};
    const opts: ComputeOptions = {
      remoteUpdatedAt: 5000,
      lastSyncedAt: 3000,
      remoteDeviceId: "desktop",
      localDeviceId: "mobile",
    };
    const actions = computeActions(local, remote, prev, opts);
    expect(actions).toEqual([{ type: "deleteLocal", path: "old.md" }]);
  });

  it("pushes when remote is older (file absent = race, not deletion)", () => {
    const prev = { "a.md": entry("aaa") };
    const local = { "a.md": entry("aaa") };
    const remote = {};
    const opts: ComputeOptions = {
      remoteUpdatedAt: 2000,
      lastSyncedAt: 3000,
      remoteDeviceId: "desktop",
      localDeviceId: "mobile",
    };
    const actions = computeActions(local, remote, prev, opts);
    expect(actions).toEqual([{ type: "push", path: "a.md" }]);
  });

  it("pushes when remote is newer but same device (local changes not yet pushed)", () => {
    const prev = { "a.md": entry("aaa") };
    const local = { "a.md": entry("aaa") };
    const remote = {};
    const opts: ComputeOptions = {
      remoteUpdatedAt: 5000,
      lastSyncedAt: 3000,
      remoteDeviceId: "mobile",
      localDeviceId: "mobile",
    };
    const actions = computeActions(local, remote, prev, opts);
    expect(actions).toEqual([{ type: "push", path: "a.md" }]);
  });

  it("mobile receives bulk rename: deletes old paths, pulls new ones", () => {
    const prev = { "old_1.md": entry("aaa"), "old_2.md": entry("bbb") };
    const local = { "old_1.md": entry("aaa"), "old_2.md": entry("bbb") };
    const remote = { "new_1.md": entry("aaa"), "new_2.md": entry("bbb") };
    const opts: ComputeOptions = {
      remoteUpdatedAt: 5000,
      lastSyncedAt: 3000,
      remoteDeviceId: "desktop",
      localDeviceId: "mobile",
    };
    const actions = computeActions(local, remote, prev, opts);
    const types = actions.map(a => `${a.type}:${a.path}`).sort();
    expect(types).toEqual([
      "deleteLocal:old_1.md",
      "deleteLocal:old_2.md",
      "pull:new_1.md",
      "pull:new_2.md",
    ]);
  });
});
