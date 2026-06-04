import { App, Modal, PluginSettingTab, Setting, Notice } from "obsidian";
import QRCode from "qrcode-generator";
import type ThothPlugin from "./main";

export interface ThothSettings {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  pollInterval: number;
  deviceId: string;
  mergeStrategy: "auto-merge" | "conflict-file";
}

export const DEFAULT_SETTINGS: ThothSettings = {
  endpoint: "",
  region: "auto",
  accessKey: "",
  secretKey: "",
  bucket: "",
  pollInterval: 5,
  deviceId: crypto.randomUUID().slice(0, 8),
  mergeStrategy: "auto-merge",
};

export class ThothSettingTab extends PluginSettingTab {
  plugin: ThothPlugin;

  constructor(app: App, plugin: ThothPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Thoth Sync" });

    new Setting(containerEl)
      .setName("Endpoint URL")
      .setDesc("S3-compatible endpoint (e.g., Cloudflare R2)")
      .addText((text) =>
        text.setValue(this.plugin.settings.endpoint).onChange((value) => {
          this.plugin.settings.endpoint = value;
        })
      );

    new Setting(containerEl)
      .setName("Region")
      .addText((text) =>
        text.setValue(this.plugin.settings.region).onChange((value) => {
          this.plugin.settings.region = value;
        })
      );

    new Setting(containerEl)
      .setName("Access Key")
      .addText((text) =>
        text.setValue(this.plugin.settings.accessKey).onChange((value) => {
          this.plugin.settings.accessKey = value;
        })
      );

    new Setting(containerEl)
      .setName("Secret Key")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.secretKey).onChange((value) => {
          this.plugin.settings.secretKey = value;
        });
      });

    new Setting(containerEl)
      .setName("Bucket")
      .addText((text) =>
        text.setValue(this.plugin.settings.bucket).onChange((value) => {
          this.plugin.settings.bucket = value;
        })
      );

    new Setting(containerEl)
      .setName("Poll interval (minutes)")
      .setDesc("How often to check for remote changes")
      .addSlider((slider) =>
        slider
          .setLimits(1, 30, 1)
          .setValue(this.plugin.settings.pollInterval)
          .setDynamicTooltip()
          .onChange((value) => {
            this.plugin.settings.pollInterval = value;
          })
      );

    new Setting(containerEl)
      .setName("Device ID")
      .setDesc("Unique identifier for this device")
      .addText((text) =>
        text.setValue(this.plugin.settings.deviceId).onChange((value) => {
          this.plugin.settings.deviceId = value;
        })
      );

    new Setting(containerEl)
      .setName("Save & Connect")
      .setDesc("Save settings and start syncing")
      .addButton((btn) =>
        btn.setButtonText("Save").setCta().onClick(async () => {
          await this.plugin.saveSettings();
          new Notice("Settings saved");
        })
      );

    new Setting(containerEl)
      .setName("Conflict resolution")
      .setDesc("How to handle files edited on multiple devices between syncs")
      .addDropdown((drop) =>
        drop
          .addOption("auto-merge", "Auto-merge (recommended)")
          .addOption("conflict-file", "Create conflict file")
          .setValue(this.plugin.settings.mergeStrategy)
          .onChange(async (value) => {
            this.plugin.settings.mergeStrategy = value as "auto-merge" | "conflict-file";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Writes, reads, and deletes a test file in the bucket")
      .addButton((btn) =>
        btn.setButtonText("Test").onClick(async () => {
          btn.setButtonText("Testing...");
          const result = await this.plugin.testConnection();
          btn.setButtonText(result.ok ? "✓ Connected" : `✗ ${result.error}`);
          setTimeout(() => btn.setButtonText("Test"), 5000);
        })
      );

    containerEl.createEl("h3", { text: "Transfer settings" });

    new Setting(containerEl)
      .setName("Export as QR code")
      .setDesc("Show a QR code to scan on another device")
      .addButton((btn) =>
        btn.setButtonText("Show QR").onClick(() => {
          new QRModal(this.app, this.plugin.settings).open();
        })
      );

    new Setting(containerEl)
      .setName("Import from text")
      .setDesc("Paste a settings string exported from another device")
      .addButton((btn) =>
        btn.setButtonText("Import").onClick(() => {
          new ImportModal(this.app, this.plugin).open();
        })
      );

    new Setting(containerEl)
      .setName("Copy settings string")
      .setDesc("Copy encoded settings to clipboard for manual transfer")
      .addButton((btn) =>
        btn.setButtonText("Copy").onClick(async () => {
          const encoded = encodeSettings(this.plugin.settings);
          await navigator.clipboard.writeText(encoded);
          new Notice("Settings copied to clipboard");
        })
      );
  }
}

export function encodeSettings(settings: ThothSettings): string {
  const payload = {
    e: settings.endpoint,
    r: settings.region,
    a: settings.accessKey,
    s: settings.secretKey,
    b: settings.bucket,
    p: settings.pollInterval,
  };
  return btoa(JSON.stringify(payload));
}

export function decodeSettings(encoded: string): Partial<ThothSettings> | null {
  try {
    const payload = JSON.parse(atob(encoded.trim()));
    return {
      endpoint: payload.e,
      region: payload.r,
      accessKey: payload.a,
      secretKey: payload.s,
      bucket: payload.b,
      pollInterval: payload.p,
    };
  } catch {
    return null;
  }
}

class QRModal extends Modal {
  private settings: ThothSettings;

  constructor(app: App, settings: ThothSettings) {
    super(app);
    this.settings = settings;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Scan on your other device" });
    contentEl.createEl("p", {
      text: "Go to Thoth settings → Import from text → paste what you get from scanning this.",
      cls: "setting-item-description",
    });

    const encoded = encodeSettings(this.settings);
    const qr = QRCode(0, "M");
    qr.addData(encoded);
    qr.make();

    const svg = qr.createSvgTag({ scalable: true });
    const container = contentEl.createDiv({ cls: "thoth-qr-container" });
    container.innerHTML = svg;
    container.style.maxWidth = "300px";
    container.style.margin = "1em auto";
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ImportModal extends Modal {
  private plugin: ThothPlugin;

  constructor(app: App, plugin: ThothPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Import settings" });
    contentEl.createEl("p", { text: "Paste the settings string from your other device:" });

    const input = contentEl.createEl("textarea", {
      attr: { rows: "4", style: "width: 100%; font-family: monospace; font-size: 12px;" },
    });

    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText("Import").setCta().onClick(async () => {
          const decoded = decodeSettings(input.value);
          if (!decoded) {
            new Notice("Invalid settings string");
            return;
          }
          Object.assign(this.plugin.settings, decoded);
          await this.plugin.saveSettings();
          new Notice("Settings imported — restart plugin to connect");
          this.close();
        })
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
