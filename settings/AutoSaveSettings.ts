export interface AutoSaveControlSettings {
  saveDelaySeconds: number;
  savedStatusColor: string;
  pendingStatusColor: string;
}

export const DEFAULT_SETTINGS: AutoSaveControlSettings = {
  saveDelaySeconds: 10,
  savedStatusColor: "#32cd32",
  pendingStatusColor: "#00bfff",
};
