import { MarkdownView, Plugin } from "obsidian";
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
  private runtimeCleanup: (() => void) | null = null;

  async onload() {
    const globalState = window as typeof window & { __ascRuntimeCleanup?: (() => void) | null };
    globalState.__ascRuntimeCleanup?.();

    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.saveStatusIndicator = new SaveStatusIndicator(this);
    this.saveStatusIndicator.attach();

    this.autosaveController = new AutoSaveController(this.app, () => this.settings);
    this.autosaveController.setPendingSaveCountChangeHandler((pendingSaveCount) => {
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      this.saveStatusIndicator.setPendingSaveCount(pendingSaveCount, activeView?.file?.path);
    });
    this.autosaveController.enable();

    // Check excluded status when switching files
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (!leaf || !(leaf.view instanceof MarkdownView)) {
          this.saveStatusIndicator.setPendingSaveCount(0, null);
          return;
        }
        this.saveStatusIndicator.checkAndHideForActiveFile(leaf.view.file?.path);
      })
    );

    this.installStyles();
    this.applyStatusColors();
    this.applyStatusIconSize();

    this.addSettingTab(new AutoSaveControlSettingsTab(this.app, this));

    this.runtimeCleanup = () => {
      this.autosaveController.disable();
      this.saveStatusIndicator.detach();

      if (this.stylesElement) {
        this.stylesElement.remove();
        this.stylesElement = null;
      }
    };

    globalState.__ascRuntimeCleanup = this.runtimeCleanup;
  }

  onunload() {
    this.runtimeCleanup?.();

    const globalState = window as typeof window & { __ascRuntimeCleanup?: (() => void) | null };
    if (globalState.__ascRuntimeCleanup === this.runtimeCleanup) {
      globalState.__ascRuntimeCleanup = null;
    }

    this.runtimeCleanup = null;
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.autosaveController.refreshScheduling();
  }

  applyStatusColors(): void {
    const rootElement = document.documentElement;
    rootElement.style.setProperty("--asc-saved-color", this.settings.savedStatusColor);
    rootElement.style.setProperty("--asc-pending-color", this.settings.pendingStatusColor);
  }

  applyStatusIconSize(): void {
    document.documentElement.style.setProperty(
      "--asc-icon-size",
      `${this.settings.statusIconSizePx}px`
    );
  }

  private installStyles(): void {
    if (this.stylesElement) {
      return;
    }

    this.stylesElement = installStatusStyles();
  }
}
