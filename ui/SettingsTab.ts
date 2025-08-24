import { PluginSettingTab, Setting, App } from "obsidian";
import type { AutoSaveControlSettings } from "../types";

export interface SettingsHost {
  settings: AutoSaveControlSettings;
  saveSettings(): Promise<void>;
  applyOrRemovePatches(): void;
  updateTimeouts(): void;
}

export class AutoSaveControlSettingTab extends PluginSettingTab {
  constructor(app: App, private host: SettingsHost) {
    super(app, host as any);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Autosave Control" });

    new Setting(containerEl)
      .setName("Save interval (seconds)")
      .setDesc("Delay before autosave is written (3–3600).")
      .addText((t) =>
        t
          .setValue(String(this.host.settings.saveInterval))
          .onChange(async (val) => {
            let n = parseInt(val, 10);
            if (isNaN(n)) n = 10;
            n = Math.max(3, Math.min(3600, n));
            this.host.settings.saveInterval = n;
            await this.host.saveSettings();
            this.host.updateTimeouts();
          })
      );
  }
}