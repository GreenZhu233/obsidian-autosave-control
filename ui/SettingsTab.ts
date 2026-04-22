import { App, ColorComponent, PluginSettingTab, Setting } from "obsidian";
import type { AutoSaveControlSettings } from "../settings/AutoSaveSettings";

export interface SettingsHost {
  settings: AutoSaveControlSettings;
  saveSettings(): Promise<void>;
  applyStatusColors(): void;
  applyStatusIconSize(): void;
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
      .setName("Disable autosave completely")
      .setDesc("Only save when you trigger Obsidian's Save File command manually.")
      .addToggle((toggleComponent) =>
        toggleComponent.setValue(this.host.settings.disableAutoSave).onChange(async (value) => {
          this.host.settings.disableAutoSave = value;
          await this.host.saveSettings();
          this.display();
        })
      );

    if (this.host.settings.disableAutoSave) {
      new Setting(containerEl)
        .setName("Warning")
        .setDesc(
          "Automatic saves are fully disabled. Unsaved changes stay only in memory until you use Obsidian's Save File command. Closing Obsidian with pending changes will show a confirmation prompt."
        );
    }

    if (!this.host.settings.disableAutoSave) {
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
    }

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

    new Setting(containerEl)
      .setName("Status icon size (px)")
      .setDesc(`Size of the status bar dot in pixels (${MIN_STATUS_ICON_SIZE_PX}-${MAX_STATUS_ICON_SIZE_PX}).`)
      .addText((textComponent) =>
        textComponent
          .setValue(String(this.host.settings.statusIconSizePx))
          .onChange(async (value) => {
            const parsedValue = Number.parseInt(value, 10);
            const normalizedValue = Number.isNaN(parsedValue)
              ? DEFAULT_STATUS_ICON_SIZE_PX
              : Math.max(
                  MIN_STATUS_ICON_SIZE_PX,
                  Math.min(MAX_STATUS_ICON_SIZE_PX, parsedValue)
                );

            this.host.settings.statusIconSizePx = normalizedValue;
            await this.host.saveSettings();
            this.host.applyStatusIconSize();
          })
      );

    containerEl.createEl("h3", { text: "Excluded Files & Folders" });

    let excludedPathInput: HTMLInputElement | null = null;

    new Setting(containerEl)
      .setName("Add excluded path")
      .setDesc("Gitignore patterns: * (chars), ** (path), ? (single), [abc] (class). Prefix 'r/' for regex.")
      .addText((textComponent) => {
        textComponent.setPlaceholder("*.mdenc | Daily/* | **/template/**");
        textComponent.inputEl.style.width = "200px";
        textComponent.setValue("");
        excludedPathInput = textComponent.inputEl;
      })
      .addButton((buttonComponent) => {
        buttonComponent.setButtonText("Add").setCta();
        buttonComponent.buttonEl.addEventListener("click", async () => {
          if (!excludedPathInput) return;
          const path = excludedPathInput.value.trim();
          if (!path) return;
          if (!this.host.settings.excludedPaths.includes(path)) {
            this.host.settings.excludedPaths.push(path);
            await this.host.saveSettings();
          }
          excludedPathInput.value = "";
          this.display();
        });
      });

    const excludedPaths = [...this.host.settings.excludedPaths];
    for (const path of excludedPaths) {
      new Setting(containerEl)
        .setName(path)
        .setDesc("")
        .addButton((buttonComponent) => {
          buttonComponent.setIcon("trash");
          buttonComponent.setTooltip("Remove exclusion");
          buttonComponent.buttonEl.addEventListener("click", async () => {
            const index = this.host.settings.excludedPaths.indexOf(path);
            if (index > -1) {
              this.host.settings.excludedPaths.splice(index, 1);
              await this.host.saveSettings();
              this.display();
            }
          });
        });
    }

    if (excludedPaths.length === 0) {
      containerEl.createEl("p", {
        text: "No excluded paths. Examples: *.mdenc (all mdenc), Daily/* (in Daily/), **/backup/** (in any backup folder).",
        cls: "setting-item-description",
      });
    }
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
const DEFAULT_STATUS_ICON_SIZE_PX = 16;
const MIN_STATUS_ICON_SIZE_PX = 8;
const MAX_STATUS_ICON_SIZE_PX = 32;
