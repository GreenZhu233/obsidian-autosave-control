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
      this.el.style.color = "deepskyblue";
      this.el.setAttribute("title", `Changes pending save`);
    } else {
      this.setAllSaved();
    }
  }

  private setAllSaved() {
    this.el.style.color = "limegreen";
    this.el.setAttribute("title", "All changes saved");
  }
}