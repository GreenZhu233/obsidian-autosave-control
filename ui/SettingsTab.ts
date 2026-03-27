import { App, ColorComponent, PluginSettingTab, Setting } from "obsidian";
import type { AutoSaveControlSettings } from "../settings/AutoSaveSettings";

export interface SettingsHost {
  settings: AutoSaveControlSettings;
  saveSettings(): Promise<void>;
  applyStatusColors(): void;
}

export class AutoSaveControlSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly host: SettingsHost) {
    super(app, host as never);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Autosave Control" });

    new Setting(containerEl)
      .setName("Save delay (seconds)")
      .setDesc("How long to wait after editing stops before saving (3-3600).")
      .addText((textComponent) =>
        textComponent
          .setValue(String(this.host.settings.saveDelaySeconds))
          .onChange(async (value) => {
            const parsedValue = Number.parseInt(value, 10);
            const normalizedValue = Number.isNaN(parsedValue)
              ? DEFAULT_SAVE_DELAY_SECONDS
              : Math.max(MIN_SAVE_DELAY_SECONDS, Math.min(MAX_SAVE_DELAY_SECONDS, parsedValue));

            this.host.settings.saveDelaySeconds = normalizedValue;
            await this.host.saveSettings();
          })
      );

    this.addColorSetting({
      containerEl,
      name: "Saved status color",
      description: "Status dot color when all changes are saved.",
      getValue: () => this.host.settings.savedStatusColor,
      setValue: async (value) => {
        this.host.settings.savedStatusColor = value;
        await this.host.saveSettings();
        this.host.applyStatusColors();
      },
    });

    this.addColorSetting({
      containerEl,
      name: "Pending status color",
      description: "Status dot color while a delayed save is waiting.",
      getValue: () => this.host.settings.pendingStatusColor,
      setValue: async (value) => {
        this.host.settings.pendingStatusColor = value;
        await this.host.saveSettings();
        this.host.applyStatusColors();
      },
    });
  }

  private addColorSetting(options: ColorSettingOptions) {
    const setting = new Setting(options.containerEl)
      .setName(options.name)
      .setDesc(options.description);

    const addColorPicker = setting.addColorPicker;
    if (addColorPicker) {
      addColorPicker.call(setting, (colorPicker: ColorComponent) =>
        colorPicker.setValue(options.getValue()).onChange(options.setValue)
      );
      return;
    }

    setting.addText((textComponent) =>
      textComponent.setValue(options.getValue()).onChange(options.setValue)
    );
  }
}

type ColorSettingOptions = {
  containerEl: HTMLElement;
  name: string;
  description: string;
  getValue: () => string;
  setValue: (value: string) => Promise<void>;
};

const DEFAULT_SAVE_DELAY_SECONDS = 10;
const MIN_SAVE_DELAY_SECONDS = 3;
const MAX_SAVE_DELAY_SECONDS = 3600;
