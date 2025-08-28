import type { Plugin } from "obsidian";

export class StatusIndicator {
  private el!: HTMLElement;

  constructor(private plugin: Plugin) {}

  attach() {
    this.el = this.plugin.addStatusBarItem();
    this.el.setText("●");
    this.el.addClass("save-status-icon");
    this.setAllSaved();
  }

  setPending(count: number) {
    if (!this.el) return;
    if (count > 0) {
      this.el.classList.remove("asc-saved");
      this.el.classList.add("asc-pending");
      this.el.setAttribute("title", "Changes pending save");
    } else {
      this.setAllSaved();
    }
  }

  private setAllSaved() {
    if (!this.el) return;
    this.el.classList.remove("asc-pending");
    this.el.classList.add("asc-saved");
    this.el.setAttribute("title", "All changes saved");
  }
}