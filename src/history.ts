import { Plugin } from "obsidian";
import type { FileEntry } from "./storage";

const HISTORY_KEY = "thoth-sync-history";

export interface SyncHistory {
  files: Record<string, FileEntry>;
  syncedAt: number;
}

export class History {
  private plugin: Plugin;
  private data: SyncHistory;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    this.data = { files: {}, syncedAt: 0 };
  }

  async load(): Promise<void> {
    const saved = await this.plugin.loadData();
    if (saved?.[HISTORY_KEY]) {
      this.data = saved[HISTORY_KEY];
    }
  }

  async save(): Promise<void> {
    const existing = (await this.plugin.loadData()) || {};
    existing[HISTORY_KEY] = this.data;
    await this.plugin.saveData(existing);
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
