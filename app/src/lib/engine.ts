// Client for the local Holos engine API (`holos serve`).

export const ENGINE_URL = process.env.NEXT_PUBLIC_ENGINE_URL ?? "http://127.0.0.1:8765";

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

export type Question = {
  id: string;
  kind: string;
  source: string;
  start: number;
  end: number;
  text: string;
  before: string;
  after: string;
  reason: string;
  episode_time: number | null;
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
  questions: Question[];
  settings: { language: string; glossary: string[]; model: string; target_lufs: number | null; auto_apply: string[] };
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
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem("holos.token") ?? "";
  } catch {
    return "";
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "X-Holos-Token": token() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${res.status}`;
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
  create: (req: CreateRequest) => call<{ summary: Summary; skipped: FileInfo[] }>("POST", "/api/projects", req),
  summary: (path: string) => call<Summary>("GET", `/api/projects/summary?path=${encodeURIComponent(path)}`),
  process: (path: string) => call<Job>("POST", "/api/projects/process", { path }),
  decide: (path: string, id: string, decision: "cut" | "keep") =>
    call<Summary>("POST", "/api/projects/decision", { path, id, decision }),
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
export const currentProject = {
  get(): string | null {
    try {
      return localStorage.getItem(CURRENT);
    } catch {
      return null;
    }
  },
  set(path: string) {
    try {
      localStorage.setItem(CURRENT, path);
    } catch {}
  },
};
