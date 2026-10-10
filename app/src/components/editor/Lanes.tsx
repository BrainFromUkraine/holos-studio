"use client";

// Editor lanes drawn on one canvas: ruler, clips, voice waveform, heat-map spectrogram, words, edits,
// breaths and loudness. Time axis = the "original" view (recordings back to back); removed parts are
// shaded so they can be seen, listened to and restored.

import { useCallback, useEffect, useRef, useState } from "react";
import { KIND_LABEL, type Timeline, type TlEdit, type TlSource, joinWords } from "@/lib/timeline";

export type Sel =
  | { kind: "edit"; id: string }
  | { kind: "range"; source: string; a: number; b: number }
  | { kind: "words"; source: string; i0: number; i1: number }
  | null;

export type Assets = {
  peaks: Record<string, { rate: number; data: Int8Array }>;
  spec: Record<string, HTMLImageElement>;
  loud: Record<string, { hop: number; values: number[] }>;
  version: number;
};

export type View = { x0: number; pps: number }; // left edge (s, original axis), pixels per second

export const LANES = [
  { key: "ruler", h: 24, name: "", sub: "" },
  { key: "clips", h: 28, name: "Кліпи", sub: "файли" },
  { key: "wave", h: 118, name: "Голос", sub: "хвиля" },
  { key: "spec", h: 132, name: "Спектр", sub: "60 Гц – 12 кГц" },
  { key: "words", h: 40, name: "Слова", sub: "транскрипт" },
  { key: "edits", h: 46, name: "Правки", sub: "різи · паузи" },
  { key: "breath", h: 22, name: "Вдихи", sub: "і провали фону" },
  { key: "loud", h: 58, name: "Гучність", sub: "ST 3 с · оцінка" },
] as const;
type LaneKey = (typeof LANES)[number]["key"];
export const LANES_MIN_H = LANES.reduce((a, l) => a + l.h, 0);

export type LaneBox = { key: LaneKey; name: string; sub: string; h: number; y: number };

/** Lane boxes for the available height: extra space goes to the voice and the spectrogram. */
export function laneLayout(height: number): LaneBox[] {
  const extra = Math.max(0, Math.min(height, 1400) - LANES_MIN_H);
  let y = 0;
  return LANES.map((l) => {
    const h = l.h + (l.key === "wave" ? Math.round(extra * 0.45) : l.key === "spec" ? Math.round(extra * 0.55) : 0);
    const box = { key: l.key, name: l.name, sub: l.sub, h, y };
    y += h;
    return box;
  });
}

const C = {
  bg: "#080908",
  bg2: "#0a0b0a",
  border: "#262926",
  wave: "#1b5e38",
  core: "#3fd17a",
  text: "#e5e7e5",
  text2: "#aeb3ae",
  muted: "#8b8f8b",
  dim: "#3e423e",
  cut: "#ff4d4d",
  q: "#ffb020",
  breath: "#7a8a7f",
  loud: "#22d3ee",
  sel: "#f4f6f4",
};

type Props = {
  tl: Timeline;
  layout: LaneBox[];
  assets: Assets;
  view: View;
  width: number;
  sel: Sel;
  playheadX: number | null; // original-axis seconds
  onView: (v: View) => void;
  onSelect: (s: Sel) => void;
  onSeek: (sid: string, t: number) => void;
  onAdjust: (id: string, start: number, end: number) => void;
};

type Drag =
  | { kind: "range"; sid: string; t0: number; x0: number; moved: boolean }
  | { kind: "words"; sid: string; i0: number }
  | { kind: "edge"; id: string; edge: "start" | "end"; start: number; end: number; x0: number }
  | null;

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

function editRow(e: TlEdit): "cut" | "pause" | "gain" | "fill" {
  return e.type;
}

function pauseExcess(e: TlEdit): [number, number] | null {
  const ex = e.end - e.start - (e.target ?? 0);
  if (ex <= 0) return null;
  const mid = (e.start + e.end) / 2;
  return [mid - ex / 2, mid + ex / 2];
}

export function Lanes({ tl, layout, assets, view, width, sel, playheadX, onView, onSelect, onSeek, onAdjust }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const LANE_Y: Record<string, number> = Object.fromEntries(layout.map((l) => [l.key, l.y]));
  const laneH = (k: LaneKey) => layout.find((l) => l.key === k)!.h;
  const LANES_H = layout.reduce((a, l) => a + l.h, 0);
  const [drag, setDrag] = useState<Drag>(null);
  const [live, setLive] = useState<{ id: string; start: number; end: number } | null>(null);
  const [cursor, setCursor] = useState("default");

  const sx = useCallback((x: number) => (x - view.x0) * view.pps, [view]); // original-axis seconds → px
  const xs = useCallback((px: number) => view.x0 + px / view.pps, [view]); // px → seconds

  const srcAt = useCallback(
    (v: number): TlSource | null => {
      let best: TlSource | null = null;
      for (const s of tl.sources) if (v >= s.offset - tl.gap_view / 2) best = s;
      return best ?? tl.sources[0] ?? null;
    },
    [tl],
  );

  // ---- drawing ----------------------------------------------------------------------------------
  useEffect(() => {
    const cv = canvas.current;
    if (!cv || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(width * dpr);
    cv.height = Math.round(LANES_H * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.bg2;
    ctx.fillRect(0, 0, width, LANES_H);
    const W = width;
    const vis = tl.sources.filter((s) => sx(s.offset + s.duration) >= 0 && sx(s.offset) <= W);
    const editsById = new Map(tl.edits.map((e) => [e.id, live && live.id === e.id ? { ...e, start: live.start, end: live.end } : e]));
    const edits = [...editsById.values()];

    // lane backgrounds + separators
    for (const l of layout) {
      const y = LANE_Y[l.key];
      ctx.fillStyle = l.key === "ruler" ? "#141614" : l.key === "spec" ? "#000" : C.bg;
      ctx.fillRect(0, y, W, l.h);
      ctx.fillStyle = C.border;
      ctx.fillRect(0, y + l.h - 1, W, 1);
    }

    // ruler
    {
      const y = LANE_Y.ruler;
      const step = STEPS.find((s) => s * view.pps >= 70) ?? 600;
      ctx.font = "10px 'IBM Plex Mono', monospace";
      ctx.textBaseline = "top";
      const first = Math.floor(view.x0 / step) * step;
      for (let t = first; sx(t) < W; t += step) {
        const x = Math.round(sx(t)) + 0.5;
        if (x < 0) continue;
        ctx.fillStyle = C.muted;
        ctx.fillRect(x, y + 14, 1, 10);
        const m = Math.floor(t / 60);
        const s = t - m * 60;
        const label = step < 1 ? `${m}:${s.toFixed(1).padStart(4, "0")}` : `${m}:${String(Math.round(s)).padStart(2, "0")}`;
        ctx.fillText(label, x + 3, y + 3);
        const half = sx(t + step / 2);
        ctx.fillStyle = C.dim;
        ctx.fillRect(Math.round(half), y + 19, 1, 5);
      }
    }

    // clips
    {
      const y = LANE_Y.clips;
      ctx.font = "10px 'IBM Plex Mono', monospace";
      ctx.textBaseline = "middle";
      tl.sources.forEach((s, i) => {
        const x0 = sx(s.offset);
        const x1 = sx(s.offset + s.duration);
        if (x1 < 0 || x0 > W) return;
        ctx.fillStyle = i % 2 ? "#141614" : "#1b1e1b";
        ctx.fillRect(x0, y + 4, x1 - x0 - 1, 20);
        if (s.a0 !== undefined && s.b0 !== undefined) {
          ctx.fillStyle = "rgba(0,0,0,0.55)";
          ctx.fillRect(x0, y + 4, sx(s.offset + s.a0) - x0, 20);
          ctx.fillRect(sx(s.offset + s.b0), y + 4, x1 - sx(s.offset + s.b0), 20);
        }
        ctx.fillStyle = C.core;
        ctx.fillRect(x0, y + 4, 2, 20);
        if (x1 - x0 > 60) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0, y, x1 - x0 - 4, 28);
          ctx.clip();
          ctx.fillStyle = C.text;
          ctx.fillText(s.name.replace(/\.wav$/i, ""), Math.max(x0, 0) + 6, y + 14);
          ctx.restore();
        }
      });
    }

    // waveform
    {
      const y = LANE_Y.wave;
      const h = laneH("wave");
      const mid = y + h / 2;
      const amp = (h / 2 - 4) * 1.6;
      for (const s of vis) {
        const pk = assets.peaks[s.id];
        if (!pk) continue;
        const n = pk.data.length / 2;
        const px0 = Math.max(0, Math.floor(sx(s.offset)));
        const px1 = Math.min(W, Math.ceil(sx(s.offset + s.duration)));
        for (let px = px0; px < px1; px++) {
          const t0 = xs(px) - s.offset;
          const t1 = xs(px + 1) - s.offset;
          let i0 = Math.max(0, Math.floor(t0 * pk.rate));
          const i1 = Math.min(n, Math.max(i0 + 1, Math.ceil(t1 * pk.rate)));
          if (i0 >= n) break;
          let mn = 0;
          let mx = 0;
          let sum = 0;
          for (; i0 < i1; i0++) {
            const a = pk.data[i0 * 2] / 127;
            const b = pk.data[i0 * 2 + 1] / 127;
            if (a < mn) mn = a;
            if (b > mx) mx = b;
            sum += b - a;
          }
          const core = Math.min(1, (sum / Math.max(1, i1 - Math.floor(t0 * pk.rate))) * 0.35);
          const top = Math.max(y + 2, mid - Math.min(1, mx) * amp);
          const bot = Math.min(y + h - 3, mid - Math.max(-1, mn) * amp);
          ctx.fillStyle = C.wave;
          ctx.fillRect(px, top, 1, Math.max(1, bot - top));
          ctx.fillStyle = C.core;
          const c = Math.min(h / 2 - 4, core * amp);
          ctx.fillRect(px, mid - c, 1, Math.max(1, 2 * c));
        }
      }
      ctx.fillStyle = C.border;
      ctx.fillRect(0, mid, W, 1);
    }

    // spectrogram
    {
      const y = LANE_Y.spec;
      const h = laneH("spec") - 1;
      ctx.imageSmoothingEnabled = true;
      for (const s of vis) {
        const img = assets.spec[s.id];
        if (!img || !img.complete || !img.naturalWidth) continue;
        const pxPerSec = img.naturalWidth / s.duration;
        const v0 = Math.max(view.x0, s.offset);
        const v1 = Math.min(xs(W), s.offset + s.duration);
        if (v1 <= v0) continue;
        const srcX = (v0 - s.offset) * pxPerSec;
        const srcW = Math.max(1, (v1 - v0) * pxPerSec);
        ctx.drawImage(img, srcX, 0, srcW, img.naturalHeight, sx(v0), y, sx(v1) - sx(v0), h);
      }
      // frequency grid (mel scale 60 Hz – 12 kHz)
      const mel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
      const m0 = mel(60);
      const m1 = mel(12000);
      ctx.font = "9px 'IBM Plex Mono', monospace";
      ctx.textBaseline = "middle";
      for (const [hz, lab] of [[100, "100"], [250, "250"], [500, "500"], [1000, "1k"], [2000, "2k"], [4000, "4k"], [8000, "8k"]] as [number, string][]) {
        const yy = y + h - ((mel(hz) - m0) / (m1 - m0)) * h;
        ctx.fillStyle = "rgba(255,255,255,0.10)";
        ctx.fillRect(0, Math.round(yy), W, 1);
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillRect(W - 30, yy - 6, 28, 12);
        ctx.fillStyle = C.text2;
        ctx.fillText(lab, W - 27, yy);
      }
    }

    // removed / questioned regions over voice + spectrogram
    {
      const y = LANE_Y.wave;
      const h = laneH("wave") + laneH("spec") - 1;
      for (const s of vis) {
        if (s.a0 !== undefined && s.b0 !== undefined) {
          ctx.fillStyle = "rgba(0,0,0,0.6)";
          ctx.fillRect(sx(s.offset), y, sx(s.offset + s.a0) - sx(s.offset), h);
          ctx.fillRect(sx(s.offset + s.b0), y, sx(s.offset + s.duration) - sx(s.offset + s.b0), h);
        }
      }
      for (const e of edits) {
        const s = tl.sources.find((x) => x.id === e.source);
        if (!s || sx(s.offset + e.end) < 0 || sx(s.offset + e.start) > W) continue;
        if (e.type === "cut" && e.status !== "rejected") {
          const x0 = sx(s.offset + e.start);
          const x1 = sx(s.offset + e.end);
          if (e.status === "accepted") {
            ctx.fillStyle = "rgba(255,77,77,0.22)";
            ctx.fillRect(x0, y, Math.max(1, x1 - x0), h);
            ctx.fillStyle = C.cut;
          } else {
            ctx.fillStyle = "rgba(255,176,32,0.14)";
            ctx.fillRect(x0, y, Math.max(1, x1 - x0), h);
            ctx.fillStyle = C.q;
          }
          ctx.fillRect(x0, y, 1, h);
          ctx.fillRect(x1 - 1, y, 1, h);
        } else if (e.type === "pause" && e.status === "accepted") {
          const ex = pauseExcess(e);
          if (!ex) continue;
          ctx.fillStyle = "rgba(0,0,0,0.5)";
          ctx.fillRect(sx(s.offset + ex[0]), y, Math.max(1, sx(s.offset + ex[1]) - sx(s.offset + ex[0])), h);
        }
      }
    }

    // words
    {
      const y = LANE_Y.words;
      const h = laneH("words");
      ctx.font = "12px 'IBM Plex Sans', system-ui, sans-serif";
      ctx.textBaseline = "middle";
      const removed = (s: TlSource, t: number) => {
        if (s.a0 !== undefined && s.b0 !== undefined && (t < s.a0 || t > s.b0)) return true;
        return edits.some((e) => e.source === s.id && e.status === "accepted" && e.type === "cut" && t >= e.start && t < e.end);
      };
      for (const s of vis) {
        const ws = tl.words[s.id] ?? [];
        let lastEnd = -Infinity;
        ws.forEach(([w, a, b, p], i) => {
          const x0 = sx(s.offset + a);
          const x1 = sx(s.offset + b);
          if (x1 < 0 || x0 > W) return;
          const isSel = sel?.kind === "words" && sel.source === s.id && i >= Math.min(sel.i0, sel.i1) && i <= Math.max(sel.i0, sel.i1);
          const gone = removed(s, (a + b) / 2);
          if (isSel) {
            ctx.fillStyle = "rgba(244,246,244,0.18)";
            ctx.fillRect(x0, y + 3, Math.max(2, x1 - x0), h - 7);
          }
          // every word: a thin bar along the bottom showing its extent
          ctx.fillStyle = gone ? "#6e2222" : p < 0.5 ? "#6a5420" : C.dim;
          ctx.fillRect(x0, y + h - 7, Math.max(1, x1 - x0 - 1), 3);
          // its text above, when there is room after the previous label
          const tw = ctx.measureText(w).width;
          if (x0 >= lastEnd + 4 && view.pps > 12) {
            ctx.fillStyle = gone ? "#9a4a4a" : p < 0.5 ? C.q : C.text;
            ctx.fillText(w, x0 + 1, y + h / 2 - 3);
            if (gone) {
              ctx.fillStyle = "rgba(255,77,77,0.8)";
              ctx.fillRect(x0 + 1, y + h / 2 - 3, tw, 1);
            }
            lastEnd = x0 + tw;
          }
        });
      }
    }

    // edits lane (cuts row, pauses row) + breaths lane
    {
      const yE = LANE_Y.edits;
      const yB = LANE_Y.breath;
      ctx.font = "10px 'IBM Plex Sans', system-ui, sans-serif";
      ctx.textBaseline = "middle";
      for (const e of edits) {
        const s = tl.sources.find((x) => x.id === e.source);
        if (!s) continue;
        const x0 = sx(s.offset + e.start);
        const x1 = sx(s.offset + e.end);
        if (x1 < -2 || x0 > W + 2) continue;
        const w = Math.max(3, x1 - x0);
        const row = editRow(e);
        let ry = yE + 5;
        let rh = 18;
        if (row === "pause") { ry = yE + 27; rh = 13; }
        if (row === "gain") { ry = yB + 4; rh = 9; }
        if (row === "fill") { ry = yB + 14; rh = 6; }
        const col = row === "cut" ? (e.status === "suggested" ? C.q : C.cut) : row === "pause" ? "#6a706a" : row === "gain" ? C.breath : C.dim;
        if (e.status === "rejected") {
          ctx.strokeStyle = C.muted;
          ctx.setLineDash([3, 2]);
          ctx.strokeRect(x0 + 0.5, ry + 0.5, w - 1, rh - 1);
          ctx.setLineDash([]);
        } else {
          ctx.fillStyle = col;
          ctx.globalAlpha = row === "pause" ? 0.7 : 1;
          ctx.fillRect(x0, ry, w, rh);
          ctx.globalAlpha = 1;
        }
        if (row === "cut" && w > 40) {
          ctx.fillStyle = e.status === "rejected" ? C.muted : "#0a0b0a";
          ctx.fillText(KIND_LABEL[e.kind] ?? e.kind, x0 + 4, ry + rh / 2);
        }
        if (sel?.kind === "edit" && sel.id === e.id) {
          ctx.strokeStyle = C.sel;
          ctx.lineWidth = 2;
          ctx.strokeRect(x0 - 1, ry - 1, w + 2, rh + 2);
          ctx.lineWidth = 1;
          // boundary handles
          ctx.fillStyle = C.sel;
          ctx.fillRect(x0 - 2, ry - 3, 4, rh + 6);
          ctx.fillRect(x0 + w - 2, ry - 3, 4, rh + 6);
          // show the edit's extent over the voice + spectrogram too
          ctx.strokeStyle = "rgba(244,246,244,0.6)";
          ctx.strokeRect(x0 + 0.5, LANE_Y.wave + 0.5, w - 1, laneH("wave") + laneH("spec") - 2);
        }
      }
    }

    // loudness
    {
      const y = LANE_Y.loud;
      const h = laneH("loud") - 1;
      const lo = -40;
      const hi = -6;
      const yOf = (v: number) => y + h - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * h;
      const target = tl.target_lufs ?? -16;
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(0, yOf(target) + 0.5);
      ctx.lineTo(W, yOf(target) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = C.loud;
      ctx.lineWidth = 1.5;
      for (const s of vis) {
        const L = assets.loud[s.id];
        if (!L) continue;
        ctx.beginPath();
        let started = false;
        const step = Math.max(1, Math.floor(1 / (L.hop * view.pps) / 2));
        for (let i = 0; i < L.values.length; i += step) {
          const x = sx(s.offset + i * L.hop);
          if (x < -5) continue;
          if (x > W + 5) break;
          const yy = yOf(L.values[i]);
          if (!started) { ctx.moveTo(x, yy); started = true; } else ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }
      ctx.lineWidth = 1;
      ctx.font = "10px 'IBM Plex Mono', monospace";
      ctx.fillStyle = C.text2;
      ctx.textBaseline = "top";
      ctx.fillText(`${target} LUFS`, W - 70, yOf(target) - 13);
    }

    // range selection
    if (sel?.kind === "range") {
      const s = tl.sources.find((x) => x.id === sel.source);
      if (s) {
        const x0 = sx(s.offset + Math.min(sel.a, sel.b));
        const x1 = sx(s.offset + Math.max(sel.a, sel.b));
        ctx.fillStyle = "rgba(244,246,244,0.14)";
        ctx.fillRect(x0, LANE_Y.clips, x1 - x0, LANES_H - LANE_Y.clips);
        ctx.fillStyle = C.sel;
        ctx.fillRect(x0, LANE_Y.clips, 1, LANES_H - LANE_Y.clips);
        ctx.fillRect(x1 - 1, LANE_Y.clips, 1, LANES_H - LANE_Y.clips);
      }
    }
  }, [tl, layout, assets, assets.version, view, width, sel, live, sx, xs]);

  // ---- hit testing ------------------------------------------------------------------------------
  const laneAt = (y: number): LaneKey => {
    let k: LaneKey = "ruler";
    for (const l of layout) if (y >= l.y) k = l.key;
    return k;
  };

  const editAt = (x: number, y: number, lane: LaneKey): { e: TlEdit; edge: "start" | "end" | null } | null => {
    const wanted = lane === "edits" ? (y - LANE_Y.edits < 25 ? ["cut"] : ["pause"]) : lane === "breath" ? (y - LANE_Y.breath < 13 ? ["gain"] : ["fill"]) : [];
    if (!wanted.length) return null;
    let best: { e: TlEdit; edge: "start" | "end" | null; d: number } | null = null;
    for (const e of tl.edits) {
      if (!wanted.includes(e.type)) continue;
      const s = tl.sources.find((q) => q.id === e.source);
      if (!s) continue;
      const x0 = sx(s.offset + e.start);
      const x1 = Math.max(x0 + 3, sx(s.offset + e.end));
      if (x < x0 - 6 || x > x1 + 6) continue;
      const dS = Math.abs(x - x0);
      const dE = Math.abs(x - x1);
      const edge = x1 - x0 > 10 && Math.min(dS, dE) <= 5 ? (dS < dE ? "start" : "end") : null;
      const d = x >= x0 && x <= x1 ? 0 : Math.min(dS, dE);
      if (!best || d < best.d) best = { e, edge, d };
    }
    return best ? { e: best.e, edge: best.edge } : null;
  };

  const wordAt = (x: number): { sid: string; i: number } | null => {
    const v = xs(x);
    const s = srcAt(v);
    if (!s) return null;
    const t = v - s.offset;
    const ws = tl.words[s.id] ?? [];
    let best = -1;
    let bd = Infinity;
    ws.forEach(([, a, b], i) => {
      const d = t < a ? a - t : t > b ? t - b : 0;
      if (d < bd) { bd = d; best = i; }
    });
    return best >= 0 && bd * view.pps < 12 ? { sid: s.id, i: best } : null;
  };

  // ---- pointer ----------------------------------------------------------------------------------
  const local = (ev: React.PointerEvent | React.WheelEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };

  const onDown = (ev: React.PointerEvent) => {
    if (ev.button !== 0) return;
    const { x, y } = local(ev);
    const lane = laneAt(y);
    canvas.current?.setPointerCapture(ev.pointerId);
    if (lane === "edits" || lane === "breath") {
      const hit = editAt(x, y, lane);
      if (hit) {
        onSelect({ kind: "edit", id: hit.e.id });
        if (hit.edge && hit.e.type === "cut") {
          setDrag({ kind: "edge", id: hit.e.id, edge: hit.edge, start: hit.e.start, end: hit.e.end, x0: x });
        }
        return;
      }
    }
    if (lane === "words") {
      const w = wordAt(x);
      if (w) {
        if (ev.shiftKey && sel?.kind === "words" && sel.source === w.sid) {
          onSelect({ ...sel, i1: w.i });
        } else {
          onSelect({ kind: "words", source: w.sid, i0: w.i, i1: w.i });
          setDrag({ kind: "words", sid: w.sid, i0: w.i });
        }
        const s = tl.sources.find((q) => q.id === w.sid)!;
        onSeek(s.id, tl.words[s.id][w.i][1]);
        return;
      }
    }
    const v = xs(x);
    const s = srcAt(v);
    if (!s) return;
    setDrag({ kind: "range", sid: s.id, t0: Math.min(Math.max(v - s.offset, 0), s.duration), x0: x, moved: false });
  };

  const onMove = (ev: React.PointerEvent) => {
    const { x, y } = local(ev);
    if (!drag) {
      const lane = laneAt(y);
      const hit = lane === "edits" || lane === "breath" ? editAt(x, y, lane) : null;
      setCursor(hit?.edge && hit.e.type === "cut" ? "ew-resize" : hit ? "pointer" : lane === "words" ? "text" : "crosshair");
      return;
    }
    if (drag.kind === "range") {
      if (!drag.moved && Math.abs(x - drag.x0) < 3) return;
      const s = tl.sources.find((q) => q.id === drag.sid)!;
      const t = Math.min(Math.max(xs(x) - s.offset, 0), s.duration);
      setDrag({ ...drag, moved: true });
      onSelect({ kind: "range", source: s.id, a: drag.t0, b: t });
    } else if (drag.kind === "words") {
      const w = wordAt(x);
      if (w && w.sid === drag.sid) onSelect({ kind: "words", source: drag.sid, i0: drag.i0, i1: w.i });
    } else if (drag.kind === "edge") {
      const dt = (x - drag.x0) / view.pps;
      const start = drag.edge === "start" ? Math.min(drag.start + dt, drag.end - 0.02) : drag.start;
      const end = drag.edge === "end" ? Math.max(drag.end + dt, drag.start + 0.02) : drag.end;
      setLive({ id: drag.id, start, end });
    }
  };

  const onUp = (ev: React.PointerEvent) => {
    canvas.current?.releasePointerCapture(ev.pointerId);
    if (drag?.kind === "range" && !drag.moved) {
      onSelect(null);
      onSeek(drag.sid, drag.t0);
    }
    if (drag?.kind === "edge" && live) {
      onAdjust(live.id, Math.round(live.start * 1000) / 1000, Math.round(live.end * 1000) / 1000);
    }
    setDrag(null);
    setLive(null);
  };

  // wheel: Ctrl/⌘ + wheel zooms around the pointer, plain wheel scrolls in time
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const wheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const r = cv.getBoundingClientRect();
      const x = ev.clientX - r.left;
      if (ev.ctrlKey || ev.metaKey) {
        const at = view.x0 + x / view.pps;
        const pps = Math.min(2000, Math.max(width / Math.max(1, tl.original_length), view.pps * Math.pow(1.0018, -ev.deltaY)));
        onView({ x0: at - x / pps, pps });
      } else {
        const d = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
        onView({ ...view, x0: view.x0 + d / view.pps });
      }
    };
    cv.addEventListener("wheel", wheel, { passive: false });
    return () => cv.removeEventListener("wheel", wheel);
  }, [view, width, tl.original_length, onView]);

  const ph = playheadX === null ? null : sx(playheadX);

  return (
    <div style={{ position: "relative", height: LANES_H }}>
      <canvas
        ref={canvas}
        style={{ display: "block", width, height: LANES_H, cursor, touchAction: "none" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        aria-label="Доріжки епізоду"
        role="img"
      />
      {ph !== null && ph >= 0 && ph <= width && (
        <div aria-hidden="true" style={{ position: "absolute", top: 0, bottom: 0, left: Math.round(ph), width: 1, background: "#f4f6f4", pointerEvents: "none" }} />
      )}
    </div>
  );
}

export function selectionText(tl: Timeline, sel: Sel): string {
  if (!sel || sel.kind === "edit") return "";
  if (sel.kind === "words") {
    const ws = tl.words[sel.source] ?? [];
    const a = Math.min(sel.i0, sel.i1);
    const b = Math.max(sel.i0, sel.i1);
    return joinWords(ws.slice(a, b + 1).map((w) => w[0]));
  }
  const a = Math.min(sel.a, sel.b);
  const b = Math.max(sel.a, sel.b);
  return joinWords((tl.words[sel.source] ?? []).filter((w) => (w[1] + w[2]) / 2 >= a && (w[1] + w[2]) / 2 < b).map((w) => w[0]));
}
