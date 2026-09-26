import { invoke } from "@tauri-apps/api/core";

export type UpdateInfo = {
  version: string;
  releaseUrl: string;
};

export function checkForUpdate(): Promise<UpdateInfo | null> {
  return invoke<UpdateInfo | null>("check_for_update");
}

export function isUpdateDismissed(version: string): Promise<boolean> {
  return invoke<boolean>("monitor_is_update_dismissed", { version });
}

export function dismissUpdateVersion(version: string): Promise<void> {
  return invoke<void>("monitor_dismiss_update", { version });
}
