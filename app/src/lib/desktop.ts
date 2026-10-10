// Desktop (Tauri) integrations with graceful fallbacks when running in a plain browser.

export const AUDIO_EXTENSIONS = ["wav", "WAV", "flac", "FLAC", "mp3", "MP3", "m4a", "M4A", "aif", "aiff"];

export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function pickAudioFiles(): Promise<string[]> {
  if (!isDesktop()) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ multiple: true, directory: false, filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }] });
  if (!res) return [];
  return Array.isArray(res) ? res : [res];
}

export async function pickProjectPath(defaultPath?: string): Promise<string | null> {
  if (!isDesktop()) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return save({ defaultPath, filters: [{ name: "Holos project", extensions: ["holos"] }] });
}

/** Files dropped on the window (desktop only). Returns an unsubscribe function. */
export async function onFilesDropped(cb: (paths: string[]) => void, onHover?: (over: boolean) => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === "over" || p.type === "enter") onHover?.(true);
    else if (p.type === "leave") onHover?.(false);
    else if (p.type === "drop") {
      onHover?.(false);
      cb(p.paths.filter((x) => AUDIO_EXTENSIONS.some((e) => x.endsWith(`.${e}`))));
    }
  });
  return unlisten;
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i > 0 ? p.slice(0, i) : p;
}

export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

export async function pickFile(filters: string[], defaultPath?: string): Promise<string | null> {
  if (!isDesktop()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const exts = filters.flatMap((e) => [e.toLowerCase(), e.toUpperCase()]);
  const res = await open({ multiple: false, directory: false, defaultPath, filters: exts.length ? [{ name: "Files", extensions: exts }] : [] });
  return typeof res === "string" ? res : null;
}

export async function pickFolder(defaultPath?: string): Promise<string | null> {
  if (!isDesktop()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ multiple: false, directory: true, defaultPath });
  return typeof res === "string" ? res : null;
}

/** Show a file in Explorer / Finder (desktop only). */
export async function revealFile(path: string): Promise<boolean> {
  if (!isDesktop()) return false;
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
  return true;
}
