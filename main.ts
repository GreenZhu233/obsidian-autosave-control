import { Plugin } from "obsidian";
import { AutoSaveController } from "./autosave/AutoSaveController";
import { DEFAULT_SETTINGS, type AutoSaveControlSettings } from "./settings/AutoSaveSettings";
import { installStatusStyles } from "./styles/installStatusStyles";
import { AutoSaveControlSettingsTab } from "./ui/SettingsTab";
import { SaveStatusIndicator } from "./ui/StatusIndicator";

export default class AutoSaveControlPlugin extends Plugin {
  settings!: AutoSaveControlSettings;

  private saveStatusIndicator!: SaveStatusIndicator;
  private autosaveController!: AutoSaveController;
  private stylesElement: HTMLStyleElement | null = null;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.saveStatusIndicator = new SaveStatusIndicator(this);
    this.saveStatusIndicator.attach();

    this.autosaveController = new AutoSaveController(this.app, () => this.settings);
    this.autosaveController.setPendingSaveCountChangeHandler((pendingSaveCount) => {
      this.saveStatusIndicator.setPendingSaveCount(pendingSaveCount);
    });
    this.autosaveController.enable();

    this.installStyles();
    this.applyStatusColors();

    this.addSettingTab(new AutoSaveControlSettingsTab(this.app, this));
  }

  onunload() {
    this.autosaveController.disable();

    if (this.stylesElement) {
      this.stylesElement.remove();
      this.stylesElement = null;
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  applyStatusColors(): void {
    const rootElement = document.documentElement;
    rootElement.style.setProperty("--asc-saved-color", this.settings.savedStatusColor);
    rootElement.style.setProperty("--asc-pending-color", this.settings.pendingStatusColor);
  }

  private installStyles(): void {
    if (this.stylesElement) {
      return;
    }

    this.stylesElement = installStatusStyles();
  }
}
