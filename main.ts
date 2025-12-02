// src/main.ts
import { Plugin } from "obsidian";
import { StatusIndicator } from "./ui/StatusIndicator";
import { AutoSaveControlSettingTab } from "./ui/SettingsTab";
import { App, MarkdownView, TFile, TextFileView } from "obsidian";
import { dlog } from "./debug";

export interface AutoSaveControlSettings {
  saveInterval: number;        // seconds
  savedColor: string;
  pendingColor: string;
}

export const DEFAULT_SETTINGS: AutoSaveControlSettings = {
  saveInterval: 10,
  savedColor: "#32cd32", // limegreen
  pendingColor: "#00bfff", // deepskyblue
};

export type Pending = {
  file: TFile;
  view: TextFileView;
  timeoutId: number;
};

const GLOBAL_LAST_INPUT_AT = new Map<string, number>();

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


type SaveFn = (this: MarkdownView, ...args: unknown[]) => Promise<void> | void;
const LOG = (...a: unknown[]) => dlog("[asc]", ...a);

const INPUT_GRACE_MS = 2100; // allow Obsidian's autosave (~2s) once in this rolling-timeframe

const windowsWithListeners = new WeakSet<Window>();

export class AutoSaveController {
  private readonly app: App;
  private readonly getSettings: () => AutoSaveControlSettings;
  private onPendingChange?: (count: number) => void;

  private origSave: SaveFn | null = null;
  private unloading = false;

  private pending = new Map<string, Pending>();
  private windowEnd = new Map<string, number>();
  private token = new Map<string, number>();

  private onBeforeUnload?: () => void;
  private onInput?: () => void;
  private onPaste?: () => void;
  private onCut?: () => void;

  constructor(app: App, settings: () => AutoSaveControlSettings) {
    this.app = app;
    this.getSettings = settings;
  }

  setPendingCallback(cb: (count: number) => void) {
    this.onPendingChange = cb;
  }

  /** Wrap save and attach all relevant listeners (main + popups) */
  apply() {
    if (this.origSave) return;

    const proto = MarkdownView.prototype as unknown as { save: SaveFn };
    this.origSave = proto.save;
    proto.save = this.makeWrapper(proto.save);

    // mark function for all input events
    const mark = () => this.markActiveFileInput(true);

    // main window listeners
    this.onBeforeUnload = () => { this.unloading = true; };
    window.addEventListener("beforeunload", this.onBeforeUnload, { capture: true });

    this.onInput = mark;
    this.onPaste = mark;
    this.onCut = mark;

    window.addEventListener("input", this.onInput, true);
    window.addEventListener("paste", this.onPaste, true);
    window.addEventListener("cut", this.onCut, true);

    // workspace leaf changes → apply listeners to popups
    this.app.workspace.on("active-leaf-change", (leaf) => {
      if (!leaf || !(leaf.view instanceof MarkdownView)) return;
      this.attachWindowListeners(activeWindow);
    });

    // initial attach to the main window
    this.attachWindowListeners(window);

    LOG("wrapped save and attached listeners");
  }

  /** Attach input listeners to a given window (main or popup) */
  private attachWindowListeners(win: Window) {
    if (windowsWithListeners.has(win)) return;

    const mark = () => this.markActiveFileInput(true);
    const onKeydown = (ev: KeyboardEvent) => {
      if (["Enter", "Backspace", "Delete"].includes(ev.key)) mark();
    };

    win.addEventListener("keydown", onKeydown, true);
    win.addEventListener("input", mark, true);
    win.addEventListener("paste", mark, true);
    win.addEventListener("cut", mark, true);
    win.addEventListener("beforeunload", () => this.flushAllPending());

    windowsWithListeners.add(win);
  }

  /** Marks the currently active file as edited */
  private markActiveFileInput(log = false) {
    const mv = this.app.workspace.getActiveViewOfType(MarkdownView);
    const path = mv?.file?.path;
    if (!path) return;
    GLOBAL_LAST_INPUT_AT.set(path, Date.now());
    if (log) LOG("input made:", path);
  }

  private async flushAllPending() {
    const paths = Array.from(this.pending.keys());
    for (const path of paths) {
      await this.flush(path);
    }
  }

  /** Restore original save and detach listeners */
  restore() {
    const proto = MarkdownView.prototype as unknown as { save: SaveFn };
    if (this.origSave) {
      proto.save = this.origSave;
      this.origSave = null;
    }

    if (this.onBeforeUnload) window.removeEventListener("beforeunload", this.onBeforeUnload, { capture: true } as AddEventListenerOptions);
    if (this.onInput) window.removeEventListener("input", this.onInput, true);
    if (this.onPaste) window.removeEventListener("paste", this.onPaste, true);
    if (this.onCut) window.removeEventListener("cut", this.onCut, true);

    this.onBeforeUnload = this.onInput = this.onPaste = this.onCut = undefined;
    LOG("restored save");
  }

  private makeWrapper(original: SaveFn): SaveFn {
    const self = this;

    return function wrappedSave(this: MarkdownView, ...args: unknown[]) {
      const file: TFile | null | undefined = this.file;
      const path = file?.path;
      LOG("wrapped Save called:"+path+"/"+file);
      if (!path) return original.apply(this, args);

      const now = Date.now();
      const last = GLOBAL_LAST_INPUT_AT.get(path) ?? 0;  // use global map
      const since = now - last;
      LOG(path+":since:"+since);
      const insideGrace = since >= 0 && since <= INPUT_GRACE_MS;

      if (self.unloading) {
        self.clearPending(path);
        self.windowEnd.delete(path);
        self.token.delete(path);
        return original.apply(this, args);
      }

      if (insideGrace) {
        const end = self.windowEnd.get(path) ?? 0;
        const tok = self.token.get(path);
        const windowAlive = now <= end;
        const sameEpoch = tok !== undefined && tok === last;

        if (windowAlive && sameEpoch) {
          self.clearPending(path);
          self.windowEnd.delete(path);
          self.token.delete(path);
          return original.apply(this, args);
        }

        self.defer(path, this as TextFileView);
        self.windowEnd.set(path, last + INPUT_GRACE_MS);
        self.token.set(path, last);
        return;
      }

      self.clearPending(path);
      self.windowEnd.delete(path);
      self.token.delete(path);
      return original.apply(this, args);
    };
  }

  private markInput(path: string) {
    GLOBAL_LAST_INPUT_AT.set(path, Date.now());
  }

  private defer(path: string, view: TextFileView) {
    const existing = this.pending.get(path);
    if (existing) clearTimeout(existing.timeoutId);
    const timeoutId = window.setTimeout(() => this.flush(path), this.getSettings().saveInterval * 1000);
    this.pending.set(path, { file: view.file!, view, timeoutId });
    this.emitPending();
  }

  private async flush(path: string) {
    const entry = this.pending.get(path);
    if (!entry || !this.origSave) return;

    clearTimeout(entry.timeoutId);
    this.pending.delete(path);
    this.emitPending();

    await this.origSave.call(entry.view as unknown as MarkdownView);
    this.windowEnd.delete(path);
    this.token.delete(path);
    LOG("flushed", path);
  }

  private clearPending(path: string) {
    const p = this.pending.get(path);
    if (!p) return;
    clearTimeout(p.timeoutId);
    this.pending.delete(path);
    this.emitPending();
  }

  private emitPending() {
    this.onPendingChange?.(this.pending.size);
  }
}