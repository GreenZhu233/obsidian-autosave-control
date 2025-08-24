// src/core/AutoSaveController.ts
import {
  App,
  MarkdownView,
  TAbstractFile,
  TFile,
  TextFileView,
} from "obsidian";
import { dlog } from "../debug";
import type { AutoSaveControlSettings, Pending } from "../types";

type AnyFn = (...a: any[]) => any;
const LOG = (...a: any[]) => dlog("[asc]", ...a);

// Any save within this window after the last *mutating* input is AUTOSAVE (1st hit) -> defer
const INPUT_GRACE_MS = 2100; // since obsidian saves 2 seconds after first input

// Known mutating InputEvent types (subset; defaults to mutating if unknown)
const MUTATING_INPUT_TYPES = new Set<string>([
  "insertText",
  "insertFromPaste",
  "insertReplacementText",
  "insertFromDrop",
  "insertCompositionText",
  "deleteContentBackward",
  "deleteContentForward",
  "deleteByCut",
  "deleteByDrag",
  "historyUndo",
  "historyRedo",
]);

export class AutoSaveController {
  private app: App;
  private get settings(): AutoSaveControlSettings { return this._settings(); }
  private _settings: () => AutoSaveControlSettings;

  /** Debounced autosaves keyed by file path */
  private pending = new Map<string, Pending>();

  /** Original MV.save we call to actually write */
  private origMVSave: AnyFn | null = null;

  /** UI callback */
  private onPendingChange?: (count: number) => void;

  /** Last mutating input timestamps per file path */
  private lastInputAt = new Map<string, number>();

  /**
   * If we deferred once inside the current grace window:
   * - windowEnd: end of the grace window measured from the input that caused deferral
   * - token: the exact input timestamp we used when deferring (to detect new input)
   */
  private deferredOnceInWindow = new Map<string, number>(); // windowEnd (epoch ms)
  private deferredToken = new Map<string, number>();        // token = lastInputAt at defer time

  /** Global DOM listeners */
  private inputHandlersAttached = false;
  private inputHandler?: (e: Event) => void;
  private pasteHandler?: (e: ClipboardEvent) => void;
  private cutHandler?: (e: ClipboardEvent) => void;

  private patched = false;

  constructor(app: App, settingsGetter: () => AutoSaveControlSettings) {
    this.app = app;
    this._settings = settingsGetter;
  }

  /* ------------------- main.ts wiring ------------------- */

  setPendingCallback(cb: (count: number) => void) {
    this.onPendingChange = cb;
  }

  handleQuitOrClose() {
    LOG("app exit -> flush all");
    void this.flushAll();
  }

  handleRename(file: TAbstractFile, oldPath: string) {
    if (!(file instanceof TFile)) return;
    const newPath = file.path;

    // pending timer re-key
    const entry = this.pending.get(oldPath);
    if (entry) {
      clearTimeout(entry.timeoutId);
      this.pending.delete(oldPath);
      const timeoutId = window.setTimeout(
        () => this.flushByPath(newPath),
        this.settings.saveInterval * 1000
      );
      this.pending.set(newPath, { ...entry, file, timeoutId });
      this.emitPending();
    }

    // input timestamp re-key
    const ts = this.lastInputAt.get(oldPath);
    if (ts) {
      this.lastInputAt.delete(oldPath);
      this.lastInputAt.set(newPath, ts);
    }

    // grace-window re-key
    const winEnd = this.deferredOnceInWindow.get(oldPath);
    if (winEnd) {
      this.deferredOnceInWindow.delete(oldPath);
      this.deferredOnceInWindow.set(newPath, winEnd);
    }
    // token re-key
    const tok = this.deferredToken.get(oldPath);
    if (tok !== undefined) {
      this.deferredToken.delete(oldPath);
      this.deferredToken.set(newPath, tok);
    }

    LOG("rename re-key:", oldPath, "->", newPath);
  }

  /* ------------------- patch / restore ------------------- */

  public applyOrRemovePatches(): void {
    if (!this.patched) {
      this.app.workspace.onLayoutReady(() => this.applyNow());
      this.applyNow(); // also try immediately
      this.patched = true;
    } else {
      this.applyNow();
    }
  }

  private applyNow() {
    const MV = MarkdownView.prototype as any;

    // Capture original once
    if (!this.origMVSave) this.origMVSave = MV.save;

    // Install global input detectors (once)
    this.attachInputDetectors();

    // Wrap MV.save as the single choke point
    const self = this;

    MV.save = function (this: MarkdownView, ...args: any[]) {
      const path = (this as any).file?.path;
      if (!path || !self.origMVSave) {
        return self.origMVSave?.apply(this, args);
      }

      const now = Date.now();
      const last = self.lastInputAt.get(path) ?? 0;
      const since = now - last;
      const insideGrace = since >= 0 && since <= INPUT_GRACE_MS;

      if (insideGrace) {
        const windowEnd = self.deferredOnceInWindow.get(path) ?? 0;
        const tokenAtDefer = self.deferredToken.get(path);
        const hasWindow = now <= windowEnd;

        // second-hit allowed ONLY if no new input after the first defer (token unchanged)
        const sameInputEpoch = tokenAtDefer !== undefined && tokenAtDefer === last;

        if (hasWindow && sameInputEpoch) {
          LOG(`HIT MV.save path=${path} insideGrace SECOND-HIT (same input) -> PASS-THROUGH`);
          if (self.pending.has(path)) self.clearPending(path);
          self.deferredOnceInWindow.delete(path);
          self.deferredToken.delete(path);
          return self.origMVSave.apply(this, args);
        }

        // Either there was new input (token mismatch) OR no window yet: treat as FIRST-HIT again
        LOG(`HIT MV.save path=${path} insideGrace FIRST-HIT -> DEFER for ${self.settings.saveInterval}s`);
        self.defer(path, this as unknown as TextFileView);
        self.deferredOnceInWindow.set(path, last + INPUT_GRACE_MS);
        self.deferredToken.set(path, last);
        return; // don't call original now
      }

      // Outside grace -> PASS-THROUGH; clear any lingering pending/markers
      LOG(`HIT MV.save path=${path} outsideGrace -> PASS-THROUGH`);
      if (self.pending.has(path)) self.clearPending(path);
      self.deferredOnceInWindow.delete(path);
      self.deferredToken.delete(path);
      return self.origMVSave.apply(this, args);
    };

    LOG("MV.save wrapped");
  }

  public restoreOriginals(): void {
    const MV = MarkdownView.prototype as any;
    if (this.origMVSave) MV.save = this.origMVSave;

    this.detachInputDetectors();

    LOG("originals restored");
  }

  /* ------------------- input detection ------------------- */

  private attachInputDetectors() {
    if (this.inputHandlersAttached) return;
    this.inputHandlersAttached = true;

    const mark = () => {
      const mv = this.app.workspace.getActiveViewOfType(MarkdownView);
      const path = mv?.file?.path;
      if (!path) return;
      this.lastInputAt.set(path, Date.now());
      LOG("file input detected");
    };

    // Only mutating input should mark activity
    this.inputHandler = (e: Event) => {
      const ie = e as InputEvent;
      const type = (ie && "inputType" in ie ? (ie as any).inputType : "") as string;
      if (!type || MUTATING_INPUT_TYPES.has(type)) {
        mark();
      }
    };

    // Redundant safety nets (these usually also produce an input event)
    this.pasteHandler = () => mark();
    this.cutHandler = () => mark();

    window.addEventListener("input", this.inputHandler as any, true);
    window.addEventListener("paste", this.pasteHandler as any, true);
    window.addEventListener("cut", this.cutHandler as any, true);

    LOG("input detectors attached (mutating input/paste/cut)");
  }

  private detachInputDetectors() {
    if (!this.inputHandlersAttached) return;
    this.inputHandlersAttached = false;

    if (this.inputHandler)
      window.removeEventListener("input", this.inputHandler as any, true);
    if (this.pasteHandler)
      window.removeEventListener("paste", this.pasteHandler as any, true);
    if (this.cutHandler)
      window.removeEventListener("cut", this.cutHandler as any, true);

    this.inputHandler = this.pasteHandler = this.cutHandler = undefined;

    LOG("input detectors detached");
  }

  /* ------------------- debounce & flush ------------------- */

  private defer(path: string, view: TextFileView): void {
    const ex = this.pending.get(path);
    if (ex) clearTimeout(ex.timeoutId);

    const timeoutId = window.setTimeout(
      () => this.flushByPath(path),
      this.settings.saveInterval * 1000
    );
    this.pending.set(path, { file: view.file!, view, timeoutId });
    this.emitPending();
    LOG(ex ? "reset timer" : "set timer", path);
  }

  private clearPending(path: string): void {
    const p = this.pending.get(path);
    if (!p) return;
    clearTimeout(p.timeoutId);
    this.pending.delete(path);
    this.emitPending();
  }

  private async flushByPath(path: string): Promise<void> {
    const entry = this.pending.get(path);
    if (!entry) return;

    clearTimeout(entry.timeoutId);
    this.pending.delete(path);
    this.emitPending();

    await this.flushImmediate(entry.view);
  }

  public async flushImmediate(view: TextFileView): Promise<void> {
    const path = view.file?.path;
    if (!path || !this.origMVSave) return;
    try {
      if (this.pending.has(path)) this.clearPending(path);
      LOG("flushImmediate -> MV.save()", path);
      await this.origMVSave.call(view as any);
      // Saving completes this input epoch: clear markers so next autosave won't pass
      this.deferredOnceInWindow.delete(path);
      this.deferredToken.delete(path);
      LOG("flushed", path);
    } catch (e) {
      console.error("[asc] flushImmediate failed:", path, e);
    }
  }

  public async flushAll(): Promise<void> {
    const entries = [...this.pending.values()];
    this.pending.clear();
    entries.forEach((e) => clearTimeout(e.timeoutId));
    this.emitPending();

    for (const e of entries) {
      await this.flushImmediate(e.view);
    }
  }

  public async flushCurrentActive(): Promise<void> {
    const mv = this.app.workspace.getActiveViewOfType(MarkdownView);
    const view = (mv as unknown) as TextFileView | null;
    if (!mv?.file || !view) return;

    const path = mv.file.path;

    if (this.pending.has(path)) {
      await this.flushByPath(path);
      return;
    }
    await this.flushImmediate(view);
  }

  public updateTimeouts(): void {
    this.pending.forEach((entry, path) => {
      clearTimeout(entry.timeoutId);
      entry.timeoutId = window.setTimeout(
        () => this.flushByPath(path),
        this.settings.saveInterval * 1000
      );
    });
    this.emitPending();
  }

  /* ------------------- helpers ------------------- */

  private getViewByPath(path: string): TextFileView | null {
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      const mv = leaf.view as MarkdownView;
      if (mv?.file?.path === path) return (mv as unknown) as TextFileView;
    }
    return null;
  }

  private emitPending() {
    this.onPendingChange?.(this.pending.size);
  }
}