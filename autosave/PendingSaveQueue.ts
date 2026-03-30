import { App, MarkdownView, TextFileView, TFile } from "obsidian";
import { dlog } from "../debug";

type SaveFn = (this: MarkdownView, ...args: unknown[]) => Promise<void> | void;

type PendingSaveEntry = {
  view: TextFileView;
  timeoutId: number | null;
  latestData: string;
};

export class PendingSaveQueue {
  private readonly pendingSavesByPath = new Map<string, PendingSaveEntry>();

  constructor(
    private readonly app: App,
    private readonly isAutoSaveDisabled: () => boolean,
    private readonly getSaveDelaySeconds: () => number,
    private readonly getOriginalSave: () => SaveFn | null,
    private readonly onPendingSaveCountChange: (pendingSaveCount: number) => void,
  ) {}

  schedule(filePath: string, view: TextFileView) {
    if (!view.file) {
      return;
    }

    const existingPendingSave = this.pendingSavesByPath.get(filePath);
    if (existingPendingSave?.timeoutId != null) {
      clearTimeout(existingPendingSave.timeoutId);
    }

    this.pendingSavesByPath.set(filePath, {
      view,
      timeoutId: this.createTimeout(filePath),
      latestData: view.getViewData(),
    });
    this.emitPendingSaveCount();
  }

  has(filePath: string): boolean {
    return this.pendingSavesByPath.has(filePath);
  }

  hasAny(): boolean {
    return this.pendingSavesByPath.size > 0;
  }

  renamePendingSave(oldPath: string, newPath: string) {
    const pendingSave = this.pendingSavesByPath.get(oldPath);
    if (!pendingSave) {
      return;
    }

    if (pendingSave.timeoutId !== null) {
      clearTimeout(pendingSave.timeoutId);
    }

    this.pendingSavesByPath.delete(oldPath);
    this.pendingSavesByPath.set(newPath, {
      ...pendingSave,
      timeoutId: this.createTimeout(newPath),
    });
  }

  refreshScheduling() {
    for (const [filePath, pendingSave] of this.pendingSavesByPath.entries()) {
      if (pendingSave.timeoutId !== null) {
        clearTimeout(pendingSave.timeoutId);
      }

      pendingSave.timeoutId = this.createTimeout(filePath);
    }
  }

  clear(filePath: string) {
    const pendingSave = this.pendingSavesByPath.get(filePath);
    if (!pendingSave) {
      return;
    }

    if (pendingSave.timeoutId !== null) {
      clearTimeout(pendingSave.timeoutId);
    }
    this.pendingSavesByPath.delete(filePath);
    this.emitPendingSaveCount();
  }

  async flush(filePath: string) {
    const pendingSave = this.pendingSavesByPath.get(filePath);
    const originalSave = this.getOriginalSave();
    if (!pendingSave || !originalSave) {
      return;
    }

    if (pendingSave.timeoutId !== null) {
      clearTimeout(pendingSave.timeoutId);
    }
    this.pendingSavesByPath.delete(filePath);
    this.emitPendingSaveCount();

    const activeViewFilePath = pendingSave.view.file?.path;
    if (activeViewFilePath === filePath) {
      await originalSave.call(pendingSave.view as unknown as MarkdownView);
    } else {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        await this.app.vault.modify(file, pendingSave.latestData);
      }
    }

    dlog("Pending save flushed", filePath);
  }

  async flushAll() {
    for (const filePath of Array.from(this.pendingSavesByPath.keys())) {
      await this.flush(filePath);
    }
  }

  private emitPendingSaveCount() {
    this.onPendingSaveCountChange(this.pendingSavesByPath.size);
  }

  private createTimeout(filePath: string): number | null {
    if (this.isAutoSaveDisabled()) {
      return null;
    }

    const saveDelayMilliseconds = this.getSaveDelaySeconds() * 1000;
    return window.setTimeout(() => {
      void this.flush(filePath);
    }, saveDelayMilliseconds);
  }
}
