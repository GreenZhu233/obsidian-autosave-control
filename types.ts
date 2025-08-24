// src/types.ts
import type { TFile, TextFileView } from "obsidian";

export interface AutoSaveControlSettings {
  saveInterval: number;        // seconds
}

export const DEFAULT_SETTINGS: AutoSaveControlSettings = {
  saveInterval: 10,
};

export type Pending = {
  file: TFile;
  view: TextFileView;
  timeoutId: number;
};