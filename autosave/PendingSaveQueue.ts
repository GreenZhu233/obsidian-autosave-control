import { MarkdownView, TextFileView } from "obsidian";
import { dlog } from "../debug";

type SaveFn = (this: MarkdownView, ...args: unknown[]) => Promise<void> | void;

type PendingSaveEntry = {
  view: TextFileView;
  timeoutId: number;
};

export class PendingSaveQueue {
  private readonly pendingSavesByPath = new Map<string, PendingSaveEntry>();
  private readonly gracePeriodEndsAtByPath = new Map<string, number>();
  private readonly gracePeriodEditActivityAtByPath = new Map<string, number>();

  constructor(
    private readonly getSaveDelaySeconds: () => number,
    private readonly getOriginalSave: () => SaveFn | null,
    private readonly onPendingSaveCountChange: (pendingSaveCount: number) => void,
  ) {}

  schedule(filePath: string, view: TextFileView) {
    if (!view.file) {
      return;
    }

    const existingPendingSave = this.pendingSavesByPath.get(filePath);
    if (existingPendingSave) {
      clearTimeout(existingPendingSave.timeoutId);
    }

    const saveDelayMilliseconds = this.getSaveDelaySeconds() * 1000;
    const timeoutId = window.setTimeout(() => {
      void this.flush(filePath);
    }, saveDelayMilliseconds);

    this.pendingSavesByPath.set(filePath, { view, timeoutId });
    this.emitPendingSaveCount();
  }

  clear(filePath: string) {
    const pendingSave = this.pendingSavesByPath.get(filePath);
    if (!pendingSave) {
      return;
    }

    clearTimeout(pendingSave.timeoutId);
    this.pendingSavesByPath.delete(filePath);
    this.emitPendingSaveCount();
  }

  async flush(filePath: string) {
    const pendingSave = this.pendingSavesByPath.get(filePath);
    const originalSave = this.getOriginalSave();
    if (!pendingSave || !originalSave) {
      return;
    }

    clearTimeout(pendingSave.timeoutId);
    this.pendingSavesByPath.delete(filePath);
    this.emitPendingSaveCount();

    await originalSave.call(pendingSave.view as unknown as MarkdownView);
    this.clearGracePeriod(filePath);

    dlog("Pending save flushed", filePath);
  }

  async flushAll() {
    for (const filePath of Array.from(this.pendingSavesByPath.keys())) {
      await this.flush(filePath);
    }
  }

  setGracePeriod(filePath: string, lastEditActivityAt: number, gracePeriodMilliseconds: number) {
    this.gracePeriodEndsAtByPath.set(filePath, lastEditActivityAt + gracePeriodMilliseconds);
    this.gracePeriodEditActivityAtByPath.set(filePath, lastEditActivityAt);
  }

  isRepeatedSaveForSameEditBurst(filePath: string, now: number, lastEditActivityAt: number): boolean {
    const gracePeriodEndsAt = this.gracePeriodEndsAtByPath.get(filePath) ?? 0;
    const gracePeriodEditActivityAt = this.gracePeriodEditActivityAtByPath.get(filePath);
    return now <= gracePeriodEndsAt && gracePeriodEditActivityAt === lastEditActivityAt;
  }

  clearGracePeriod(filePath: string) {
    this.gracePeriodEndsAtByPath.delete(filePath);
    this.gracePeriodEditActivityAtByPath.delete(filePath);
  }

  private emitPendingSaveCount() {
    this.onPendingSaveCountChange(this.pendingSavesByPath.size);
  }
}
