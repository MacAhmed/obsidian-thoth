import { App, PluginSettingTab, Setting } from "obsidian";
import type ThothPlugin from "./main";

export interface ThothSettings {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
  pollInterval: number;
  deviceId: string;
}

export const DEFAULT_SETTINGS: ThothSettings = {
  endpoint: "",
  region: "auto",
  accessKey: "",
  secretKey: "",
  bucket: "",
  pollInterval: 5,
  deviceId: crypto.randomUUID().slice(0, 8),
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
        text.setValue(this.plugin.settings.endpoint).onChange(async (value) => {
          this.plugin.settings.endpoint = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Region")
      .addText((text) =>
        text.setValue(this.plugin.settings.region).onChange(async (value) => {
          this.plugin.settings.region = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Access Key")
      .addText((text) =>
        text.setValue(this.plugin.settings.accessKey).onChange(async (value) => {
          this.plugin.settings.accessKey = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Secret Key")
      .addText((text) => {
        text.inputEl.type = "password";
        text.setValue(this.plugin.settings.secretKey).onChange(async (value) => {
          this.plugin.settings.secretKey = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Bucket")
      .addText((text) =>
        text.setValue(this.plugin.settings.bucket).onChange(async (value) => {
          this.plugin.settings.bucket = value;
          await this.plugin.saveSettings();
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
          .onChange(async (value) => {
            this.plugin.settings.pollInterval = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Device ID")
      .setDesc("Unique identifier for this device")
      .addText((text) =>
        text.setValue(this.plugin.settings.deviceId).onChange(async (value) => {
          this.plugin.settings.deviceId = value;
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
  }
}
