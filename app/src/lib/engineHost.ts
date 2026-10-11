// Where the engine runs and how to reach it — answered by the desktop shell (src-tauri/src/engine.rs).
//
// Packaged app: the shell creates the Python environment on first run, starts `holos serve` on a free port with a
// random token and reports it here. `tauri dev` and a plain browser: the engine is started by hand
// (`uv run holos serve --dev`) on http://127.0.0.1:8765 without a token — state "dev".

import { useEffect, useState } from "react";

export type EngineState = "dev" | "setup" | "starting" | "ready" | "error";

export type EngineInfo = {
  state: EngineState;
  /** Base URL of the engine API, e.g. "http://127.0.0.1:51234" (empty until "ready"). */
  url: string;
  /** Value for the `X-Holos-Token` header / `?token=` query ("" = no auth, dev). */
  token: string;
  error: string | null;
  /** Last lines of uv / engine output. */
  log_tail: string[];
};

export const DEV_ENGINE: EngineInfo = {
  state: "dev",
  url: process.env.NEXT_PUBLIC_ENGINE_URL ?? "http://127.0.0.1:8765",
  token: "",
  error: null,
  log_tail: [],
};

const STARTING: EngineInfo = { state: "starting", url: "", token: "", error: null, log_tail: [] };

/** True inside the Tauri window (false in a plain browser / during static export). */
export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** The engine can be called: packaged engine is up, or dev mode (engine started by hand). */
export function engineUsable(info: EngineInfo): boolean {
  return info.state === "ready" || info.state === "dev";
}

/** Headers for a fetch() to the engine. */
export function engineHeaders(info: EngineInfo): Record<string, string> {
  return info.token ? { "X-Holos-Token": info.token } : {};
}

export async function getEngineInfo(): Promise<EngineInfo> {
  if (!inTauri()) return DEV_ENGINE;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<EngineInfo>("engine_info");
}

/** Kill the engine (or a running setup) and bring it up again — the "Спробувати ще раз" button. */
export async function restartEngine(): Promise<EngineInfo> {
  if (!inTauri()) return DEV_ENGINE;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<EngineInfo>("engine_restart");
}

/** Every state change. Returns an unsubscribe function. */
export async function onEngineState(cb: (info: EngineInfo) => void): Promise<() => void> {
  if (!inTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<EngineInfo>("engine-state", (e) => cb(e.payload));
}

/** Each output line of the first-run setup (`uv sync`). Returns an unsubscribe function. */
export async function onSetupLine(cb: (line: string) => void): Promise<() => void> {
  if (!inTauri()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ line: string }>("engine-setup", (e) => cb(e.payload.line));
}

/** JSON for Claude Desktop's claude_desktop_config.json (pretty-printed, ready to copy). */
export async function getMcpConfig(): Promise<string> {
  if (!inTauri()) {
    return JSON.stringify(
      { mcpServers: { "holos-studio": { command: "uv", args: ["--directory", "<repo>/engine", "run", "holos", "mcp"] } } },
      null,
      2,
    );
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>("mcp_config");
}

/**
 * Live engine info for React: initial `engine_info`, then `engine-state` events.
 * Outside Tauri it is DEV_ENGINE and never changes.
 */
export function useEngineInfo(): EngineInfo {
  // Same first render on the server (static export) and in the window — no hydration mismatch.
  // The effect replaces it right away (with DEV_ENGINE outside Tauri).
  const [info, setInfo] = useState<EngineInfo>(STARTING);

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    // Subscribe first, then read the current state, so a change in between is not missed.
    onEngineState((i) => alive && setInfo(i)).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    getEngineInfo()
      .then((i) => alive && setInfo(i))
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return info;
}
