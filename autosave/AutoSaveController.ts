import { App, EventRef, Hotkey, MarkdownView, Platform, TextFileView, TFile, WorkspaceLeaf } from "obsidian";
import { dlog } from "../debug";
import type { AutoSaveControlSettings } from "../settings/AutoSaveSettings";
import { EditActivityTracker } from "./EditActivityTracker";
import { PendingSaveQueue } from "./PendingSaveQueue";

type SaveFn = (this: MarkdownView, ...args: unknown[]) => Promise<void> | void;
type RequestSaveFn = (this: TextFileView, ...args: unknown[]) => void;
type OpenFileFn = (this: WorkspaceLeaf, ...args: unknown[]) => Promise<unknown>;
type OnUnloadFileFn = (this: TextFileView, file: TFile) => Promise<void>;
type SetViewStateFn = (this: WorkspaceLeaf, ...args: unknown[]) => Promise<unknown>;

type BeforeUnloadListener = () => void;

export class AutoSaveController {
  private originalSave: SaveFn | null = null;
  private originalRequestSave: RequestSaveFn | null = null;
  private originalOpenFile: OpenFileFn | null = null;
  private originalOnUnloadFile: OnUnloadFileFn | null = null;
  private originalSetViewState: SetViewStateFn | null = null;
  private isUnloading = false;
  private workspaceLeafChangeEventRef?: EventRef;
  private vaultRenameEventRef?: EventRef;
  private onPendingSaveCountChange?: (pendingSaveCount: number) => void;

  private readonly editActivityTracker: EditActivityTracker;
  private readonly pendingSaveQueue: PendingSaveQueue;
  private readonly beforeUnloadListenersByWindow = new Map<Window, BeforeUnloadListener>();
  private readonly fileSwitchingLeaves = new WeakSet<WorkspaceLeaf>();
  private readonly filePathsSwitchingInLeaf = new Set<string>();

  constructor(private readonly app: App, private readonly getSettings: () => AutoSaveControlSettings) {
    this.editActivityTracker = new EditActivityTracker(
      () => this.app.workspace.getActiveViewOfType(MarkdownView),
      (view, filePath) => this.pendingSaveQueue.schedule(filePath, view as unknown as TextFileView),
      (event) => this.isManualSaveShortcut(event),
      (view, filePath, event) => this.handleManualSaveShortcut(view, filePath, event),
    );
    this.pendingSaveQueue = new PendingSaveQueue(
      this.app,
      () => this.getSettings().saveDelaySeconds,
      () => this.originalSave,
      (pendingSaveCount) => this.onPendingSaveCountChange?.(pendingSaveCount),
    );
  }

  setPendingSaveCountChangeHandler(handler: (pendingSaveCount: number) => void) {
    this.onPendingSaveCountChange = handler;
  }

  enable() {
    if (this.originalSave) {
      return;
    }

    const markdownViewPrototype = MarkdownView.prototype as unknown as { save: SaveFn };
    const textFileViewPrototype = TextFileView.prototype as unknown as {
      requestSave?: RequestSaveFn;
      onUnloadFile: OnUnloadFileFn;
    };
    const workspaceLeafPrototype = WorkspaceLeaf.prototype as unknown as { openFile: OpenFileFn };
    const workspaceLeafViewStatePrototype = WorkspaceLeaf.prototype as unknown as { setViewState: SetViewStateFn };

    this.originalSave = markdownViewPrototype.save;
    markdownViewPrototype.save = this.createSaveWrapper(markdownViewPrototype.save);

    if (typeof textFileViewPrototype.requestSave === "function") {
      this.originalRequestSave = textFileViewPrototype.requestSave;
      textFileViewPrototype.requestSave = this.createRequestSaveWrapper(textFileViewPrototype.requestSave);
    }

    this.originalOnUnloadFile = textFileViewPrototype.onUnloadFile;
    textFileViewPrototype.onUnloadFile = this.createOnUnloadFileWrapper(textFileViewPrototype.onUnloadFile);

    this.originalOpenFile = workspaceLeafPrototype.openFile;
    workspaceLeafPrototype.openFile = this.createOpenFileWrapper(workspaceLeafPrototype.openFile);

    this.originalSetViewState = workspaceLeafViewStatePrototype.setViewState;
    workspaceLeafViewStatePrototype.setViewState = this.createSetViewStateWrapper(workspaceLeafViewStatePrototype.setViewState);

    this.isUnloading = false;
    this.vaultRenameEventRef = this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile)) {
        return;
      }

      this.pendingSaveQueue.renamePendingSave(oldPath, file.path);
      this.editActivityTracker.renameTrackedFile(oldPath, file.path);
    });

    this.workspaceLeafChangeEventRef = this.app.workspace.on("active-leaf-change", (leaf) => {
      if (!leaf || !(leaf.view instanceof MarkdownView)) {
        return;
      }

      this.attachWindowObservers(this.getViewWindow(leaf.view));
    });

    this.attachWindowObservers(window);

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      if (leaf.view instanceof MarkdownView) {
        this.attachWindowObservers(this.getViewWindow(leaf.view));
      }
    }

    dlog("Autosave wrapper enabled");
  }

  disable() {
    const markdownViewPrototype = MarkdownView.prototype as unknown as { save: SaveFn };
    const textFileViewPrototype = TextFileView.prototype as unknown as {
      requestSave?: RequestSaveFn;
      onUnloadFile: OnUnloadFileFn;
    };
    const workspaceLeafPrototype = WorkspaceLeaf.prototype as unknown as { openFile: OpenFileFn };
    const workspaceLeafViewStatePrototype = WorkspaceLeaf.prototype as unknown as { setViewState: SetViewStateFn };

    if (this.originalSave) {
      markdownViewPrototype.save = this.originalSave;
      this.originalSave = null;
    }

    if (this.originalRequestSave) {
      textFileViewPrototype.requestSave = this.originalRequestSave;
      this.originalRequestSave = null;
    }

    if (this.originalOnUnloadFile) {
      textFileViewPrototype.onUnloadFile = this.originalOnUnloadFile;
      this.originalOnUnloadFile = null;
    }

    if (this.originalOpenFile) {
      workspaceLeafPrototype.openFile = this.originalOpenFile;
      this.originalOpenFile = null;
    }

    if (this.originalSetViewState) {
      workspaceLeafViewStatePrototype.setViewState = this.originalSetViewState;
      this.originalSetViewState = null;
    }

    if (this.workspaceLeafChangeEventRef) {
      this.app.workspace.offref(this.workspaceLeafChangeEventRef);
      this.workspaceLeafChangeEventRef = undefined;
    }

    if (this.vaultRenameEventRef) {
      this.app.vault.offref(this.vaultRenameEventRef);
      this.vaultRenameEventRef = undefined;
    }

    this.detachAllWindowObservers();
    this.isUnloading = false;

    dlog("Autosave wrapper disabled");
  }

  private createSaveWrapper(originalSave: SaveFn): SaveFn {
    const controller = this;

    return function wrappedSave(this: MarkdownView, ...args: unknown[]) {
      const filePath = this.file?.path;
      if (!filePath) {
        return originalSave.apply(this, args);
      }

      if (controller.pendingSaveQueue.has(filePath)) {
        dlog("Suppressing save while delayed timer is pending", { filePath, args });
        return;
      }

      return originalSave.apply(this, args);
    };
  }

  private createOnUnloadFileWrapper(originalOnUnloadFile: OnUnloadFileFn): OnUnloadFileFn {
    const controller = this;

    return async function wrappedOnUnloadFile(this: TextFileView, file: TFile) {
      if (controller.pendingSaveQueue.has(file.path) && !controller.fileSwitchingLeaves.has(this.leaf)) {
        dlog("Flushing pending save on file unload", { filePath: file.path });
        await controller.pendingSaveQueue.flush(file.path);
      }

      await originalOnUnloadFile.call(this, file);
    };
  }

  private createRequestSaveWrapper(originalRequestSave: RequestSaveFn): RequestSaveFn {
    const controller = this;

    return function wrappedRequestSave(this: TextFileView, ...args: unknown[]) {
      const filePath = this.file?.path;
      if (!filePath) {
        return originalRequestSave.apply(this, args);
      }

      controller.pendingSaveQueue.schedule(filePath, this);
    };
  }

  private createOpenFileWrapper(originalOpenFile: OpenFileFn): OpenFileFn {
    const controller = this;

    return async function wrappedOpenFile(this: WorkspaceLeaf, ...args: unknown[]) {
      const filePath = controller.getLeafMarkdownFilePath(this);

      controller.fileSwitchingLeaves.add(this);
      if (filePath) {
        controller.filePathsSwitchingInLeaf.add(filePath);
      }

      try {
        return await originalOpenFile.apply(this, args);
      } finally {
        controller.clearLeafSwitchingState(this, filePath);
      }
    };
  }

  private createSetViewStateWrapper(originalSetViewState: SetViewStateFn): SetViewStateFn {
    const controller = this;

    return async function wrappedSetViewState(this: WorkspaceLeaf, ...args: unknown[]) {
      const filePath = controller.getLeafMarkdownFilePath(this);

      controller.fileSwitchingLeaves.add(this);
      if (filePath) {
        controller.filePathsSwitchingInLeaf.add(filePath);
      }

      try {
        return await originalSetViewState.apply(this, args);
      } finally {
        controller.clearLeafSwitchingState(this, filePath);
      }
    };
  }

  private attachWindowObservers(targetWindow: Window | null) {
    if (!targetWindow || this.beforeUnloadListenersByWindow.has(targetWindow)) {
      return;
    }

    this.editActivityTracker.attachToWindow(targetWindow);

    const beforeUnload = () => {
      this.isUnloading = true;
      void this.pendingSaveQueue.flushAll();
    };

    targetWindow.addEventListener("beforeunload", beforeUnload, { capture: true });
    this.beforeUnloadListenersByWindow.set(targetWindow, beforeUnload);
  }

  private detachAllWindowObservers() {
    this.editActivityTracker.detachAll();

    for (const [targetWindow, beforeUnload] of this.beforeUnloadListenersByWindow.entries()) {
      targetWindow.removeEventListener("beforeunload", beforeUnload, { capture: true } as AddEventListenerOptions);
    }

    this.beforeUnloadListenersByWindow.clear();
  }

  private getViewWindow(view: MarkdownView): Window | null {
    return view.containerEl.ownerDocument.defaultView;
  }

  private getLeafMarkdownFilePath(leaf: WorkspaceLeaf): string | null {
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) {
      return null;
    }

    return view.file?.path ?? null;
  }

  private clearLeafSwitchingState(leaf: WorkspaceLeaf, filePath: string | null) {
    window.setTimeout(() => {
      this.fileSwitchingLeaves.delete(leaf);
      if (filePath) {
        this.filePathsSwitchingInLeaf.delete(filePath);
      }
    }, 0);
  }

  private isManualSaveShortcut(event: KeyboardEvent): boolean {
    return this.getSaveHotkeys().some((hotkey) => this.matchesHotkey(event, hotkey));
  }

  private handleManualSaveShortcut(view: MarkdownView, filePath: string, event: KeyboardEvent): boolean {
    if (!this.pendingSaveQueue.has(filePath)) {
      return false;
    }

    dlog("Flushing pending save from manual save shortcut", { filePath });
    event.preventDefault();
    event.stopPropagation();
    void this.pendingSaveQueue.flush(filePath);
    return true;
  }

  private getSaveHotkeys(): Hotkey[] {
    const appWithInternals = this.app as App & {
      hotkeyManager?: { customKeys?: Record<string, Hotkey[]> };
      commands?: { commands?: Record<string, { hotkeys?: Hotkey[] }> };
    };

    const commandId = "editor:save-file";
    const customHotkeys = appWithInternals.hotkeyManager?.customKeys?.[commandId];
    if (customHotkeys && customHotkeys.length > 0) {
      return customHotkeys;
    }

    const defaultHotkeys = appWithInternals.commands?.commands?.[commandId]?.hotkeys;
    if (defaultHotkeys && defaultHotkeys.length > 0) {
      return defaultHotkeys;
    }

    return [{ modifiers: ["Mod"], key: "s" }];
  }

  private matchesHotkey(event: KeyboardEvent, hotkey: Hotkey): boolean {
    if (event.key.toLowerCase() !== hotkey.key.toLowerCase()) {
      return false;
    }

    const normalizedModifiers = new Set(hotkey.modifiers);
    const expectsMod = normalizedModifiers.has("Mod");
    const expectsCtrl = normalizedModifiers.has("Ctrl") || (!Platform.isMacOS && expectsMod);
    const expectsMeta = normalizedModifiers.has("Meta") || (Platform.isMacOS && expectsMod);
    const expectsShift = normalizedModifiers.has("Shift");
    const expectsAlt = normalizedModifiers.has("Alt");

    return (
      event.ctrlKey === expectsCtrl &&
      event.metaKey === expectsMeta &&
      event.shiftKey === expectsShift &&
      event.altKey === expectsAlt
    );
  }
}
