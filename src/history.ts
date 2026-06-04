import { Vault, TFile } from "obsidian";
import type { FileEntry } from "./storage";

const HISTORY_PATH = "_thoth-history.json";

export interface SyncHistory {
  files: Record<string, FileEntry>;
  syncedAt: number;
}

export class History {
  private vault: Vault;
  private data: SyncHistory;
  private saving: Promise<void> = Promise.resolve();

  constructor(vault: Vault) {
    this.vault = vault;
    this.data = { files: {}, syncedAt: 0 };
  }

  async load(): Promise<void> {
    try {
      const file = this.vault.getAbstractFileByPath(HISTORY_PATH);
      if (!(file instanceof TFile)) return;
      const text = await this.vault.read(file);
      this.data = JSON.parse(text);
    } catch {
      // Missing or corrupt — start fresh
    }
  }

  private async save(): Promise<void> {
    this.saving = this.saving.then(async () => {
      const text = JSON.stringify(this.data);
      try {
        const file = this.vault.getAbstractFileByPath(HISTORY_PATH);
        if (file instanceof TFile) {
          await this.vault.modify(file, text);
        } else {
          await this.vault.create(HISTORY_PATH, text);
        }
      } catch {
        // Non-critical — will retry on next record()
      }
    });
    await this.saving;
  }

  get files(): Record<string, FileEntry> {
    return this.data.files;
  }

  get syncedAt(): number {
    return this.data.syncedAt;
  }

  async record(files: Record<string, FileEntry>): Promise<void> {
    this.data.files = { ...files };
    this.data.syncedAt = Date.now();
    await this.save();
  }

  getEntry(path: string): FileEntry | undefined {
    return this.data.files[path];
  }
}
