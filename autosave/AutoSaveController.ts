import { App, EditorPosition, EventRef, Hotkey, MarkdownView, Platform, Tasks, TextFileView, TFile, WorkspaceLeaf } from "obsidian";
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
type SaveCommandCheckCallback = (checking: boolean) => boolean | void;
type WrappedFunction<T extends Function> = T & { __ascOriginal?: T; __ascOwner?: AutoSaveController };
const MANUAL_SAVE_REQUEST_TTL_MS = 5000;

type BeforeUnloadListener = (event: BeforeUnloadEvent) => void;

export class AutoSaveController {
  private originalSave: SaveFn | null = null;
  private originalRequestSave: RequestSaveFn | null = null;
  private originalOpenFile: OpenFileFn | null = null;
  private originalOnUnloadFile: OnUnloadFileFn | null = null;
  private originalSetViewState: SetViewStateFn | null = null;
  private originalDetach: DetachFn | null = null;
  private originalSaveCommandCheckCallback: SaveCommandCheckCallback | null = null;
  private installedSaveWrapper: SaveFn | null = null;
  private installedRequestSaveWrapper: RequestSaveFn | null = null;
  private installedOpenFileWrapper: OpenFileFn | null = null;
  private installedOnUnloadFileWrapper: OnUnloadFileFn | null = null;
  private installedSetViewStateWrapper: SetViewStateFn | null = null;
  private installedDetachWrapper: DetachFn | null = null;
  private installedSaveCommandCheckCallback: SaveCommandCheckCallback | null = null;
  private isUnloading = false;
  private workspaceLeafChangeEventRef?: EventRef;
  private workspaceQuitEventRef?: EventRef;
  private vaultRenameEventRef?: EventRef;
  private onPendingSaveCountChange?: (pendingSaveCount: number) => void;

  private readonly editActivityTracker: EditActivityTracker;
  private readonly pendingSaveQueue: PendingSaveQueue;

  isPathExcluded(filePath: string): boolean {
    const excludedPatterns = this.getSettings().excludedPaths;
    if (!excludedPatterns || excludedPatterns.length === 0) {
      return false;
    }

    const normalizedPath = filePath.replace(/\\/g, "/");

    return excludedPatterns.some((pattern) => {
      const trimmedPattern = pattern.trim();

      // Skip empty patterns and comments
      if (!trimmedPattern || trimmedPattern.startsWith("#")) {
        return false;
      }

      // Regex pattern: starts with "r/" and ends with "/"
      if (trimmedPattern.startsWith("r/") && trimmedPattern.endsWith("/")) {
        const regexPattern = trimmedPattern.slice(2, -1);
        try {
          const regex = new RegExp(regexPattern);
          return regex.test(normalizedPath);
        } catch {
          dlog("Invalid regex pattern in excluded path", { pattern: regexPattern });
          return false;
        }
      }

      // Gitignore-style pattern matching
      return this.matchGitignorePattern(normalizedPath, trimmedPattern);
    });
  }

  private matchGitignorePattern(path: string, pattern: string): boolean {
    // Handle negation (not implemented, skip)
    if (pattern.startsWith("!")) {
      return false;
    }

    // Handle trailing / (directory only)
    const isDirectoryPattern = pattern.endsWith("/");
    const cleanPattern = isDirectoryPattern ? pattern.slice(0, -1) : pattern;

    // Split pattern into parts by /
    const patternParts = cleanPattern.split("/");
    const pathParts = path.split("/");

    // If pattern starts with /, it must match from the root
    const matchFromRoot = cleanPattern.startsWith("/");
    const effectivePatternStart = matchFromRoot ? 0 : Math.max(0, pathParts.length - patternParts.length);

    // Handle ** (globstar) - matches any number of directories
    const hasGlobstar = patternParts.some((part) => part === "**");

    if (hasGlobstar) {
      return this.matchWithGlobstar(pathParts, patternParts, effectivePatternStart, isDirectoryPattern);
    }

    // Simple pattern matching (no **)
    let patternIdx = 0;
    let pathIdx = effectivePatternStart;

    // For patterns without /, they can match anywhere
    if (!cleanPattern.includes("/")) {
      pathIdx = 0;
    }

    while (patternIdx < patternParts.length && pathIdx < pathParts.length) {
      const p = patternParts[patternIdx];
      const n = pathParts[pathIdx];

      if (p === "**") {
        // ** followed by nothing = match everything
        if (patternIdx === patternParts.length - 1) {
          return true;
        }
        // ** followed by pattern part - try matching at each position
        const nextPattern = patternParts[patternIdx + 1];
        while (pathIdx < pathParts.length) {
          if (this.matchSinglePart(pathParts[pathIdx], nextPattern)) {
            if (this.matchParts(pathParts, patternParts, pathIdx + 1, patternIdx + 2)) {
              return true;
            }
          }
          pathIdx++;
        }
        return false;
      }

      if (!this.matchSinglePart(n, p)) {
        // If pattern doesn't start with /, allow matching anywhere
        if (!matchFromRoot && patternIdx === 0 && pathIdx === 0) {
          pathIdx++;
          continue;
        }
        return false;
      }

      patternIdx++;
      pathIdx++;
    }

    // Handle trailing ** in pattern
    if (patternParts[patternParts.length - 1] === "**") {
      return true;
    }

    // Check if we've matched all pattern parts
    if (patternIdx !== patternParts.length) {
      return false;
    }

    // Check if we've consumed all path parts (or directory match)
    if (pathIdx !== pathParts.length && !isDirectoryPattern) {
      return false;
    }

    return true;
  }

  private matchWithGlobstar(pathParts: string[], patternParts: string[], startIdx: number, isDirectoryPattern: boolean): boolean {
    // Find the globstar position
    const globstarIdx = patternParts.findIndex((p) => p === "**");
    const beforeGlobstar = patternParts.slice(0, globstarIdx);
    const afterGlobstar = patternParts.slice(globstarIdx + 1);

    // Match the part before **
    if (beforeGlobstar.length > 0) {
      const beforeStart = startIdx;
      const beforeEnd = beforeStart + beforeGlobstar.length;
      if (beforeEnd > pathParts.length) {
        return false;
      }
      for (let i = 0; i < beforeGlobstar.length; i++) {
        if (!this.matchSinglePart(pathParts[beforeStart + i], beforeGlobstar[i])) {
          return false;
        }
      }
    }

    // Match the part after **
    if (afterGlobstar.length > 0) {
      let foundMatch = false;
      for (let i = pathParts.length; i >= 0; i--) {
        let pathIdx = i;
        let patternIdx = 0;
        let matched = true;

        while (patternIdx < afterGlobstar.length && pathIdx < pathParts.length) {
          if (!this.matchSinglePart(pathParts[pathIdx], afterGlobstar[patternIdx])) {
            matched = false;
            break;
          }
          patternIdx++;
          pathIdx++;
        }

        if (matched && patternIdx === afterGlobstar.length) {
          if (pathIdx === pathParts.length || !isDirectoryPattern) {
            foundMatch = true;
            break;
          }
        }
      }
      return foundMatch;
    }

    return true;
  }

  private matchParts(pathParts: string[], patternParts: string[], pathStart: number, patternStart: number): boolean {
    let pathIdx = pathStart;
    let patternIdx = patternStart;

    while (patternIdx < patternParts.length && pathIdx < pathParts.length) {
      const p = patternParts[patternIdx];
      const n = pathParts[pathIdx];

      if (p === "**") {
        if (patternIdx === patternParts.length - 1) {
          return true;
        }
        patternIdx++;
        continue;
      }

      if (!this.matchSinglePart(n, p)) {
        return false;
      }

      patternIdx++;
      pathIdx++;
    }

    return patternIdx === patternParts.length;
  }

  private matchSinglePart(name: string, pattern: string): boolean {
    let regexPattern = "";
    let i = 0;

    while (i < pattern.length) {
      const char = pattern[i];

      if (char === "*") {
        // Check for **
        if (pattern[i + 1] === "*") {
          regexPattern += ".*";
          i += 2;
          continue;
        }
        // Single * matches anything except /
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
        // Character class
        const closeIdx = pattern.indexOf("]", i);
        if (closeIdx !== -1) {
          regexPattern += pattern.slice(i, closeIdx + 1);
          i = closeIdx + 1;
          continue;
        }
      }

      // Escape regex special characters
      if ("\\.+^${}|()[]^".includes(char)) {
        regexPattern += "\\" + char;
      } else {
        regexPattern += char;
      }

      i++;
    }

    try {
      const regex = new RegExp("^" + regexPattern + "$");
      return regex.test(name);
    } catch {
      // Fallback to exact match
      return name === pattern;
    }
  }
  private readonly beforeUnloadListenersByWindow = new Map<Window, BeforeUnloadListener>();
  private readonly quitShortcutListenersByWindow = new Map<Window, (event: KeyboardEvent) => void>();
  private readonly fileSwitchingLeaves = new WeakSet<WorkspaceLeaf>();
  private readonly pendingRestoreCountsByPath = new Map<string, number>();
  private readonly manualSaveRequestTimeoutsByPath = new Map<string, number>();
  private readonly discardedFilePaths = new Set<string>();
  private readonly lastSavedDataByPath = new Map<string, string>();
  private readonly cursorPositionByPath = new Map<string, EditorPosition>();

  constructor(private readonly app: App, private readonly getSettings: () => AutoSaveControlSettings) {
    this.editActivityTracker = new EditActivityTracker(
      () => this.app.workspace.getActiveViewOfType(MarkdownView),
      (view, filePath) => {
        if (this.isRestoringPendingData(filePath)) {
          return;
        }

        if (this.isPathExcluded(filePath)) {
          return;
        }

        this.pendingSaveQueue.schedule(filePath, view as unknown as TextFileView);
      },
      (event) => this.isManualSaveShortcut(event),
      (view, filePath, event) => this.handleManualSaveShortcut(view, filePath, event),
      (filePath) => this.isPathExcluded(filePath),
    );
    this.pendingSaveQueue = new PendingSaveQueue(
      this.app,
      () => this.getSettings().disableAutoSave,
      () => this.getSettings().saveDelaySeconds,
      () => this.originalSave,
      () => this.isUnloading,
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

    this.originalSave = this.unwrapWrappedFunction(markdownViewPrototype.save);
    this.installedSaveWrapper = this.createSaveWrapper(this.originalSave);
    markdownViewPrototype.save = this.installedSaveWrapper;

    if (typeof textFileViewPrototype.requestSave === "function") {
      this.originalRequestSave = this.unwrapWrappedFunction(textFileViewPrototype.requestSave);
      this.installedRequestSaveWrapper = this.createRequestSaveWrapper(this.originalRequestSave);
      textFileViewPrototype.requestSave = this.installedRequestSaveWrapper;
    }

    this.originalOnUnloadFile = this.unwrapWrappedFunction(textFileViewPrototype.onUnloadFile);
    this.installedOnUnloadFileWrapper = this.createOnUnloadFileWrapper(this.originalOnUnloadFile);
    textFileViewPrototype.onUnloadFile = this.installedOnUnloadFileWrapper;

    this.originalOpenFile = this.unwrapWrappedFunction(workspaceLeafPrototype.openFile);
    this.installedOpenFileWrapper = this.createOpenFileWrapper(this.originalOpenFile);
    workspaceLeafPrototype.openFile = this.installedOpenFileWrapper;

    this.originalSetViewState = this.unwrapWrappedFunction(workspaceLeafViewStatePrototype.setViewState);
    this.installedSetViewStateWrapper = this.createSetViewStateWrapper(this.originalSetViewState);
    workspaceLeafViewStatePrototype.setViewState = this.installedSetViewStateWrapper;

    this.originalDetach = this.unwrapWrappedFunction(workspaceLeafViewStatePrototype.detach);
    this.installedDetachWrapper = this.createDetachWrapper(this.originalDetach);
    workspaceLeafViewStatePrototype.detach = this.installedDetachWrapper;

    this.wrapSaveCommand();

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

    this.workspaceQuitEventRef = this.app.workspace.on("quit", (tasks: Tasks) => {
      this.pendingSaveQueue.refreshAllLatestData();
      if (!this.getSettings().disableAutoSave && this.pendingSaveQueue.hasAny()) {
        tasks.add(async () => {
          await this.pendingSaveQueue.flushAll();
          this.isUnloading = true;
          this.exitApplicationAfterFlush();
        });
        return;
      }

      this.isUnloading = true;
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

    if (this.originalSave && markdownViewPrototype.save === this.installedSaveWrapper) {
      markdownViewPrototype.save = this.originalSave;
    }
    this.originalSave = null;
    this.installedSaveWrapper = null;

    if (this.originalRequestSave && textFileViewPrototype.requestSave === this.installedRequestSaveWrapper) {
      textFileViewPrototype.requestSave = this.originalRequestSave;
    }
    this.originalRequestSave = null;
    this.installedRequestSaveWrapper = null;

    if (this.originalOnUnloadFile && textFileViewPrototype.onUnloadFile === this.installedOnUnloadFileWrapper) {
      textFileViewPrototype.onUnloadFile = this.originalOnUnloadFile;
    }
    this.originalOnUnloadFile = null;
    this.installedOnUnloadFileWrapper = null;

    if (this.originalOpenFile && workspaceLeafPrototype.openFile === this.installedOpenFileWrapper) {
      workspaceLeafPrototype.openFile = this.originalOpenFile;
    }
    this.originalOpenFile = null;
    this.installedOpenFileWrapper = null;

    if (
      this.originalSetViewState &&
      workspaceLeafViewStatePrototype.setViewState === this.installedSetViewStateWrapper
    ) {
      workspaceLeafViewStatePrototype.setViewState = this.originalSetViewState;
    }
    this.originalSetViewState = null;
    this.installedSetViewStateWrapper = null;

    if (this.originalDetach && workspaceLeafViewStatePrototype.detach === this.installedDetachWrapper) {
      workspaceLeafViewStatePrototype.detach = this.originalDetach;
    }
    this.originalDetach = null;
    this.installedDetachWrapper = null;

    this.restoreSaveCommand();

    if (this.workspaceLeafChangeEventRef) {
      this.app.workspace.offref(this.workspaceLeafChangeEventRef);
      this.workspaceLeafChangeEventRef = undefined;
    }

    if (this.vaultRenameEventRef) {
      this.app.vault.offref(this.vaultRenameEventRef);
      this.vaultRenameEventRef = undefined;
    }

    if (this.workspaceQuitEventRef) {
      this.app.workspace.offref(this.workspaceQuitEventRef);
      this.workspaceQuitEventRef = undefined;
    }

    this.detachAllWindowObservers();
    this.clearManualSaveRequests();
    this.pendingSaveQueue.clearAll();
    this.isUnloading = false;

    dlog("Autosave wrapper disabled");
  }

  private createSaveWrapper(originalSave: SaveFn): SaveFn {
    const controller = this;

    const wrappedSave = function wrappedSave(this: MarkdownView, ...args: unknown[]) {
      const filePath = this.file?.path;
      if (!filePath) {
        return originalSave.apply(this, args);
      }

      if (controller.isPathExcluded(filePath)) {
        dlog("Skipping save wrapper for excluded file", { filePath });
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
            controller.pendingSaveQueue.clear(filePath);
            controller.captureCurrentViewData(filePath, this as unknown as TextFileView);
          });
        }

        controller.pendingSaveQueue.clear(filePath);
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

    return this.markWrappedFunction(wrappedSave, originalSave);
  }

  private createOnUnloadFileWrapper(originalOnUnloadFile: OnUnloadFileFn): OnUnloadFileFn {
    const controller = this;

    const wrappedOnUnloadFile = async function wrappedOnUnloadFile(this: TextFileView, file: TFile) {
      if (controller.isPathExcluded(file.path)) {
        dlog("Skipping onUnloadFile wrapper for excluded file", { filePath: file.path });
        return originalOnUnloadFile.call(this, file);
      }

      if (controller.discardedFilePaths.has(file.path)) {
        controller.discardedFilePaths.delete(file.path);
        return;
      }

      controller.syncPendingDataForFile(file.path);

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

    return this.markWrappedFunction(wrappedOnUnloadFile, originalOnUnloadFile);
  }

  private createRequestSaveWrapper(originalRequestSave: RequestSaveFn): RequestSaveFn {
    const controller = this;

    const wrappedRequestSave = function wrappedRequestSave(this: TextFileView, ...args: unknown[]) {
      const filePath = this.file?.path;
      if (!filePath) {
        return originalRequestSave.apply(this, args);
      }

      if (controller.isPathExcluded(filePath)) {
        dlog("Skipping requestSave wrapper for excluded file", { filePath });
        return originalRequestSave.apply(this, args);
      }

      if (controller.discardedFilePaths.has(filePath)) {
        dlog("Suppressing requestSave for discarded file", { filePath, args });
        return;
      }

      if (controller.isRestoringPendingData(filePath)) {
        dlog("Suppressing requestSave during pending-data restore", { filePath, args });
        return;
      }

      if (controller.hasManualSaveRequest(filePath)) {
        dlog("Allowing manual requestSave", { filePath, args });
        controller.markManualSaveRequested(filePath);
        return originalRequestSave.apply(this, args);
      }

      controller.pendingSaveQueue.schedule(filePath, this);
    };

    return this.markWrappedFunction(wrappedRequestSave, originalRequestSave);
  }

  private createOpenFileWrapper(originalOpenFile: OpenFileFn): OpenFileFn {
    const controller = this;

    const wrappedOpenFile = async function wrappedOpenFile(this: WorkspaceLeaf, ...args: unknown[]) {
      controller.syncLeafPendingData(this);
      controller.fileSwitchingLeaves.add(this);

      try {
        return await originalOpenFile.apply(this, args);
      } finally {
        void controller.captureLeafSavedData(this);
        controller.schedulePendingDataRestoreInLeaf(this);
        controller.scheduleLeafCursorRestore(this);
        controller.clearLeafSwitchingState(this);
      }
    };

    return this.markWrappedFunction(wrappedOpenFile, originalOpenFile);
  }

  private createSetViewStateWrapper(originalSetViewState: SetViewStateFn): SetViewStateFn {
    const controller = this;

    const wrappedSetViewState = async function wrappedSetViewState(this: WorkspaceLeaf, ...args: unknown[]) {
      controller.syncLeafPendingData(this);
      controller.fileSwitchingLeaves.add(this);

      try {
        return await originalSetViewState.apply(this, args);
      } finally {
        void controller.captureLeafSavedData(this);
        controller.schedulePendingDataRestoreInLeaf(this);
        controller.scheduleLeafCursorRestore(this);
        controller.clearLeafSwitchingState(this);
      }
    };

    return this.markWrappedFunction(wrappedSetViewState, originalSetViewState);
  }

  private createDetachWrapper(originalDetach: DetachFn): DetachFn {
    const controller = this;

    const wrappedDetach = function wrappedDetach(this: WorkspaceLeaf) {
      const filePath = controller.getLeafMarkdownFilePath(this);
      if (filePath && controller.isPathExcluded(filePath)) {
        dlog("Skipping detach wrapper for excluded file", { filePath });
        return originalDetach.call(this);
      }

      if (filePath) {
        controller.syncPendingDataForFile(filePath);
      }

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

    return this.markWrappedFunction(wrappedDetach, originalDetach);
  }

  private markWrappedFunction<T extends Function>(wrapper: T, original: T): T {
    const wrappedFunction = wrapper as WrappedFunction<T>;
    wrappedFunction.__ascOriginal = original;
    wrappedFunction.__ascOwner = this;
    return wrapper;
  }

  private unwrapWrappedFunction<T extends Function>(fn: T): T {
    return (fn as WrappedFunction<T>).__ascOriginal ?? fn;
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
      this.isUnloading = true;
    };

    const beforeUnloadWithPrompt = (event: BeforeUnloadEvent) => {
      if (!this.getSettings().disableAutoSave) {
        return;
      }

      this.pendingSaveQueue.refreshAllLatestData();

      if (this.pendingSaveQueue.hasAny()) {
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

  private syncPendingDataForFile(filePath: string): void {
    this.pendingSaveQueue.refreshLatestData(filePath);
  }

  private syncLeafPendingData(leaf: WorkspaceLeaf): void {
    const filePath = this.getLeafMarkdownFilePath(leaf);
    if (!filePath) {
      return;
    }

    this.captureLeafCursorPosition(leaf, filePath);
    this.syncPendingDataForFile(filePath);
  }

  private captureLeafCursorPosition(leaf: WorkspaceLeaf, filePath: string): void {
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) {
      return;
    }

    this.cursorPositionByPath.set(filePath, view.editor.getCursor());
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

  private restorePendingDataIntoLeaf(view: TextFileView & { data?: string }, filePath: string): void {
    if (this.isUnloading) {
      return;
    }

    const pendingData = this.pendingSaveQueue.getLatestData(filePath);
    if (pendingData === null) {
      return;
    }

    this.markPendingDataRestoreStarted(filePath);

    view.setViewData(pendingData, false);
    view.data = pendingData;
    this.pendingSaveQueue.touchView(filePath, view);
    this.markPendingDataRestoreFinished(filePath);
  }

  private schedulePendingDataRestoreInLeaf(leaf: WorkspaceLeaf): void {
    window.setTimeout(() => {
      if (this.isUnloading) {
        return;
      }

      const filePath = this.getLeafMarkdownFilePath(leaf);
      if (!filePath || !this.pendingSaveQueue.has(filePath)) {
        return;
      }

      if (!(leaf.view instanceof MarkdownView)) {
        return;
      }

      this.restorePendingDataIntoLeaf(leaf.view as unknown as TextFileView & { data?: string }, filePath);
    }, 0);
  }

  private scheduleLeafCursorRestore(leaf: WorkspaceLeaf): void {
    window.setTimeout(() => {
      if (this.isUnloading) {
        return;
      }

      const filePath = this.getLeafMarkdownFilePath(leaf);
      if (!filePath || !(leaf.view instanceof MarkdownView)) {
        return;
      }

      const cursorPosition = this.cursorPositionByPath.get(filePath);
      if (!cursorPosition) {
        return;
      }

      leaf.view.editor.setCursor(cursorPosition);
    }, 0);
  }

  private handleQuitShortcut(targetWindow: Window, event: KeyboardEvent): void {
    if (!this.getSettings().disableAutoSave || !this.pendingSaveQueue.hasAny() || !this.isQuitShortcut(event)) {
      return;
    }

    this.pendingSaveQueue.refreshAllLatestData();

    const shouldDiscardUnsavedChanges = targetWindow.confirm(
      "You have unsaved changes. Quit Obsidian and discard those changes?"
    );
    if (!shouldDiscardUnsavedChanges) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    this.discardAllPendingChanges();
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

  private clearLeafSwitchingState(leaf: WorkspaceLeaf) {
    window.setTimeout(() => {
      this.fileSwitchingLeaves.delete(leaf);
    }, 0);
  }

  private isRestoringPendingData(filePath: string): boolean {
    return (this.pendingRestoreCountsByPath.get(filePath) ?? 0) > 0;
  }

  private markPendingDataRestoreStarted(filePath: string): void {
    this.pendingRestoreCountsByPath.set(filePath, (this.pendingRestoreCountsByPath.get(filePath) ?? 0) + 1);
  }

  private markPendingDataRestoreFinished(filePath: string): void {
    window.setTimeout(() => {
      const pendingRestoreCount = this.pendingRestoreCountsByPath.get(filePath);
      if (pendingRestoreCount === undefined) {
        return;
      }

      if (pendingRestoreCount <= 1) {
        this.pendingRestoreCountsByPath.delete(filePath);
        return;
      }

      this.pendingRestoreCountsByPath.set(filePath, pendingRestoreCount - 1);
    }, 0);
  }

  private isManualSaveShortcut(event: KeyboardEvent): boolean {
    return this.getSaveHotkeys().some((hotkey) => this.matchesHotkey(event, hotkey));
  }

  private isQuitShortcut(event: KeyboardEvent): boolean {
    return this.getQuitHotkeys().some((hotkey) => this.matchesHotkey(event, hotkey));
  }

  private handleManualSaveShortcut(_view: MarkdownView, filePath: string, event: KeyboardEvent): boolean {
    this.markManualSaveRequested(filePath);
    dlog("Allowing manual save shortcut to continue through Obsidian save command", {
      filePath,
      key: event.key,
    });
    return false;
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
    }, MANUAL_SAVE_REQUEST_TTL_MS);

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

  private hasManualSaveRequest(filePath: string): boolean {
    return this.manualSaveRequestTimeoutsByPath.has(filePath);
  }

  private clearManualSaveRequests(): void {
    for (const timeoutId of this.manualSaveRequestTimeoutsByPath.values()) {
      window.clearTimeout(timeoutId);
    }

    this.manualSaveRequestTimeoutsByPath.clear();
  }

  private exitApplicationAfterFlush(): void {
    const globalState = window as typeof window & { require?: any };
    const electron = globalState.require?.("electron");

    try {
      electron?.remote?.app?.exit?.(0);
      return;
    } catch {
      // fall through to softer quit paths
    }

    try {
      electron?.remote?.app?.quit?.();
      return;
    } catch {
      // fall through to softer quit paths
    }

    try {
      electron?.ipcRenderer?.send?.("app:quit");
    } catch {
      // no supported explicit quit path available
    }
  }

  private wrapSaveCommand(): void {
    const controller = this;
    const saveCommandDefinition = this.getSaveCommandDefinition();
    if (!saveCommandDefinition || typeof saveCommandDefinition.checkCallback !== "function") {
      return;
    }

    const checkCallback = this.unwrapWrappedFunction(saveCommandDefinition.checkCallback);
    this.originalSaveCommandCheckCallback = checkCallback;
    const wrappedCheckCallback = function (this: unknown, checking: boolean) {
      if (!checking) {
        controller.markActiveFileManualSaveRequested();
      }

      return checkCallback.call(this, checking);
    };

    this.installedSaveCommandCheckCallback = this.markWrappedFunction(wrappedCheckCallback, checkCallback);
    saveCommandDefinition.checkCallback = this.installedSaveCommandCheckCallback;
  }

  private restoreSaveCommand(): void {
    const saveCommandDefinition = this.getSaveCommandDefinition();
    if (!saveCommandDefinition || !this.originalSaveCommandCheckCallback) {
      this.originalSaveCommandCheckCallback = null;
      this.installedSaveCommandCheckCallback = null;
      return;
    }

    if (saveCommandDefinition.checkCallback === this.installedSaveCommandCheckCallback) {
      saveCommandDefinition.checkCallback = this.originalSaveCommandCheckCallback;
    }

    this.originalSaveCommandCheckCallback = null;
    this.installedSaveCommandCheckCallback = null;
  }


  private markActiveFileManualSaveRequested(): void {
    const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
    const filePath = activeMarkdownView?.file?.path;
    if (!filePath) {
      return;
    }

    this.markManualSaveRequested(filePath);
  }

  private getSaveCommandDefinition(): { checkCallback?: SaveCommandCheckCallback } | null {
    const appWithInternals = this.app as App & {
      commands?: { commands?: Record<string, { checkCallback?: SaveCommandCheckCallback }> };
    };

    return appWithInternals.commands?.commands?.["editor:save-file"] ?? null;
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
