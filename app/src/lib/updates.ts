// App updates from GitHub Releases (tauri-plugin-updater). The endpoint and public key live in
// src-tauri/tauri.conf.json → plugins.updater; releases are signed by CI (docs/RELEASING.md).

import { inTauri } from "./engineHost";
import { t } from "./i18n";

export type AvailableUpdate = {
  version: string;
  currentVersion: string;
  notes: string | null;
  date: string | null;
};

export type UpdateProgress = { downloaded: number; total: number | null };

// The plugin's Update object (holds a Rust-side resource) for the last positive check.
let pending: import("@tauri-apps/plugin-updater").Update | null = null;

/**
 * Ask GitHub Releases whether a newer version exists. `null` = up to date, not the desktop app, a dev build,
 * or the check failed (offline) — updates are never worth an error screen.
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!inTauri() || process.env.NODE_ENV !== "production") return null;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check({ timeout: 15000 });
    if (!update) return null;
    if (pending && pending !== update) await pending.close().catch(() => {});
    pending = update;
    return { version: update.version, currentVersion: update.currentVersion, notes: update.body ?? null, date: update.date ?? null };
  } catch (e) {
    console.warn("update check failed", e);
    return null;
  }
}

/**
 * Download (with progress), install and restart. On Windows the installer closes the app and starts the new
 * version itself, so this promise usually never resolves there.
 */
export async function installUpdate(onProgress?: (p: UpdateProgress) => void): Promise<void> {
  if (!pending) throw new Error(t("No update to install"));
  let downloaded = 0;
  let total: number | null = null;
  await pending.downloadAndInstall((ev) => {
    if (ev.event === "Started") total = ev.data.contentLength ?? null;
    else if (ev.event === "Progress") downloaded += ev.data.chunkLength;
    else if (ev.event === "Finished") downloaded = total ?? downloaded;
    onProgress?.({ downloaded, total });
  });
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
