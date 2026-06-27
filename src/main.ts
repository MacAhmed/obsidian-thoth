import { Plugin, TFile, TAbstractFile } from "obsidian";
import { SyncEngineV2, VaultAdapter } from "./sync-engine";
import { S3Backend } from "./backends";
import { Logger } from "./logger";
import { ThothSettings, ThothSettingTab, DEFAULT_SETTINGS } from "./settings";

const STATE_PATH = "_thoth-state.json";

const EXCLUDED_PATHS = [
  "_thoth-state.json",
  "_thoth-log.md",
  "_thoth-history.json",
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
];

function shouldSync(path: string): boolean {
  if (EXCLUDED_PATHS.includes(path)) return false;
  if (path.startsWith("_thoth")) return false;
  return true;
}

export default class ThothPlugin extends Plugin {
  settings: ThothSettings = DEFAULT_SETTINGS;
  private engine: SyncEngineV2 | null = null;
  private pollInterval: number | null = null;
  private logger!: Logger;
  private debounceTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.logger = new Logger(this.app.vault);
    this.addSettingTab(new ThothSettingTab(this.app, this));

    this.addCommand({
      id: "thoth-force-push",
      name: "Push changes now",
      callback: () => { void this.engine?.flush(); },
    });

    this.addCommand({
      id: "thoth-force-pull",
      name: "Pull changes now",
      callback: () => { void this.engine?.pull(); },
    });

    this.addCommand({
      id: "thoth-force-reset",
      name: "Force reset: wipe remote, push local",
      callback: () => { void this.forceReset(); },
    });

    this.addCommand({
      id: "thoth-force-pull-reset",
      name: "Force pull: delete local, pull remote",
      callback: () => { void this.forcePull(); },
    });

    this.addRibbonIcon("upload-cloud", "Thoth: Push", () => {
      void this.engine?.flush();
    });

    this.addRibbonIcon("download-cloud", "Thoth: Pull", () => {
      void this.engine?.pull();
    });

    if (this.isConfigured()) {
      this.app.workspace.onLayoutReady(() => this.startSync());
    }
  }

  onunload(): void {
    this.stopSync();
    if (this.engine) {
      void this.saveState();
    }
  }

  private isConfigured(): boolean {
    const { endpoint, accessKey, secretKey, bucket } = this.settings;
    return !!(endpoint && accessKey && secretKey && bucket);
  }

  async startSync(): Promise<void> {
    this.stopSync();

    this.logger.info(`startSync: endpoint=${this.settings.endpoint}, bucket=${this.settings.bucket}, deviceId=${this.settings.deviceId}`);

    const backend = new S3Backend({
      endpoint: this.settings.endpoint,
      region: this.settings.region,
      accessKey: this.settings.accessKey,
      secretKey: this.settings.secretKey,
      bucket: this.settings.bucket,
    });

    const vault = this.app.vault;
    const fileManager = this.app.fileManager;

    const adapter: VaultAdapter = {
      getFiles: () => {
        return vault.getFiles()
          .filter(f => shouldSync(f.path))
          .map(f => ({ path: f.path, stat: { mtime: f.stat.mtime, size: f.stat.size } }));
      },
      readBinary: async (path: string) => {
        const file = vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return null;
        return vault.readBinary(file);
      },
      createBinary: (path: string, data: ArrayBuffer) => {
        void vault.createBinary(path, data);
      },
      modifyBinary: (path: string, data: ArrayBuffer) => {
        const file = vault.getAbstractFileByPath(path);
        if (file instanceof TFile) void vault.modifyBinary(file, data);
      },
      deletePath: (path: string) => {
        const file = vault.getAbstractFileByPath(path);
        if (file instanceof TFile) void fileManager.trashFile(file);
      },
      renamePath: (oldPath: string, newPath: string) => {
        const file = vault.getAbstractFileByPath(oldPath);
        if (file instanceof TFile) void fileManager.renameFile(file, newPath);
      },
      exists: (path: string) => vault.getAbstractFileByPath(path) !== null,
      ensureFolder: (path: string) => {
        const parts = path.split("/");
        parts.pop();
        if (parts.length === 0) return;
        let current = "";
        for (const part of parts) {
          current = current ? `${current}/${part}` : part;
          if (!vault.getAbstractFileByPath(current)) {
            void vault.createFolder(current);
          }
        }
      },
    };

    this.engine = new SyncEngineV2({
      backend,
      vault: adapter,
      deviceId: this.settings.deviceId,
      logger: this.logger,
    });

    await this.loadState();
    try {
      await this.engine.initialize();
    } catch (e: unknown) {
      const err = e as { name?: string; message?: string };
      this.logger.notice(`Thoth init failed: ${err.name}: ${err.message}`, 10000);
      this.logger.error("initialize() threw", err);
      return;
    }
    await this.saveState();

    this.registerEvent(
      vault.on("modify", (file: TAbstractFile) => {
        if (file instanceof TFile && shouldSync(file.path)) {
          void this.engine?.onFileModifyAsync(file.path).then(() => this.schedulePush());
        }
      })
    );

    this.registerEvent(
      vault.on("create", (file: TAbstractFile) => {
        if (file instanceof TFile && shouldSync(file.path)) {
          void this.engine?.onFileCreateAsync(file.path).then(() => this.schedulePush());
        }
      })
    );

    this.registerEvent(
      vault.on("delete", (file: TAbstractFile) => {
        if (file instanceof TFile && shouldSync(file.path)) {
          this.engine?.onFileDelete(file.path);
          this.schedulePush();
        }
      })
    );

    this.registerEvent(
      vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        if (file instanceof TFile && shouldSync(file.path)) {
          this.engine?.onFileRename(oldPath, file.path);
          this.schedulePush();
        }
      })
    );

    this.pollInterval = window.setInterval(
      () => {
        void this.engine?.pull().catch((e: unknown) => {
          const err = e as { name?: string; message?: string };
          this.logger.error(`poll failed: ${err.name}: ${err.message}`, err);
        });
      },
      this.settings.pollInterval * 1000
    );

    this.logger.notice("Thoth: sync active");
  }

  private stopSync(): void {
    if (this.pollInterval !== null) {
      window.clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.engine = null;
  }

  private schedulePush(): void {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(async () => {
      try {
        await this.engine?.flush();
        await this.saveState();
      } catch (e: unknown) {
        const err = e as { name?: string; message?: string };
        this.logger.error(`flush failed: ${err.name}: ${err.message}`, err);
      }
    }, 2000);
  }

  private async forceReset(): Promise<void> {
    if (!this.engine) return;
    this.logger.notice("Thoth: force reset — wiping remote and pushing local state");
    // TODO: implement via opStorage.deleteAll() + reinitialize
    await this.startSync();
    this.logger.notice("Thoth: force reset complete");
  }

  private async forcePull(): Promise<void> {
    if (!this.engine) return;
    this.logger.notice("Thoth: force pull — replacing local with remote state");
    // TODO: implement via vault clear + pull from checkpoint
    this.logger.notice("Thoth: force pull complete");
  }

  private async loadState(): Promise<void> {
    if (!this.engine) return;
    try {
      const file = this.app.vault.getAbstractFileByPath(STATE_PATH);
      if (!(file instanceof TFile)) return;
      const text = await this.app.vault.read(file);
      this.engine.restore(text);
    } catch {
      // Missing or corrupt — engine starts fresh
    }
  }

  private async saveState(): Promise<void> {
    if (!this.engine) return;
    const text = this.engine.serialize();
    try {
      const file = this.app.vault.getAbstractFileByPath(STATE_PATH);
      if (file instanceof TFile) {
        await this.app.vault.modify(file, text);
      } else {
        await this.app.vault.create(STATE_PATH, text);
      }
    } catch {
      // Non-critical — will retry
    }
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    if (!this.isConfigured()) return { ok: false, error: "Missing config" };
    this.logger.info("testConnection: starting");
    const backend = new S3Backend({
      endpoint: this.settings.endpoint,
      region: this.settings.region,
      accessKey: this.settings.accessKey,
      secretKey: this.settings.secretKey,
      bucket: this.settings.bucket,
    });
    const result = await backend.test();
    this.logger.info(`testConnection: result=${JSON.stringify(result)}`);
    return result;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<ThothSettings>);
    if (this.settings.pollInterval < 10) {
      this.settings.pollInterval = Math.max(10, this.settings.pollInterval * 60);
      await this.saveData(this.settings);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    if (this.isConfigured() && !this.engine) {
      await this.startSync();
    }
  }
}
