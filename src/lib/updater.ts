import { check, type Update } from "@tauri-apps/plugin-updater";

export interface UpdateInfo {
  version: string;
  notes: string | null;
  update: Update;
}

/**
 * Check for an update.
 * Returns the update handle when one is available, or null otherwise.
 * Errors (offline, missing endpoint, bad pubkey) are swallowed and logged.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const update = await check();
    if (!update?.available) return null;
    return {
      version: update.version,
      notes: update.body ?? null,
      update,
    };
  } catch (e) {
    console.warn("update check failed:", e);
    return null;
  }
}
