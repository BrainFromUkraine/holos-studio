// Editor timeline model: the same time mapping the engine renderer uses (engine/src/holos/edit),
// so the playhead, episode timecodes and "result" playback match the exported file.

import { t } from "@/lib/i18n";

export type TlSource = {
  id: string;
  name: string;
  duration: number;
  offset: number; // start in the "original" view (recordings back to back, 1 s apart)
  sr: number;
  channels: number;
  prog_start?: number; // start in the finished episode
  a0?: number; // kept range inside the recording
  b0?: number;
  removals?: [number, number][]; // merged removed ranges (cuts + pause excess), source seconds
  preview?: string; // version key of the processed "Result" copy (changes when its sound changes)
  preview_ready?: boolean; // that copy is made already
};

export type TlEdit = {
  id: string;
  type: "cut" | "pause" | "gain" | "fill";
  kind: string; // retake | repeat | filler | fragment | sound | unclear | manual | pause | breath | fill
  source: string;
  start: number;
  end: number;
  status: "suggested" | "accepted" | "rejected";
  reason: string;
  text?: string;
  before?: string;
  after?: string;
  db?: number;
  target?: number;
  episode_time?: number;
};

export type Word = [string, number, number, number]; // text, start, end, probability

export type Splice = {
  source: string;
  start: number; // removed range in the recording
  end: number;
  removed: number;
  edits: string[];
  kinds: string[];
  episode_time: number;
};

export type Timeline = {
  name: string;
  sample_rate: number;
  crossfade: number;
  gap_view: number;
  original_length: number;
  length: number | null;
  sources: TlSource[];
  edits: TlEdit[];
  words: Record<string, Word[]>;
  splices: Splice[];
  automation: import("./engine").Automation;
  chapters: { title: string; time: number; end: number }[];
  target_lufs: number | null;
  chain: { module: string; enabled: boolean; params: Record<string, unknown> }[];
  measured: { integrated_lufs?: number; lra_lu?: number; true_peak_dbtp?: number } | null;
  history: { can_undo: boolean; can_redo: boolean; undo_label: string | null; redo_label: string | null };
};

/** Edit kind → label (English key; show it with kindLabel() or t()). */
export const KIND_LABEL: Record<string, string> = {
  retake: "Retake",
  repeat: "Repeat",
  filler: "Filler",
  fragment: "Fragment",
  sound: "Sound without words",
  unclear: "Unclear",
  manual: "Manual cut",
  pause: "Pause",
  breath: "Breath",
  fill: "Drop-out",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ? t(KIND_LABEL[kind]) : kind;
}

/** Source time → time inside the assembled clip (port of edit.map_time). */
export function mapTime(t: number, a0: number, removals: [number, number][], xf: number): number {
  let o = t - a0;
  for (const [cs, ce] of removals) {
    if (t >= ce) o -= ce - cs + xf;
    else if (t > cs) o -= t - cs;
  }
  return o;
}

/** Source time → time in the finished episode. */
export function episodeTime(tl: Timeline, sid: string, t: number): number | null {
  const s = tl.sources.find((x) => x.id === sid);
  if (!s || s.prog_start === undefined || s.a0 === undefined || s.b0 === undefined) return null;
  return s.prog_start + mapTime(Math.min(Math.max(t, s.a0), s.b0), s.a0, s.removals ?? [], tl.crossfade);
}

export function isRemoved(s: TlSource, t: number): boolean {
  if (s.a0 === undefined || s.b0 === undefined) return false;
  if (t < s.a0 || t > s.b0) return true;
  return (s.removals ?? []).some(([a, b]) => t >= a && t < b);
}

/** Kept pieces of one recording, in order. */
export function keptPieces(s: TlSource): [number, number][] {
  if (s.a0 === undefined || s.b0 === undefined) return [[0, s.duration]];
  const out: [number, number][] = [];
  let cur = s.a0;
  for (const [a, b] of s.removals ?? []) {
    if (a > cur) out.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (s.b0 > cur) out.push([cur, s.b0]);
  return out;
}

/** "Original" view position ↔ (source, source time). */
export function toView(tl: Timeline, sid: string, t: number): number {
  const s = tl.sources.find((x) => x.id === sid);
  return s ? s.offset + t : 0;
}

export function fromView(tl: Timeline, x: number): { source: TlSource; t: number } | null {
  let best: TlSource | null = null;
  for (const s of tl.sources) {
    if (x >= s.offset - tl.gap_view / 2) best = s;
  }
  if (!best) best = tl.sources[0] ?? null;
  if (!best) return null;
  return { source: best, t: Math.min(Math.max(x - best.offset, 0), best.duration) };
}

/** Episode time → (source, source time), searching the kept pieces. */
export function fromEpisode(tl: Timeline, T: number): { source: TlSource; t: number } | null {
  for (let i = tl.sources.length - 1; i >= 0; i--) {
    const s = tl.sources[i];
    if (s.prog_start === undefined || T < s.prog_start) continue;
    for (const [a, b] of keptPieces(s)) {
      const ea = episodeTime(tl, s.id, a)!;
      const eb = episodeTime(tl, s.id, b)!;
      if (T <= eb) return { source: s, t: Math.max(a, a + (T - ea)) };
    }
    return { source: s, t: s.b0 ?? s.duration };
  }
  return tl.sources[0] ? { source: tl.sources[0], t: tl.sources[0].a0 ?? 0 } : null;
}

export function fmtTc(s: number | null | undefined, ms = true): string {
  if (s == null || !isFinite(s)) return "—";
  const neg = s < 0;
  s = Math.abs(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = ms ? sec.toFixed(3).padStart(6, "0") : String(Math.floor(sec)).padStart(2, "0");
  return `${neg ? "−" : ""}${h ? `${h}:` : ""}${String(m).padStart(2, "0")}:${ss}`;
}

export function fmtShort(s: number | null | undefined): string {
  if (s == null || !isFinite(s)) return "—";
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

/** Words of a source with their index, inside [a, b). */
export function wordsIn(tl: Timeline, sid: string, a: number, b: number): { i: number; w: Word }[] {
  const ws = tl.words[sid] ?? [];
  const out: { i: number; w: Word }[] = [];
  for (let i = 0; i < ws.length; i++) {
    const mid = (ws[i][1] + ws[i][2]) / 2;
    if (mid >= a && mid < b) out.push({ i, w: ws[i] });
  }
  return out;
}

export function joinWords(ws: string[]): string {
  const line: string[] = [];
  for (const w of ws) {
    if (line.length && ("-',.:;!?…)%".includes(w[0]) || "-'(".includes(line[line.length - 1].slice(-1))) && w[0] !== "–") {
      line[line.length - 1] += w;
    } else line.push(w);
  }
  return line.join(" ");
}

/** The engine writes its reasons in English (it is shared with other tools); the app shows them as sentences in the UI language. */
export function reasonText(r: string): string {
  if (!r || r === "manual") return "";
  let m: RegExpMatchArray | null;
  if ((m = r.match(/^redone at the start of the next file \((\d+) matching words\)/))) return t("Redone at the start of the next file ({n} matching words).", { n: m[1] });
  if ((m = r.match(/^restarted: (\d+) words repeat/))) return t("Phrase restarted — {n} words repeat.", { n: m[1] });
  if (r === "filler word") return t("Filler word.");
  if (r === "broken-off word") return t("Broken off mid-word.");
  if (r.startsWith("low recognition confidence")) return t("Low recognition confidence — listen and decide.");
  if (r.startsWith("voiced sound with no transcribed word")) return t("Voiced sound without words — possibly “um”.");
  if ((m = r.match(/^breath \(peak (-?[\d.]+) dBFS\)/))) return t("Breath (peak {db} dBFS).", { db: m[1] });
  if ((m = r.match(/^pause ([\d.]+)s/))) return t("Pause {n} s.", { n: m[1] });
  if (r === "gate drop-out") return t("Background drop-out after the recorder's gate — filled with room tone.");
  return r;
}

/** Text of an edit for display; "sound" edits have no words (old engines wrote "(звук без слів)"). */
export function editText(e: Pick<TlEdit, "kind" | "text">): string {
  return e.kind === "sound" ? t("(sound without words)") : e.text ?? "";
}

/** @deprecated use reasonText */
export const reasonUk = reasonText;
