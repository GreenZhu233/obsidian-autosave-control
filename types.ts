// src/types.ts
import type { TFile, TextFileView } from "obsidian";

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