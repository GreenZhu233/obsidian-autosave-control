import { MarkdownView } from "obsidian";
import type { Plugin } from "obsidian";

export class SaveStatusIndicator {
  private element: HTMLElement | null = null;
  private isHidden = false;

  constructor(private readonly plugin: Plugin) {}

  attach() {
    this.detach();
    this.removeStaleIndicators();
    this.element = this.plugin.addStatusBarItem();
    this.element.setText("●");
    this.element.addClass("save-status-icon");
    this.showAllChangesSaved();
  }

  detach() {
    this.element?.remove();
    this.element = null;
    this.isHidden = false;
  }

  setPendingSaveCount(pendingSaveCount: number, activeFilePath?: string | null) {
    if (!this.element) {
      return;
    }

    if (activeFilePath && this.isFileExcluded(activeFilePath)) {
      this.hide();
      return;
    }

    this.show();

    if (pendingSaveCount > 0) {
      this.element.classList.remove("asc-saved");
      this.element.classList.add("asc-pending");
      this.element.setAttribute("title", "Changes pending save");
      return;
    }

    this.showAllChangesSaved();
  }

  checkAndHideForActiveFile(activeFilePath?: string | null) {
    if (!this.element) {
      return;
    }

    if (activeFilePath && this.isFileExcluded(activeFilePath)) {
      this.hide();
      return;
    }

    this.show();
  }

  private isFileExcluded(filePath: string): boolean {
    const settings = (this.plugin as unknown as { settings?: { excludedPaths?: string[] } }).settings;
    if (!settings?.excludedPaths || settings.excludedPaths.length === 0) {
      return false;
    }

    const normalizedPath = filePath.replace(/\\/g, "/");

    return settings.excludedPaths.some((pattern) => {
      const trimmedPattern = pattern.trim();

      // Skip empty patterns and comments
      if (!trimmedPattern || trimmedPattern.startsWith("#")) {
        return false;
      }

      // Regex pattern
      if (trimmedPattern.startsWith("r/") && trimmedPattern.endsWith("/")) {
        try {
          const regex = new RegExp(trimmedPattern.slice(2, -1));
          return regex.test(normalizedPath);
        } catch {
          return false;
        }
      }

      // Gitignore-style matching
      return this.matchGitignore(normalizedPath, trimmedPattern);
    });
  }

  private matchGitignore(path: string, pattern: string): boolean {
    const isDirectoryPattern = pattern.endsWith("/");
    const cleanPattern = isDirectoryPattern ? pattern.slice(0, -1) : pattern;
    const patternParts = cleanPattern.split("/");
    const pathParts = path.split("/");

    // For patterns without /, match from any position
    if (!cleanPattern.includes("/")) {
      for (let i = 0; i <= pathParts.length - patternParts.length; i++) {
        if (this.matchParts(pathParts, patternParts, i, 0)) {
          return true;
        }
      }
      return false;
    }

    return this.matchParts(pathParts, patternParts, 0, 0);
  }

  private matchParts(pathParts: string[], patternParts: string[], pathStart: number, patternStart: number): boolean {
    let pi = patternStart;
    let ni = pathStart;

    while (pi < patternParts.length && ni < pathParts.length) {
      const p = patternParts[pi];

      if (p === "**") {
        if (pi === patternParts.length - 1) {
          return true;
        }
        const nextP = patternParts[pi + 1];
        for (let i = ni; i <= pathParts.length - (patternParts.length - pi - 1); i++) {
          if (this.matchSinglePart(pathParts[i], nextP)) {
            if (this.matchParts(pathParts, patternParts, i + 1, pi + 2)) {
              return true;
            }
          }
        }
        return false;
      }

      if (!this.matchSinglePart(pathParts[ni], p)) {
        return false;
      }

      pi++;
      ni++;
    }

    if (pi !== patternParts.length) {
      return false;
    }

    // Allow remaining path parts if pattern ends with **
    const lastPatternPart = patternParts[patternParts.length - 1];
    if (lastPatternPart === "**") {
      return true;
    }

    return ni === pathParts.length;
  }

  private matchSinglePart(name: string, pattern: string): boolean {
    let regexPattern = "";
    let i = 0;

    while (i < pattern.length) {
      const char = pattern[i];

      if (char === "*") {
        if (pattern[i + 1] === "*") {
          regexPattern += ".*";
          i += 2;
          continue;
        }
        regexPattern += "[^/]*";
        i++;
        continue;
      }

      if (char === "?") {
        regexPattern += "[^/]";
        i++;
        continue;
      }

      if (char === "[") {
        const closeIdx = pattern.indexOf("]", i);
        if (closeIdx !== -1) {
          regexPattern += pattern.slice(i, closeIdx + 1);
          i = closeIdx + 1;
          continue;
        }
      }

      if ("\\.+^${}|()[]".includes(char)) {
        regexPattern += "\\" + char;
      } else {
        regexPattern += char;
      }

      i++;
    }

    try {
      return new RegExp("^" + regexPattern + "$").test(name);
    } catch {
      return name === pattern;
    }
  }

  private hide() {
    if (!this.element || this.isHidden) {
      return;
    }
    this.element.addClass("asc-hidden");
    this.isHidden = true;
  }

  private show() {
    if (!this.element || !this.isHidden) {
      return;
    }
    this.element.removeClass("asc-hidden");
    this.isHidden = false;
  }

  private showAllChangesSaved() {
    if (!this.element) {
      return;
    }

    this.element.classList.remove("asc-pending");
    this.element.classList.add("asc-saved");
    this.element.setAttribute("title", "All changes saved");
  }

  private removeStaleIndicators() {
    document.querySelectorAll(".save-status-icon").forEach((element) => element.remove());
  }
}
