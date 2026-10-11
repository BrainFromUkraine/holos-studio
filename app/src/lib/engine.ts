import type { Timeline } from "./timeline";
import { t } from "./i18n";

// Client for the local Holos engine API (`holos serve`).

let ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL ?? "http://127.0.0.1:8765";
let ENGINE_TOKEN: string | null = null;

/** The desktop app starts the engine itself and passes its address and token here. */
export function setEngineConnection(url: string, tok: string) {
  ENGINE_URL = url.replace(/\/$/, "");
  ENGINE_TOKEN = tok;
}
export const engineUrl = () => ENGINE_URL;

export type Health = {
  name: string;
  version: string;
  ffmpeg: string | null;
  asr: boolean;
  cuda_devices: number | null;
  auth: boolean;
};

export type FileInfo = {
  path: string;
  name: string;
  sha256: string;
  sr: number;
  channels: number;
  duration: number;
  duplicate_of: string | null;
};

export type Summary = {
  name: string;
  sample_rate: number;
  sources: { id: string; name: string; path: string; duration: number; sr: number; channels: number; loudness_lufs: number | null; words: number }[];
  recorded_s: number;
  edited_s: number | null;
  analyzed: number;
  transcribed: number;
  counts: Record<string, Record<string, number>>;
  settings: { language: string; glossary: string[]; model: string; target_lufs: number | null; automation: Automation };
  chapters: Chapter[];
  chapter_warnings: string[];
  export: ExportSettings;
};

export type Automation = {
  pauses: boolean;
  pause_max: number;
  pause_target: number;
  breaths: "duck" | "cut" | "off";
  breath_db: number;
  clicks: "off" | "light" | "normal" | "strong";
  kinds: Record<string, "cut" | "keep">;
  fill_dropouts: boolean;
  level_match: boolean;
  crossfade_ms: number;
  target_lufs: number;
  voice: Record<string, boolean>;
};

export type ProjectRow = {
  path: string;
  name: string;
  folder: string;
  modified: number;
  length: number | null;
  recorded: number;
  files: number;
  status: "processing" | "ready" | "exported" | "new";
  chapters: number;
  thumb: number[];
};

export type Settings = { projects_dir: string; home: string; templates_dir: string; mcp_last_seen: number | null; mcp_config?: unknown; version?: string };

export type Chapter = { title: string; time: number; end: number; origin: string; source: string; at: number };

export type ExportSettings = {
  wav: boolean;
  wav_bits: number;
  channels: number;
  mp3: boolean;
  mp3_kbps: number;
  chapters_txt: boolean;
  chapters_embed: boolean;
  video: { template: string | null; params: Record<string, unknown> };
};

export type TemplateParam = {
  key: string;
  label: string;
  type: "file" | "int" | "float" | "choice" | "bool" | "text";
  arg: string;
  required: boolean;
  default: unknown;
  help: string;
  min: number | null;
  max: number | null;
  step: number | null;
  options: { value: string; label: string }[];
  filters: string[];
  auto: "increment" | null;
};

export type TemplateInfo = {
  id: string;
  name: string;
  kind: string;
  description: string;
  params: TemplateParam[];
  preview: boolean;
  builtin: boolean;
  dir: string;
  missing: string[];
  install: string;
  ready: boolean;
  initial: Record<string, unknown>;
};

export type ExportRequest = {
  path: string;
  out_dir?: string | null;
  name?: string | null;
  wav?: boolean;
  mp3?: boolean;
  chapters_txt?: boolean;
  chapters_embed?: boolean;
  video?: { template: string | null; params: Record<string, unknown> } | null;
  preview?: number;
};

export type ExportResult = {
  out_dir: string;
  files: Record<string, string>;
  chapters: Chapter[];
  warnings: string[];
  duration_s: number | null;
  measured: { integrated_lufs?: number; true_peak_dbtp?: number; lra_lu?: number } | null;
  seconds: number;
  preview: boolean;
};

export type EditRequest = {
  path: string;
  op: "status" | "adjust" | "cut" | "cuts" | "cut_words" | "delete" | "undo" | "redo";
  ranges?: { source: string; start: number; end: number }[];
  ids?: string[];
  status?: "accepted" | "rejected" | "suggested";
  id?: string;
  source?: string;
  start?: number;
  end?: number;
  snap?: "start" | "end" | "both" | boolean;
  i0?: number;
  i1?: number;
};

export type Job = {
  id: string;
  kind: string;
  project: string;
  state: "queued" | "running" | "done" | "error";
  stage: string;
  done: number;
  total: number;
  detail: string;
  result: unknown;
  error: string | null;
  elapsed: number;
};

export type CreateRequest = {
  path: string;
  files: string[];
  name?: string;
  language?: string;
  glossary?: string[];
  target_lufs?: number;
  auto_apply?: string[];
};

function token(): string {
  if (ENGINE_TOKEN !== null) return ENGINE_TOKEN;
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem("holos.token") ?? "";
  } catch {
    return "";
  }
}

/** Thrown when the engine cannot be reached at all (not running / wrong port). Check with `instanceof`, not the text. */
export class EngineDownError extends Error {
  constructor() {
    super(t("The engine is not responding."));
    this.name = "EngineDownError";
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${ENGINE_URL}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Holos-Token": token() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new EngineDownError();
  }
  if (!res.ok) {
    let msg = t("The engine returned error {status}", { status: res.status });
    try {
      const j = await res.json();
      msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail ?? j);
    } catch {}
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const engine = {
  health: () => call<Health>("GET", "/api/health"),
  inspect: (files: string[]) => call<FileInfo[]>("POST", "/api/files/inspect", { files }),
  create: (req: CreateRequest) => call<{ path: string; summary: Summary; skipped: FileInfo[] }>("POST", "/api/projects", req),
  summary: (path: string) => call<Summary>("GET", `/api/projects/summary?path=${encodeURIComponent(path)}`),
  process: (path: string) => call<Job>("POST", "/api/projects/process", { path }),
  projects: () => call<{ root: string; projects: ProjectRow[] }>("GET", "/api/projects/list"),
  newEpisode: (req: { name: string; files: string[]; automation?: Partial<Automation>; language?: string; glossary?: string[] }) =>
    call<Job>("POST", "/api/episodes", req),
  open: (path: string) => call<Summary>("POST", "/api/projects/open", { path }),
  stamp: (path: string) => call<{ mtime: number | null }>("GET", `/api/projects/stamp?path=${encodeURIComponent(path)}`),
  setAutomation: (path: string, changes: Partial<Automation>) =>
    call<Timeline>("PUT", "/api/projects/automation", { path, changes }),
  automationDefaults: () => call<Automation>("GET", "/api/automation/defaults"),
  saveAutomationDefaults: (automation: Automation) => call<Automation>("PUT", "/api/automation/defaults", { automation }),
  settings: () => call<Settings>("GET", "/api/settings"),
  saveSettings: (s: { projects_dir?: string }) => call<Settings>("PUT", "/api/settings", s),
  preview: (path: string, template: string, params: Record<string, unknown>, seconds = 6) =>
    call<{ video: string; poster: string; key: string }>("POST", "/api/templates/preview", { path, template, params, seconds }),
  /** A file from a project's cache (previews), for <video>/<img>. */
  cacheUrl(file: string): string {
    return `${ENGINE_URL}/api/files/cache?path=${encodeURIComponent(file)}&token=${encodeURIComponent(token())}`;
  },
  templates: (path?: string) =>
    call<{ user_dir: string; templates: TemplateInfo[] }>("GET", `/api/templates${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  setChapters: (path: string, chapters: { time: number; title: string }[]) =>
    call<Summary>("PUT", "/api/projects/chapters", { path, chapters }),
  exportProject: (req: ExportRequest) => call<Job>("POST", "/api/projects/export", req),
  timeline: (path: string) => call<Timeline>("GET", `/api/projects/timeline?path=${encodeURIComponent(path)}`),
  edit: (req: EditRequest) => call<Timeline & { id?: string; undone?: string | null; redone?: string | null }>("POST", "/api/projects/edit", req),
  /** URL for <audio>/<img> (they can't send headers, so the token goes in the query). */
  assetUrl(kind: "audio" | "spectrogram", path: string, source: string): string {
    return `${ENGINE_URL}/api/projects/${kind}?path=${encodeURIComponent(path)}&source=${encodeURIComponent(source)}&token=${encodeURIComponent(token())}`;
  },
  async peaks(path: string, source: string): Promise<{ rate: number; data: Int8Array }> {
    const res = await fetch(`${ENGINE_URL}/api/projects/peaks?path=${encodeURIComponent(path)}&source=${encodeURIComponent(source)}`, {
      headers: { "X-Holos-Token": token() },
    });
    if (!res.ok) throw new Error(`peaks ${res.status}`);
    return { rate: Number(res.headers.get("X-Peaks-Rate") ?? 200), data: new Int8Array(await res.arrayBuffer()) };
  },
  loudness: (path: string, source: string) =>
    call<{ hop: number; values: number[] }>("GET", `/api/projects/loudness?path=${encodeURIComponent(path)}&source=${encodeURIComponent(source)}`),
  job: (id: string) => call<Job>("GET", `/api/jobs/${id}`),
  /** Streams job progress; returns a function that stops listening. */
  watch(jobId: string, onUpdate: (j: Job) => void): () => void {
    const es = new EventSource(`${ENGINE_URL}/api/jobs/${jobId}/events?token=${encodeURIComponent(token())}`);
    es.onmessage = (ev) => {
      const j = JSON.parse(ev.data) as Job;
      onUpdate(j);
      if (j.state === "done" || j.state === "error") es.close();
    };
    es.onerror = () => es.close();
    return () => es.close();
  },
};

export function fmtDuration(s: number | null | undefined): string {
  if (s == null) return "—";
  const m = Math.floor(s / 60);
  const r = Math.round(s - m * 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function fmtTimecode(s: number | null | undefined): string {
  if (s == null) return "—";
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

const CURRENT = "holos.currentProject";
const CURRENT_NAME = "holos.currentProjectName";
export const currentProject = {
  get(): string | null {
    try {
      return localStorage.getItem(CURRENT);
    } catch {
      return null;
    }
  },
  name(): string | null {
    try {
      return localStorage.getItem(CURRENT_NAME);
    } catch {
      return null;
    }
  },
  set(path: string, name?: string) {
    try {
      localStorage.setItem(CURRENT, path);
      if (name) localStorage.setItem(CURRENT_NAME, name);
      window.dispatchEvent(new Event("holos-project"));
    } catch {}
  },
  clear() {
    try {
      localStorage.removeItem(CURRENT);
      localStorage.removeItem(CURRENT_NAME);
      window.dispatchEvent(new Event("holos-project"));
    } catch {}
  },
};

/** "75", "1:15", "01:15.5", "1:01:15" → seconds; null if not a time. */
export function parseTimecode(v: string): number | null {
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(":");
  if (parts.length < 2 || parts.length > 3 || !parts.every((x) => /^\d+(\.\d+)?$/.test(x))) return null;
  return parts.reduce((acc, x) => acc * 60 + Number(x), 0);
}

/** YouTube style: 00:00, 1:02:03 for long episodes. */
export function fmtClock(s: number, hours = false): string {
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return hours || h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
