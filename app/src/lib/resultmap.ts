// The editor shows the FINISHED episode (cuts closed, like a ripple edit in DaVinci). These helpers map
// between episode time T and positions in the recordings, using the same mapping as the engine.

import { episodeTime, keptPieces, type Timeline } from "./timeline";

export type Piece = { sid: string; a: number; b: number; T0: number; T1: number };
export type ClipBox = { sid: string; name: string; T0: number; T1: number };

export function buildPieces(tl: Timeline): Piece[] {
  const out: Piece[] = [];
  for (const s of tl.sources) {
    for (const [a, b] of keptPieces(s)) {
      if (b - a < 0.001) continue;
      const T0 = episodeTime(tl, s.id, a);
      if (T0 === null) continue;
      out.push({ sid: s.id, a, b, T0, T1: T0 + (b - a) });
    }
  }
  return out;
}

export function clipBoxes(tl: Timeline, pieces: Piece[]): ClipBox[] {
  const out: ClipBox[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last && last.sid === p.sid) last.T1 = p.T1;
    else out.push({ sid: p.sid, name: tl.sources.find((s) => s.id === p.sid)?.name.replace(/\.(wav|flac|mp3|m4a)$/i, "") ?? p.sid, T0: p.T0, T1: p.T1 });
  }
  return out;
}

/** Index of the piece containing T (or the last one starting before it). */
export function pieceIndex(pieces: Piece[], T: number): number {
  let lo = 0;
  let hi = pieces.length - 1;
  if (hi < 0) return -1;
  if (T <= pieces[0].T0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pieces[mid].T0 <= T) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function toSource(pieces: Piece[], T: number): { sid: string; t: number } | null {
  const i = pieceIndex(pieces, T);
  if (i < 0) return null;
  const p = pieces[i];
  return { sid: p.sid, t: Math.min(p.b, Math.max(p.a, p.a + (T - p.T0))) };
}

/** Episode range → per-recording ranges to cut (removed parts inside are harmless: already cut). */
export function rangeToSources(pieces: Piece[], A: number, B: number): { source: string; start: number; end: number }[] {
  const lo = Math.min(A, B);
  const hi = Math.max(A, B);
  const out: { source: string; start: number; end: number }[] = [];
  for (const p of pieces) {
    if (p.T1 <= lo || p.T0 >= hi) continue;
    const s = p.a + Math.max(0, lo - p.T0);
    const e = p.a + Math.min(p.b - p.a, hi - p.T0);
    const last = out[out.length - 1];
    if (last && last.source === p.sid) last.end = e;
    else out.push({ source: p.sid, start: s, end: e });
  }
  return out.filter((r) => r.end - r.start > 0.005);
}

export function fmtEp(T: number | null | undefined, ms = false): string {
  if (T == null || !isFinite(T)) return "—";
  const t = Math.max(0, T);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = ms ? s.toFixed(3).padStart(6, "0") : s.toFixed(1).padStart(4, "0");
  return `${h ? `${h}:` : ""}${String(m).padStart(2, "0")}:${ss}`;
}
