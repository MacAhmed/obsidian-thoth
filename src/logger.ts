import { Vault, TFile, Notice } from "obsidian";

const LOG_PATH = "_thoth-log.md";
const MAX_LINES = 500;

export class Logger {
  private vault: Vault;
  private buffer: string[] = [];
  private flushTimer: number | null = null;

  constructor(vault: Vault) {
    this.vault = vault;
  }

  info(msg: string): void {
    this.write("INFO", msg);
    console.log(`[thoth] ${msg}`);
  }

  error(msg: string, err?: { name?: string; message?: string; $metadata?: Record<string, unknown> }): void {
    this.write("ERROR", msg);
    if (err) {
      this.write("ERROR", `  name=${err.name} message=${err.message}`);
      if (err.$metadata) this.write("ERROR", `  metadata=${JSON.stringify(err.$metadata)}`);
    }
    console.error(`[thoth] ${msg}`, err);
  }

  notice(msg: string, duration = 5000): void {
    new Notice(msg, duration);
    this.info(msg);
  }

  private write(level: string, msg: string): void {
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    this.buffer.push(`${ts} [${level}] ${msg}`);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = window.setTimeout(() => { void this.flush(); }, 1000);
  }

  private async flush(): Promise<void> {
    this.flushTimer = null;
    if (this.buffer.length === 0) return;

    const newLines = this.buffer.splice(0);

    try {
      const file = this.vault.getAbstractFileByPath(LOG_PATH);
      let content = "";

      if (file instanceof TFile) {
        content = await this.vault.read(file);
      }

      content = content + newLines.join("\n") + "\n";

      const lines = content.split("\n");
      if (lines.length > MAX_LINES) {
        content = lines.slice(-MAX_LINES).join("\n");
      }

      if (file instanceof TFile) {
        await this.vault.modify(file, content);
      } else {
        await this.vault.create(LOG_PATH, content);
      }
    } catch (e) {
      console.error("[thoth] logger flush failed:", e);
    }
  }
}
