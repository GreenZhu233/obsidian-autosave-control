export interface AutoSaveControlSettings {
  disableAutoSave: boolean;
  saveDelaySeconds: number;
  savedStatusColor: string;
  pendingStatusColor: string;
  statusIconSizePx: number;
}

export const DEFAULT_SETTINGS: AutoSaveControlSettings = {
  disableAutoSave: false,
  saveDelaySeconds: 10,
  savedStatusColor: "#32cd32",
  pendingStatusColor: "#00bfff",
  statusIconSizePx: 16,
};
