/**
 * Cleans corrupted op chunks from R2.
 *
 * Usage:
 *   R2_ENDPOINT=... R2_ACCESS_KEY=... R2_SECRET_KEY=... R2_BUCKET=... \
 *     node scripts/clean-r2-ops.mjs [--dry-run]
 *
 * What it does:
 * 1. Downloads all op chunks and builds a view of current remote state
 * 2. Flags ops that are corrupt:
 *    - create ops for .conflict-* paths (should never be synced)
 *    - create ops for paths that already exist under a different UUID earlier
 *      in the log (duplicate UUID from reconcile spiral)
 * 3. Rewrites affected chunks to remove the flagged ops
 * 4. Rewinds head.json to the last clean seq
 *
 * Safe to run multiple times — idempotent.
 * Always prints a dry-run diff before making any changes unless --dry-run is omitted.
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const DRY_RUN = process.argv.includes("--dry-run");

const client = new S3Client({
  endpoint: process.env.R2_ENDPOINT,
  region: "auto",
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY, secretAccessKey: process.env.R2_SECRET_KEY },
});
const BUCKET = process.env.R2_BUCKET;

async function listChunks() {
  const keys = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "ops/", ContinuationToken: token }));
    for (const obj of res.Contents || []) keys.push(obj.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys.sort();
}

async function readChunk(key) {
  const res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const text = await res.Body.transformToString();
  return text.trim() ? text.trim().split("\n").map(l => JSON.parse(l)) : [];
}

async function writeChunk(key, ops) {
  const body = ops.map(o => JSON.stringify(o)).join("\n");
  await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }));
}

async function writeHead(seq, chunk) {
  const body = JSON.stringify({ version: 2, seq, chunk });
  await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: "head.json", Body: body }));
}

async function main() {
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}\n`);

  const chunks = await listChunks();
  console.log(`Found ${chunks.length} chunks\n`);

  // Build a view of all ops in order, tracking which paths we've seen with which UUID
  const seenPaths = new Map(); // path → first fileId that created it
  const allChunks = []; // { key, ops, cleanOps }

  for (const key of chunks) {
    const ops = await readChunk(key);
    const cleanOps = [];
    const removed = [];

    for (const op of ops) {
      let reason = null;

      if (op.type === "create") {
        // Flag: conflict files should never be synced
        if (op.path && op.path.includes(".conflict-")) {
          reason = `conflict file path: ${op.path}`;
        }
        // Flag: path already created under a different UUID
        else if (op.path && seenPaths.has(op.path) && seenPaths.get(op.path) !== op.fileId) {
          reason = `duplicate create for path already owned by ${seenPaths.get(op.path).slice(0, 8)}: ${op.path}`;
        }
        else if (op.path) {
          seenPaths.set(op.path, op.fileId);
        }
      } else if (op.path && !seenPaths.has(op.path)) {
        // For non-create ops, register the path from the fileId if we haven't seen it
        // (this handles renames etc. — we don't flag these)
      }

      if (reason) {
        removed.push({ seq: op.seq, reason });
      } else {
        cleanOps.push(op);
      }
    }

    allChunks.push({ key, ops, cleanOps, removed });
  }

  // Report
  const dirtyChunks = allChunks.filter(c => c.removed.length > 0);
  if (dirtyChunks.length === 0) {
    console.log("No corrupt ops found — nothing to do.");
    return;
  }

  console.log(`Found ${dirtyChunks.length} chunk(s) with corrupt ops:\n`);
  for (const { key, removed } of dirtyChunks) {
    console.log(`  ${key}:`);
    for (const { seq, reason } of removed) {
      console.log(`    seq=${seq}: REMOVE — ${reason}`);
    }
  }

  // Find new head seq = last clean op across all chunks
  let lastCleanSeq = 0;
  let lastCleanChunk = "";
  for (const { key, cleanOps } of allChunks) {
    if (cleanOps.length > 0) {
      lastCleanSeq = cleanOps[cleanOps.length - 1].seq;
      lastCleanChunk = key;
    }
  }

  console.log(`\nNew head: seq=${lastCleanSeq} chunk=${lastCleanChunk}`);

  if (DRY_RUN) {
    console.log("\nDry run — no changes made. Re-run without --dry-run to apply.");
    return;
  }

  // Rewrite dirty chunks
  for (const { key, cleanOps, removed } of dirtyChunks) {
    if (cleanOps.length === 0) {
      console.log(`Skipping empty chunk ${key} (all ops removed — leaving as-is, will be ignored by reader)`);
      continue;
    }
    await writeChunk(key, cleanOps);
    console.log(`Rewrote ${key} (removed ${removed.length} ops)`);
  }

  // Rewind head
  await writeHead(lastCleanSeq, lastCleanChunk);
  console.log(`Head rewound to seq=${lastCleanSeq}`);

  console.log("\nDone. Reload the plugin on all devices.");
}

main().catch(err => { console.error(err); process.exit(1); });
