import type { Plugin } from "obsidian";

export class SaveStatusIndicator {
  private element!: HTMLElement;

  constructor(private readonly plugin: Plugin) {}

  attach() {
    this.element = this.plugin.addStatusBarItem();
    this.element.setText("●");
    this.element.addClass("save-status-icon");
    this.showAllChangesSaved();
  }

  setPendingSaveCount(pendingSaveCount: number) {
    if (!this.element) {
      return;
    }

    if (pendingSaveCount > 0) {
      this.element.classList.remove("asc-saved");
      this.element.classList.add("asc-pending");
      this.element.setAttribute("title", "Changes pending save");
      return;
    }

    this.showAllChangesSaved();
  }

  private showAllChangesSaved() {
    if (!this.element) {
      return;
    }

    this.element.classList.remove("asc-pending");
    this.element.classList.add("asc-saved");
    this.element.setAttribute("title", "All changes saved");
  }
}
