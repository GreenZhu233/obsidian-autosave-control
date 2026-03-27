import { App, EventRef, MarkdownView, TextFileView } from "obsidian";
import { dlog } from "../debug";
import type { AutoSaveControlSettings } from "../settings/AutoSaveSettings";
import { EditActivityTracker } from "./EditActivityTracker";
import { PendingSaveQueue } from "./PendingSaveQueue";

type SaveFn = (this: MarkdownView, ...args: unknown[]) => Promise<void> | void;

type BeforeUnloadListener = () => void;

const OBSIDIAN_AUTOSAVE_GRACE_MS = 2100;

export class AutoSaveController {
  private originalSave: SaveFn | null = null;
  private isUnloading = false;
  private workspaceLeafChangeEventRef?: EventRef;
  private onPendingSaveCountChange?: (pendingSaveCount: number) => void;

  private readonly editActivityTracker: EditActivityTracker;
  private readonly pendingSaveQueue: PendingSaveQueue;
  private readonly beforeUnloadListenersByWindow = new Map<Window, BeforeUnloadListener>();

  constructor(private readonly app: App, private readonly getSettings: () => AutoSaveControlSettings) {
    this.editActivityTracker = new EditActivityTracker(() => this.app.workspace.getActiveViewOfType(MarkdownView));
    this.pendingSaveQueue = new PendingSaveQueue(
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
    this.originalSave = markdownViewPrototype.save;
    markdownViewPrototype.save = this.createSaveWrapper(markdownViewPrototype.save);

    this.isUnloading = false;
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
    if (this.originalSave) {
      markdownViewPrototype.save = this.originalSave;
      this.originalSave = null;
    }

    if (this.workspaceLeafChangeEventRef) {
      this.app.workspace.offref(this.workspaceLeafChangeEventRef);
      this.workspaceLeafChangeEventRef = undefined;
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

      if (controller.isUnloading) {
        controller.pendingSaveQueue.clear(filePath);
        controller.pendingSaveQueue.clearGracePeriod(filePath);
        return originalSave.apply(this, args);
      }

      const now = Date.now();
      const lastEditActivityAt = controller.editActivityTracker.getLastEditActivityAt(filePath);
      const millisecondsSinceLastEdit = now - lastEditActivityAt;
      const isInsideObsidianAutosaveGracePeriod =
        millisecondsSinceLastEdit >= 0 && millisecondsSinceLastEdit <= OBSIDIAN_AUTOSAVE_GRACE_MS;

      dlog("Save called", { filePath, millisecondsSinceLastEdit });

      if (!isInsideObsidianAutosaveGracePeriod) {
        controller.pendingSaveQueue.clear(filePath);
        controller.pendingSaveQueue.clearGracePeriod(filePath);
        return originalSave.apply(this, args);
      }

      if (controller.pendingSaveQueue.isRepeatedSaveForSameEditBurst(filePath, now, lastEditActivityAt)) {
        controller.pendingSaveQueue.clear(filePath);
        controller.pendingSaveQueue.clearGracePeriod(filePath);
        return originalSave.apply(this, args);
      }

      controller.pendingSaveQueue.schedule(filePath, this as TextFileView);
      controller.pendingSaveQueue.setGracePeriod(filePath, lastEditActivityAt, OBSIDIAN_AUTOSAVE_GRACE_MS);
      return;
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
}
