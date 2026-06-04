import { Plugin, TFile, TAbstractFile } from "obsidian";
import { Storage } from "./storage";
import { SyncEngine } from "./sync";
import { History } from "./history";
import { S3Backend } from "./backends";
import { Logger } from "./logger";
import { ThothSettings, ThothSettingTab, DEFAULT_SETTINGS } from "./settings";

export default class ThothPlugin extends Plugin {
  settings: ThothSettings = DEFAULT_SETTINGS;
  private syncEngine: SyncEngine | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private logger!: Logger;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.logger = new Logger(this.app.vault);
    this.addSettingTab(new ThothSettingTab(this.app, this));

    this.addCommand({
      id: "thoth-force-push",
      name: "Push changes now",
      callback: () => this.syncEngine?.push(),
    });

    this.addCommand({
      id: "thoth-force-pull",
      name: "Pull changes now",
      callback: () => this.syncEngine?.pull(),
    });

    this.addRibbonIcon("upload-cloud", "Thoth: Push", () => {
      this.syncEngine?.push();
    });

    this.addRibbonIcon("download-cloud", "Thoth: Pull", () => {
      this.syncEngine?.pull();
    });

    if (this.isConfigured()) {
      this.app.workspace.onLayoutReady(() => this.startSync());
    }
  }

  onunload(): void {
    this.stopSync();
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

    const storage = new Storage(backend);
    const history = new History(this.app.vault);
    await history.load();
    this.syncEngine = new SyncEngine(
      this.app.vault,
      storage,
      history,
      this.settings.deviceId,
      this.logger,
      this.settings.mergeStrategy
    );

    await this.syncEngine.initialize();

    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        if (file instanceof TFile) this.syncEngine?.onFileChange(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("create", (file: TAbstractFile) => {
        if (file instanceof TFile) this.syncEngine?.onFileChange(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", (file: TAbstractFile) => {
        if (file instanceof TFile) this.syncEngine?.onFileDelete(file.path);
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        if (file instanceof TFile) this.syncEngine?.onFileRename(oldPath, file.path);
      })
    );

    this.pollInterval = setInterval(
      () => this.syncEngine?.pull(),
      this.settings.pollInterval * 60 * 1000
    );

    this.logger.notice("Thoth: sync started");
  }

  private stopSync(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.syncEngine = null;
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
    const storage = new Storage(backend);
    const result = await storage.testConnection();
    this.logger.info(`testConnection: result=${JSON.stringify(result)}`);
    return result;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    if (this.isConfigured() && !this.syncEngine) {
      await this.startSync();
    }
  }
}
