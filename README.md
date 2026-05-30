# Thoth

Lightweight vault sync for Obsidian via S3-compatible object storage (Cloudflare R2, AWS S3, MinIO, etc).

## Features

- **Three-way sync** — detects offline deletions, modifications, and conflicts using local sync history
- **Parallel transfers** — 20 concurrent uploads/downloads for fast initial sync
- **Mobile support** — works on iOS and Android via Obsidian mobile
- **Conflict handling** — both versions kept, remote copy saved as `.conflict-{device}.md`
- **Fast startup** — caches file hashes, only rehashes files that changed since last sync
- **Modular storage backend** — S3 interface, easy to add new backends

## Setup

1. Create an S3-compatible bucket (e.g., Cloudflare R2)
2. Install Thoth in Obsidian
3. Settings → Thoth Sync → enter endpoint, access key, secret key, bucket name
4. Hit "Test" to verify connection
5. Sync starts automatically

## How it works

On each sync, Thoth compares three states:

- **Local** — current vault files
- **Remote** — manifest stored in the bucket
- **History** — snapshot from last successful sync

This three-way comparison determines the correct action for each file (push, pull, delete, or flag conflict) without requiring real-time coordination between devices.

## Commands

- `Thoth: Push changes now` — force push pending changes
- `Thoth: Pull changes now` — force pull from remote

Both are also available as ribbon icons.

## Transferring settings between devices

In Settings → Thoth Sync:

- **Show QR** — displays a QR code with your connection settings. Scan on your phone to get the encoded string.
- **Copy** — copies the encoded settings string to clipboard for manual transfer (e.g., via messaging app).
- **Import** — on the receiving device, paste the settings string to auto-fill endpoint, keys, bucket, and region.

Device ID is not transferred — each device generates its own unique ID.

## Supported backends

- Cloudflare R2
- AWS S3
- Any S3-compatible storage (MinIO, Backblaze B2, etc.)

## Requirements

- Obsidian 1.0.0+
- An S3-compatible storage bucket with API credentials
