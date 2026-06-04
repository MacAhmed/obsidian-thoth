import DiffMatchPatch from "diff-match-patch";

const dmp = new DiffMatchPatch();

export interface MergeResult {
  success: boolean;
  merged: string;
}

export function threeWayMerge(base: string, local: string, remote: string): MergeResult {
  const patches = dmp.patch_make(base, remote);
  const [merged, results] = dmp.patch_apply(patches, local);
  const success = results.every((r) => r);
  return { success, merged };
}
