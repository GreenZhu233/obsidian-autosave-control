// src/main.ts
import { Plugin } from "obsidian";
import { AutoSaveController } from "./core/AutoSaveController";
import { StatusIndicator } from "./ui/StatusIndicator";
import { AutoSaveControlSettingTab } from "./ui/SettingsTab";
import { DEFAULT_SETTINGS, AutoSaveControlSettings } from "./types";

export default class AutoSaveControlPlugin extends Plugin {
  settings!: AutoSaveControlSettings;
  private status!: StatusIndicator;
  private controller!: AutoSaveController;
  private styleEl: HTMLStyleElement | null = null;

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // status indicator
    this.status = new StatusIndicator(this);
    this.status.attach();

    // controller
    this.controller = new AutoSaveController(this.app, () => this.settings);
    this.controller.setPendingCallback((count) => this.status.setPending(count));
    this.controller.apply();

    // css
    this.installStyle();
    this.applyColors();

    // settings tab
    this.addSettingTab(new AutoSaveControlSettingTab(this.app, this as any));
  }

  onunload() {
    this.controller.restore();
    if (this.styleEl) {
      this.styleEl.remove();
      this.styleEl = null;
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** apply user colors -> CSS variables */
  applyColors(): void {
    const root = document.documentElement;
    root.style.setProperty("--asc-saved-color", this.settings.savedColor);
    root.style.setProperty("--asc-pending-color", this.settings.pendingColor);
  }

  /** inject minimal CSS once */
  private installStyle(): void {
    if (this.styleEl) return;
    const css = `
      .save-status-icon.asc-saved   { color: var(--asc-saved-color,   #32cd32); }
      .save-status-icon.asc-pending { color: var(--asc-pending-color, #00bfff); }
    `;
    const el = document.createElement("style");
    el.setAttribute("data-asc", "styles");
    el.textContent = css;
    document.head.appendChild(el);
    this.styleEl = el;
  }
}