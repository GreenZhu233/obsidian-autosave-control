// src/main.ts
import { Plugin, MarkdownView } from "obsidian";
import { AutoSaveController } from "./core/AutoSaveController";
import { StatusIndicator } from "./ui/StatusIndicator";
import { AutoSaveControlSettingTab } from "./ui/SettingsTab";
import { DEFAULT_SETTINGS, AutoSaveControlSettings } from "./types";
import { dlog } from "./debug";

export default class AutoSaveControlPlugin extends Plugin {
  settings!: AutoSaveControlSettings;

  private status!: StatusIndicator;
  private controller!: AutoSaveController;

  async onload() {
    await this.loadSettings();
    console.log("loading obsidian-autosave-control plugin");

    // UI
    this.status = new StatusIndicator(this);
    this.status.attach();

    // Core
    this.controller = new AutoSaveController(this.app, () => this.settings);
    this.controller.setPendingCallback((count) => this.status.setPending(count));

    // Settings tab
    this.addSettingTab(new AutoSaveControlSettingTab(this.app, this as any));

    // Apply save interception hooks
    this.applyOrRemovePatches();

    // Events
    this.registerEvent(
      this.app.workspace.on("quit", () => this.controller.handleQuitOrClose())
    );
    this.registerEvent(
      this.app.workspace.on("window-close", () => this.controller.handleQuitOrClose())
    );
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => this.controller.handleRename(f, oldPath))
    );
  }

  onunload(): void {
    this.restoreOriginals();
    void this.controller.flushAll();
    dlog("Plugin unloaded");
  }

  /* ---------------- Settings passthrough ---------------- */

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }

  public applyOrRemovePatches() {
    this.controller.applyOrRemovePatches();
  }
  public updateTimeouts() {
    this.controller.updateTimeouts?.();
  }
  public restoreOriginals() {
    this.controller.restoreOriginals();
  }
}