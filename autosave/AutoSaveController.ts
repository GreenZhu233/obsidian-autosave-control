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
type DetachFn = (this: WorkspaceLeaf) => void;

type BeforeUnloadListener = (event: BeforeUnloadEvent) => void;

export class AutoSaveController {
  private originalSave: SaveFn | null = null;
  private originalRequestSave: RequestSaveFn | null = null;
  private originalOpenFile: OpenFileFn | null = null;
  private originalOnUnloadFile: OnUnloadFileFn | null = null;
  private originalSetViewState: SetViewStateFn | null = null;
  private originalDetach: DetachFn | null = null;
  private isUnloading = false;
  private workspaceLeafChangeEventRef?: EventRef;
  private vaultRenameEventRef?: EventRef;
  private onPendingSaveCountChange?: (pendingSaveCount: number) => void;

  private readonly editActivityTracker: EditActivityTracker;
  private readonly pendingSaveQueue: PendingSaveQueue;
  private readonly beforeUnloadListenersByWindow = new Map<Window, BeforeUnloadListener>();
  private readonly quitShortcutListenersByWindow = new Map<Window, (event: KeyboardEvent) => void>();
  private readonly fileSwitchingLeaves = new WeakSet<WorkspaceLeaf>();
  private readonly filePathsSwitchingInLeaf = new Set<string>();
  private readonly manualSaveRequestTimeoutsByPath = new Map<string, number>();
  private readonly discardedFilePaths = new Set<string>();
  private readonly lastSavedDataByPath = new Map<string, string>();

  constructor(private readonly app: App, private readonly getSettings: () => AutoSaveControlSettings) {
    this.editActivityTracker = new EditActivityTracker(
      () => this.app.workspace.getActiveViewOfType(MarkdownView),
      (view, filePath) => this.pendingSaveQueue.schedule(filePath, view as unknown as TextFileView),
      (event) => this.isManualSaveShortcut(event),
      (view, filePath, event) => this.handleManualSaveShortcut(view, filePath, event),
    );
    this.pendingSaveQueue = new PendingSaveQueue(
      this.app,
      () => this.getSettings().disableAutoSave,
      () => this.getSettings().saveDelaySeconds,
      () => this.originalSave,
      (pendingSaveCount) => this.onPendingSaveCountChange?.(pendingSaveCount),
    );
  }

  setPendingSaveCountChangeHandler(handler: (pendingSaveCount: number) => void) {
    this.onPendingSaveCountChange = handler;
  }

  refreshScheduling() {
    this.pendingSaveQueue.refreshScheduling();
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
    const workspaceLeafViewStatePrototype = WorkspaceLeaf.prototype as unknown as {
      setViewState: SetViewStateFn;
      detach: DetachFn;
    };

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

    this.originalDetach = workspaceLeafViewStatePrototype.detach;
    workspaceLeafViewStatePrototype.detach = this.createDetachWrapper(workspaceLeafViewStatePrototype.detach);

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
        void this.captureLeafSavedData(leaf);
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
    const workspaceLeafViewStatePrototype = WorkspaceLeaf.prototype as unknown as {
      setViewState: SetViewStateFn;
      detach: DetachFn;
    };

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

    if (this.originalDetach) {
      workspaceLeafViewStatePrototype.detach = this.originalDetach;
      this.originalDetach = null;
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
    this.clearManualSaveRequests();
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

      if (controller.discardedFilePaths.has(filePath)) {
        dlog("Suppressing save for discarded file", { filePath, args });
        return;
      }

      if (controller.consumeManualSaveRequest(filePath)) {
        dlog("Allowing manual save", { filePath, args });
        const saveResult = originalSave.apply(this, args);

        if (saveResult instanceof Promise) {
          return saveResult.then(() => {
            controller.captureCurrentViewData(filePath, this as unknown as TextFileView);
          });
        }

        controller.captureCurrentViewData(filePath, this as unknown as TextFileView);
        return saveResult;
      }

      if (controller.shouldHoldSave(this, filePath)) {
        controller.pendingSaveQueue.schedule(filePath, this as unknown as TextFileView);
        dlog("Suppressing non-manual save", { filePath, args });
        return;
      }

      return originalSave.apply(this, args);
    };
  }

  private createOnUnloadFileWrapper(originalOnUnloadFile: OnUnloadFileFn): OnUnloadFileFn {
    const controller = this;

    return async function wrappedOnUnloadFile(this: TextFileView, file: TFile) {
      if (controller.discardedFilePaths.has(file.path)) {
        controller.discardedFilePaths.delete(file.path);
        return;
      }

      if (controller.getSettings().disableAutoSave) {
        await originalOnUnloadFile.call(this, file);
        return;
      }

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

      if (controller.discardedFilePaths.has(filePath)) {
        dlog("Suppressing requestSave for discarded file", { filePath, args });
        return;
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
        void controller.captureLeafSavedData(this);
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
        void controller.captureLeafSavedData(this);
        controller.clearLeafSwitchingState(this, filePath);
      }
    };
  }

  private createDetachWrapper(originalDetach: DetachFn): DetachFn {
    const controller = this;

    return function wrappedDetach(this: WorkspaceLeaf) {
      const filePath = controller.getLeafMarkdownFilePath(this);
      if (
        filePath &&
        controller.getSettings().disableAutoSave &&
        controller.pendingSaveQueue.has(filePath)
      ) {
        const targetWindow = controller.getLeafWindow(this) ?? window;
        const shouldDiscardUnsavedChanges = targetWindow.confirm(
          "This note has unsaved changes. Close it and discard those changes?"
        );

        if (!shouldDiscardUnsavedChanges) {
          return;
        }

        controller.restoreSavedDataIntoLeaf(this, filePath);

        controller.discardedFilePaths.add(filePath);
        controller.pendingSaveQueue.clear(filePath);
      }

      originalDetach.call(this);
    };
  }

  private attachWindowObservers(targetWindow: Window | null) {
    if (!targetWindow || this.beforeUnloadListenersByWindow.has(targetWindow)) {
      return;
    }

    this.editActivityTracker.attachToWindow(targetWindow);

    const quitShortcutListener = (event: KeyboardEvent) => {
      this.handleQuitShortcut(targetWindow, event);
    };
    targetWindow.addEventListener("keydown", quitShortcutListener, true);
    this.quitShortcutListenersByWindow.set(targetWindow, quitShortcutListener);

    const beforeUnload = () => {
      if (this.getSettings().disableAutoSave) {
        return;
      }

      this.isUnloading = true;
      void this.pendingSaveQueue.flushAll();
    };

    const beforeUnloadWithPrompt = (event: BeforeUnloadEvent) => {
      if (this.getSettings().disableAutoSave && this.pendingSaveQueue.hasAny()) {
        event.preventDefault();
        event.returnValue = "You have unsaved changes. Closing Obsidian now will discard them.";
        return;
      }

      beforeUnload();
    };

    targetWindow.addEventListener("beforeunload", beforeUnloadWithPrompt, { capture: true });
    this.beforeUnloadListenersByWindow.set(targetWindow, beforeUnloadWithPrompt);
  }

  private detachAllWindowObservers() {
    this.editActivityTracker.detachAll();

    for (const [targetWindow, beforeUnload] of this.beforeUnloadListenersByWindow.entries()) {
      targetWindow.removeEventListener("beforeunload", beforeUnload, { capture: true } as AddEventListenerOptions);
    }

    for (const [targetWindow, quitShortcutListener] of this.quitShortcutListenersByWindow.entries()) {
      targetWindow.removeEventListener("keydown", quitShortcutListener, true);
    }

    this.beforeUnloadListenersByWindow.clear();
    this.quitShortcutListenersByWindow.clear();
  }

  private getViewWindow(view: MarkdownView): Window | null {
    return view.containerEl.ownerDocument.defaultView;
  }

  private getLeafWindow(leaf: WorkspaceLeaf): Window | null {
    return leaf.view.containerEl.ownerDocument.defaultView;
  }

  private async captureLeafSavedData(leaf: WorkspaceLeaf): Promise<void> {
    const view = leaf.view;
    if (!(view instanceof MarkdownView) || !view.file) {
      return;
    }

    const savedData = await this.app.vault.cachedRead(view.file);
    this.lastSavedDataByPath.set(view.file.path, savedData);
  }

  private captureCurrentViewData(filePath: string, view: TextFileView): void {
    this.lastSavedDataByPath.set(filePath, view.getViewData());
  }

  private restoreSavedDataIntoLeaf(leaf: WorkspaceLeaf, filePath: string): void {
    const savedData = this.lastSavedDataByPath.get(filePath);
    if (savedData === undefined) {
      return;
    }

    const textFileView = leaf.view as TextFileView & { data?: string };
    textFileView.setViewData(savedData, false);
    textFileView.data = savedData;
  }

  private handleQuitShortcut(targetWindow: Window, event: KeyboardEvent): void {
    if (!this.getSettings().disableAutoSave || !this.pendingSaveQueue.hasAny() || !this.isQuitShortcut(event)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const shouldDiscardUnsavedChanges = targetWindow.confirm(
      "You have unsaved changes. Quit Obsidian and discard those changes?"
    );
    if (!shouldDiscardUnsavedChanges) {
      return;
    }

    this.discardAllPendingChanges();
    this.executeQuitCommand(targetWindow);
  }

  private discardAllPendingChanges(): void {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const filePath = this.getLeafMarkdownFilePath(leaf);
      if (!filePath || !this.pendingSaveQueue.has(filePath)) {
        continue;
      }

      this.restoreSavedDataIntoLeaf(leaf, filePath);
      this.discardedFilePaths.add(filePath);
      this.pendingSaveQueue.clear(filePath);
    }
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

  private isQuitShortcut(event: KeyboardEvent): boolean {
    return this.getQuitHotkeys().some((hotkey) => this.matchesHotkey(event, hotkey));
  }

  private handleManualSaveShortcut(view: MarkdownView, filePath: string, event: KeyboardEvent): boolean {
    this.markManualSaveRequested(filePath);

    if (!this.pendingSaveQueue.has(filePath)) {
      return false;
    }

    dlog("Flushing pending save from manual save shortcut", { filePath });
    event.preventDefault();
    event.stopPropagation();
    void this.pendingSaveQueue.flush(filePath);
    return true;
  }

  private shouldHoldSave(view: MarkdownView, filePath: string): boolean {
    if (this.pendingSaveQueue.has(filePath)) {
      return true;
    }

    const textFileView = view as unknown as TextFileView & { data?: string };
    const currentData = textFileView.getViewData?.();
    if (typeof currentData !== "string") {
      return false;
    }

    return textFileView.data !== currentData;
  }

  private markManualSaveRequested(filePath: string): void {
    const existingTimeoutId = this.manualSaveRequestTimeoutsByPath.get(filePath);
    if (existingTimeoutId !== undefined) {
      window.clearTimeout(existingTimeoutId);
    }

    const timeoutId = window.setTimeout(() => {
      this.manualSaveRequestTimeoutsByPath.delete(filePath);
    }, 1000);

    this.manualSaveRequestTimeoutsByPath.set(filePath, timeoutId);
  }

  private consumeManualSaveRequest(filePath: string): boolean {
    const timeoutId = this.manualSaveRequestTimeoutsByPath.get(filePath);
    if (timeoutId === undefined) {
      return false;
    }

    window.clearTimeout(timeoutId);
    this.manualSaveRequestTimeoutsByPath.delete(filePath);
    return true;
  }

  private clearManualSaveRequests(): void {
    for (const timeoutId of this.manualSaveRequestTimeoutsByPath.values()) {
      window.clearTimeout(timeoutId);
    }

    this.manualSaveRequestTimeoutsByPath.clear();
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

  private getQuitHotkeys(): Hotkey[] {
    const appWithInternals = this.app as App & {
      hotkeyManager?: { customKeys?: Record<string, Hotkey[]> };
      commands?: { commands?: Record<string, { hotkeys?: Hotkey[] }> };
    };

    const commandId = "app:quit";
    const customHotkeys = appWithInternals.hotkeyManager?.customKeys?.[commandId];
    if (customHotkeys && customHotkeys.length > 0) {
      return customHotkeys;
    }

    const defaultHotkeys = appWithInternals.commands?.commands?.[commandId]?.hotkeys;
    if (defaultHotkeys && defaultHotkeys.length > 0) {
      return defaultHotkeys;
    }

    return [{ modifiers: ["Mod"], key: "q" }];
  }

  private executeQuitCommand(targetWindow: Window): void {
    const appWithInternals = this.app as App & {
      commands?: { executeCommandById?: (commandId: string) => boolean };
    };

    const didExecuteQuit = appWithInternals.commands?.executeCommandById?.("app:quit");
    if (!didExecuteQuit) {
      targetWindow.close();
    }
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
