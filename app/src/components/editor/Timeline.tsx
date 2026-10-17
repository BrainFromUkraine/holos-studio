"use client";

// DaVinci-style timeline of the FINISHED episode: one voice track with the recordings as clips, splices where
// audio was removed, chapter markers, heat-map spectrogram and loudness. Drawn on one canvas.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t, useLang } from "@/lib/i18n";
import { pieceIndex, type ClipBox, type Piece } from "@/lib/resultmap";
import type { Timeline as Tl } from "@/lib/timeline";

export type Tool = "select" | "blade" | "range";
export type ESel =
  | { kind: "splice"; i: number }
  | { kind: "range"; A: number; B: number }
  | { kind: "marker"; i: number }
  | null;
export type View = { x0: number; pps: number };
export type Assets = {
  peaks: Record<string, { rate: number; data: Int8Array }>;
  spec: Record<string, HTMLImageElement>;
  loud: Record<string, { hop: number; values: number[] }>;
  version: number;
};

export const RULER_H = 26;
export const MARK_H = 28;
export const SPEC_H = 140;
export const LOUD_H = 60;

const C = {
  bg: "#0A0B0A", lane: "#080908", border: "#262926", clip: "#0D1A12", clipLine: "#23452F", clipHead: "#1B3A27",
  wave: "#1B5E38", core: "#3FD17A", text: "#E5E7E5", text2: "#AEB3AE", muted: "#8B8F8B", dim: "#3E423E",
  cut: "#FF4D4D", pause: "#8B8F8B", sel: "#F4F6F4", loud: "#22D3EE", marker: "#3FD17A",
};

// short lowercase kind names for splice tags (English keys, translated with t())
const KIND_SHORT: Record<string, string> = { repeat: "repeat", retake: "retake", filler: "filler", fragment: "fragment", sound: "sound", unclear: "unclear", manual: "manual cut", pause: "pause" };
export function spliceLabel(kinds: string[]): string {
  const k = kinds.filter((x) => x !== "pause");
  return k.length ? k.map((x) => (KIND_SHORT[x] ? t(KIND_SHORT[x]) : x)).join(" + ") : t("pause");
}

/** Splice tag on the track: "repeat + filler −1.2 s". */
function spliceTag(kinds: string[], removed: number): string {
  return `${spliceLabel(kinds)} −${t("{n} s", { n: removed.toFixed(1) })}`;
}

type Props = {
  tl: Tl;
  pieces: Piece[];
  clips: ClipBox[];
  assets: Assets;
  view: View;
  vzoom: number; // waveform height multiplier (vertical zoom), 1 = fit
  width: number;
  height: number;
  tool: Tool;
  sel: ESel;
  splits: number[];
  playhead: number;
  showSpec: boolean;
  onView: (v: View) => void;
  onSelect: (s: ESel) => void;
  onSeek: (T: number) => void;
  onSplit: (T: number) => void;
  onMarkerMove: (i: number, T: number) => void;
  onMarkerAdd: (T: number) => void;
};

type Drag =
  | { kind: "range"; A: number; x0: number; moved: boolean; lane: string }
  | { kind: "marker"; i: number; x0: number; T: number; moved: boolean }
  | { kind: "scrub" }
  | null;

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

export function useLayout(height: number, showSpec: boolean) {
  return useMemo(() => {
    const spec = showSpec ? SPEC_H : 0;
    const track = Math.max(140, height - RULER_H - MARK_H - spec - LOUD_H);
    let y = 0;
    const L = { ruler: { y, h: RULER_H }, markers: { y: (y += RULER_H), h: MARK_H }, track: { y: (y += MARK_H), h: track }, spec: { y: (y += track), h: spec }, loud: { y: (y += spec), h: LOUD_H } };
    return { ...L, total: y + LOUD_H };
  }, [height, showSpec]);
}

export function TimelineCanvas(props: Props) {
  const { tl, pieces, clips, assets, view, vzoom, width, tool, sel, splits, playhead, showSpec, onView, onSelect, onSeek, onSplit, onMarkerMove, onMarkerAdd } = props;
  const lang = useLang();
  const cv = useRef<HTMLCanvasElement>(null);
  const L = useLayout(props.height, showSpec);
  const [drag, setDrag] = useState<Drag>(null);
  const [liveMarker, setLiveMarker] = useState<{ i: number; T: number } | null>(null);
  const [cursor, setCursor] = useState("default");

  const sx = useCallback((T: number) => (T - view.x0) * view.pps, [view]);
  const xs = useCallback((px: number) => view.x0 + px / view.pps, [view]);
  const markers = useMemo(() => tl.chapters.map((c, i) => (liveMarker && liveMarker.i === i ? { ...c, time: liveMarker.T } : c)), [tl.chapters, liveMarker]);

  // ---- draw -------------------------------------------------------------------------------------
  useEffect(() => {
    const c = cv.current;
    if (!c || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(L.total * dpr);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = width;
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, L.total);

    // ruler (episode time)
    ctx.fillStyle = "#141614";
    ctx.fillRect(0, L.ruler.y, W, L.ruler.h);
    const step = STEPS.find((s) => s * view.pps >= 80) ?? 600;
    ctx.font = "10px 'IBM Plex Mono', monospace";
    ctx.textBaseline = "top";
    for (let t = Math.floor(view.x0 / step) * step; sx(t) < W; t += step) {
      const x = Math.round(sx(t)) + 0.5;
      if (x < -60) continue;
      ctx.fillStyle = C.muted;
      ctx.fillRect(x, L.ruler.y + 15, 1, 11);
      const m = Math.floor(t / 60);
      const s = t - m * 60;
      ctx.fillText(step < 1 ? `${m}:${s.toFixed(1).padStart(4, "0")}` : `${m}:${String(Math.round(s)).padStart(2, "0")}`, x + 4, L.ruler.y + 4);
      ctx.fillStyle = C.dim;
      ctx.fillRect(Math.round(sx(t + step / 2)), L.ruler.y + 20, 1, 6);
    }

    // markers lane (chapters)
    ctx.fillStyle = "#0D0F0D";
    ctx.fillRect(0, L.markers.y, W, L.markers.h);
    ctx.font = "600 11px 'IBM Plex Sans', system-ui, sans-serif";
    ctx.textBaseline = "middle";
    markers.forEach((m, i) => {
      const x = sx(m.time);
      if (x > W) return;
      const label = `${fmtShort(m.time)} ${m.title}`;
      const next = markers[i + 1] ? sx(markers[i + 1].time) - 3 : Infinity;   // never run into the next flag
      const w = Math.max(8, Math.min(ctx.measureText(label).width + 22, next - x));
      if (x + w < 0) return;
      const on = sel?.kind === "marker" && sel.i === i;
      ctx.fillStyle = on ? C.sel : C.marker;
      ctx.fillRect(x, L.markers.y + 5, w, 18);
      ctx.fillStyle = "#0A0B0A";
      ctx.fillRect(x + 5, L.markers.y + 8, 1.5, 12);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, L.markers.y, w - 4, L.markers.h);
      ctx.clip();
      ctx.fillText(label, x + 12, L.markers.y + 14);
      ctx.restore();
      ctx.fillStyle = on ? C.sel : "rgba(63,209,122,0.35)";
      ctx.fillRect(x, L.track.y, 1, L.track.h + L.spec.h + L.loud.h);
    });

    // track lane
    const ty = L.track.y;
    const th = L.track.h;
    ctx.fillStyle = C.lane;
    ctx.fillRect(0, ty, W, th);
    const HEAD = 18;
    for (const cb of clips) {
      const x0 = sx(cb.T0);
      const x1 = sx(cb.T1);
      if (x1 < 0 || x0 > W) continue;
      ctx.fillStyle = C.clip;
      ctx.fillRect(x0 + 1, ty + 2, Math.max(1, x1 - x0 - 2), th - 4);
      ctx.strokeStyle = C.clipLine;
      ctx.strokeRect(x0 + 1.5, ty + 2.5, Math.max(1, x1 - x0 - 3), th - 5);
      ctx.fillStyle = C.clipHead;
      ctx.fillRect(x0 + 2, ty + 3, Math.max(1, x1 - x0 - 4), HEAD);
      if (x1 - x0 > 50) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(Math.max(0, x0), ty, Math.min(W, x1) - Math.max(0, x0) - 4, HEAD + 4);
        ctx.clip();
        ctx.font = "11px 'IBM Plex Mono', monospace";
        ctx.fillStyle = C.text;
        ctx.textBaseline = "middle";
        ctx.fillText(cb.name, Math.max(x0, 0) + 8, ty + 3 + HEAD / 2);
        ctx.restore();
      }
    }
    // waveform over all kept pieces
    const wy = ty + HEAD + 6;
    const wh = th - HEAD - 10;
    const mid = wy + wh / 2;
    const amp = (wh / 2) * 1.25 * vzoom;
    let pi = Math.max(0, pieceIndex(pieces, xs(0)));
    for (let px = 0; px < W; px++) {
      const T = xs(px);
      while (pi < pieces.length - 1 && pieces[pi + 1].T0 <= T) pi++;
      const p = pieces[pi];
      if (!p || T < p.T0 || T > p.T1) continue;
      const pk = assets.peaks[p.sid];
      if (!pk) continue;
      const n = pk.data.length / 2;
      const t0 = p.a + (T - p.T0);
      const t1 = Math.min(p.b, t0 + 1 / view.pps);
      let i0 = Math.max(0, Math.floor(t0 * pk.rate));
      const i1 = Math.min(n, Math.max(i0 + 1, Math.ceil(t1 * pk.rate)));
      let mn = 0;
      let mx = 0;
      let sum = 0;
      const cnt = Math.max(1, i1 - i0);
      for (; i0 < i1; i0++) {
        const a = pk.data[i0 * 2] / 127;
        const b = pk.data[i0 * 2 + 1] / 127;
        if (a < mn) mn = a;
        if (b > mx) mx = b;
        sum += b - a;
      }
      const top = Math.max(wy, mid - Math.min(1, mx) * amp);
      const bot = Math.min(wy + wh, mid - Math.max(-1, mn) * amp);
      ctx.fillStyle = C.wave;
      ctx.fillRect(px, top, 1, Math.max(1, bot - top));
      const core = Math.min(wh / 2, (sum / cnt) * 0.28 * amp);
      ctx.fillStyle = C.core;
      ctx.fillRect(px, mid - core, 1, Math.max(1, 2 * core));
    }

    // spectrogram lane
    if (showSpec) {
      const sy = L.spec.y;
      const sh = L.spec.h - 1;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, sy, W, sh);
      ctx.imageSmoothingEnabled = true;
      for (const p of pieces) {
        const x0 = sx(p.T0);
        const x1 = sx(p.T1);
        if (x1 < 0 || x0 > W) continue;
        const img = assets.spec[p.sid];
        const src = tl.sources.find((s) => s.id === p.sid);
        if (!img || !img.complete || !img.naturalWidth || !src) continue;
        const ppsImg = img.naturalWidth / src.duration;
        const v0 = Math.max(view.x0, p.T0);
        const v1 = Math.min(xs(W), p.T1);
        if (v1 <= v0) continue;
        const srcX = (p.a + (v0 - p.T0)) * ppsImg;
        const srcW = Math.max(1, (v1 - v0) * ppsImg);
        ctx.drawImage(img, srcX, 0, srcW, img.naturalHeight, sx(v0), sy, sx(v1) - sx(v0), sh);
      }
      const mel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
      const m0 = mel(60);
      const m1 = mel(12000);
      ctx.font = "9px 'IBM Plex Mono', monospace";
      ctx.textBaseline = "middle";
      for (const [hz, lab] of [[100, "100"], [500, "500"], [1000, "1k"], [2000, "2k"], [4000, "4k"], [8000, "8k"]] as [number, string][]) {
        const yy = sy + sh - ((mel(hz) - m0) / (m1 - m0)) * sh;
        ctx.fillStyle = "rgba(255,255,255,0.10)";
        ctx.fillRect(0, Math.round(yy), W, 1);
        ctx.fillStyle = "rgba(0,0,0,0.7)";
        ctx.fillRect(W - 30, yy - 6, 28, 12);
        ctx.fillStyle = C.text2;
        ctx.fillText(lab, W - 27, yy);
      }
    }

    // loudness lane
    {
      const ly = L.loud.y;
      const lh = L.loud.h - 1;
      ctx.fillStyle = C.lane;
      ctx.fillRect(0, ly, W, lh);
      const lo = -40;
      const hi = -6;
      const yOf = (v: number) => ly + lh - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * lh;
      const target = tl.target_lufs ?? -16;
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(0, yOf(target) + 0.5);
      ctx.lineTo(W, yOf(target) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = C.loud;
      ctx.lineWidth = 1.5;
      for (const p of pieces) {
        const Ld = assets.loud[p.sid];
        if (!Ld || sx(p.T1) < 0 || sx(p.T0) > W) continue;
        ctx.beginPath();
        let started = false;
        const step = Math.max(1, Math.floor(1 / (Ld.hop * view.pps) / 2));
        for (let i = Math.floor(p.a / Ld.hop); i * Ld.hop <= p.b && i < Ld.values.length; i += step) {
          const x = sx(p.T0 + (i * Ld.hop - p.a));
          if (x < -5) continue;
          if (x > W + 5) break;
          const y = yOf(Ld.values[i]);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.lineWidth = 1;
      ctx.font = "10px 'IBM Plex Mono', monospace";
      ctx.fillStyle = C.text2;
      ctx.textBaseline = "top";
      ctx.fillText(`${target} LUFS`, W - 64, yOf(target) - 13);
    }

    // splices
    ctx.font = "10.5px 'IBM Plex Sans', system-ui, sans-serif";
    ctx.textBaseline = "middle";
    tl.splices.forEach((sp, i) => {
      const x = sx(sp.episode_time);
      if (x < -120 || x > W + 2) return;
      const isPause = sp.kinds.every((k) => k === "pause");
      const on = sel?.kind === "splice" && sel.i === i;
      const col = on ? C.sel : isPause ? C.pause : C.cut;
      ctx.fillStyle = col;
      ctx.fillRect(Math.round(x) - (on ? 1 : 0), ty + 21, on ? 2 : 1, th - 23);
      if (view.pps * Math.max(sp.removed, 0.3) > 2 || on) {
        const label = spliceTag(sp.kinds, sp.removed);
        const w = ctx.measureText(label).width + 10;
        const row = i % 2;
        const yTag = ty + 24 + row * 19;
        if (view.pps > 4 || on) {
          ctx.fillStyle = col;
          ctx.fillRect(x + 3, yTag, w, 16);
          ctx.fillStyle = isPause || on ? "#0A0B0A" : "#FFFFFF";
          ctx.fillText(label, x + 8, yTag + 8);
        } else {
          ctx.fillRect(x - 3, ty + 21, 7, 4);
        }
      }
    });

    // blade split points
    ctx.strokeStyle = "rgba(244,246,244,0.8)";
    ctx.setLineDash([4, 3]);
    for (const T of splits) {
      const x = Math.round(sx(T)) + 0.5;
      if (x < 0 || x > W) continue;
      ctx.beginPath();
      ctx.moveTo(x, ty + 2);
      ctx.lineTo(x, ty + th - 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // range selection
    if (sel?.kind === "range") {
      const x0 = sx(Math.min(sel.A, sel.B));
      const x1 = sx(Math.max(sel.A, sel.B));
      ctx.fillStyle = "rgba(244,246,244,0.13)";
      ctx.fillRect(x0, ty, x1 - x0, L.total - ty);
      ctx.fillStyle = C.sel;
      ctx.fillRect(x0, ty, 1, L.total - ty);
      ctx.fillRect(x1 - 1, ty, 1, L.total - ty);
    }

    // lane separators
    ctx.fillStyle = C.border;
    for (const y of [L.markers.y, L.track.y, L.spec.y, L.loud.y, L.total - 1]) ctx.fillRect(0, y - 1, W, 1);
  }, [tl, pieces, clips, assets, assets.version, view, vzoom, width, L, sel, splits, showSpec, markers, sx, xs, lang]);

  // ---- hit testing ------------------------------------------------------------------------------
  const laneAt = (y: number) => (y < L.markers.y ? "ruler" : y < L.track.y ? "markers" : y < L.spec.y ? "track" : y < L.loud.y ? "spec" : "loud");

  const spliceAt = (x: number, y: number): number => {
    let best = -1;
    let bd = 7;
    const ctx = cv.current?.getContext("2d");
    tl.splices.forEach((sp, i) => {
      const sxp = sx(sp.episode_time);
      let d = Math.abs(x - sxp);
      if (ctx && view.pps > 4) {
        const yTag = L.track.y + 24 + (i % 2) * 19;
        ctx.font = "10.5px 'IBM Plex Sans', system-ui, sans-serif";
        const w = ctx.measureText(spliceTag(sp.kinds, sp.removed)).width + 10;
        if (x >= sxp + 3 && x <= sxp + 3 + w && y >= yTag && y <= yTag + 16) d = 0;
      }
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };

  const markerAt = (x: number): number => {
    const ctx = cv.current?.getContext("2d");
    if (!ctx) return -1;
    ctx.font = "600 11px 'IBM Plex Sans', system-ui, sans-serif";
    for (let i = markers.length - 1; i >= 0; i--) {
      const m = markers[i];
      const x0 = sx(m.time);
      const next = markers[i + 1] ? sx(markers[i + 1].time) - 3 : Infinity;
      const w = Math.max(8, Math.min(ctx.measureText(`${fmtShort(m.time)} ${m.title}`).width + 22, next - x0));
      if (x >= x0 - 3 && x <= x0 + w) return i;
    }
    return -1;
  };

  const local = (e: React.PointerEvent) => {
    const r = cv.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const clampT = (T: number) => Math.max(0, Math.min(tl.length ?? T, T));

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const { x, y } = local(e);
    const lane = laneAt(y);
    cv.current?.setPointerCapture(e.pointerId);
    const T = clampT(xs(x));
    if (lane === "ruler") {
      onSeek(T);
      setDrag({ kind: "scrub" });
      return;
    }
    if (lane === "markers") {
      const i = markerAt(x);
      if (i >= 0) {
        onSelect({ kind: "marker", i });
        setDrag({ kind: "marker", i, x0: x, T: markers[i].time, moved: false });
      } else {
        onSeek(T);
      }
      return;
    }
    if (tool === "blade" && lane === "track") {
      onSplit(T);
      return;
    }
    if (tool === "select" && lane === "track") {
      const si = spliceAt(x, y);
      if (si >= 0) {
        onSelect({ kind: "splice", i: si });
        return;
      }
      // a click between two blade splits selects that segment
      if (splits.length) {
        const sorted = [...splits].sort((a, b) => a - b);
        const k = sorted.findIndex((s) => s > T);
        const A = k <= 0 ? null : sorted[k - 1];
        const B = k < 0 ? null : sorted[k];
        if (A !== null && B !== null) {
          setDrag({ kind: "range", A: T, x0: x, moved: false, lane });
          onSelect({ kind: "range", A, B });
          return;
        }
      }
    }
    setDrag({ kind: "range", A: T, x0: x, moved: false, lane });
  };

  const onMove = (e: React.PointerEvent) => {
    const { x, y } = local(e);
    if (!drag) {
      const lane = laneAt(y);
      if (lane === "markers") setCursor(markerAt(x) >= 0 ? "grab" : "copy");
      else if (lane === "ruler") setCursor("col-resize");
      else if (tool === "blade" && lane === "track") setCursor("crosshair");
      else if (tool === "select" && lane === "track" && spliceAt(x, y) >= 0) setCursor("pointer");
      else setCursor(tool === "range" ? "text" : "default");
      return;
    }
    const T = clampT(xs(x));
    if (drag.kind === "scrub") onSeek(T);
    else if (drag.kind === "marker") {
      if (!drag.moved && Math.abs(x - drag.x0) < 3) return;
      setDrag({ ...drag, moved: true });
      setLiveMarker({ i: drag.i, T: drag.i === 0 ? 0 : T });
    } else if (drag.kind === "range") {
      if (!drag.moved && Math.abs(x - drag.x0) < 3) return;
      setDrag({ ...drag, moved: true });
      onSelect({ kind: "range", A: drag.A, B: T });
    }
  };

  const onUp = (e: React.PointerEvent) => {
    cv.current?.releasePointerCapture(e.pointerId);
    if (drag?.kind === "range" && !drag.moved) {
      onSeek(drag.A);
      if (!(tool === "select" && splits.length)) onSelect(null);
    }
    if (drag?.kind === "marker" && drag.moved && liveMarker) onMarkerMove(liveMarker.i, liveMarker.T);
    setDrag(null);
    setLiveMarker(null);
  };

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    const wheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const r = c.getBoundingClientRect();
      const x = ev.clientX - r.left;
      if (ev.ctrlKey || ev.metaKey) {
        const at = view.x0 + x / view.pps;
        const pps = view.pps * Math.pow(1.0018, -ev.deltaY);
        onView({ x0: at - x / pps, pps });
      } else {
        const d = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
        onView({ ...view, x0: view.x0 + d / view.pps });
      }
    };
    c.addEventListener("wheel", wheel, { passive: false });
    return () => c.removeEventListener("wheel", wheel);
  }, [view, onView]);

  const ph = sx(playhead);
  return (
    <div style={{ position: "relative", height: L.total }}>
      <canvas ref={cv} role="img" aria-label={t("Episode timeline")} style={{ display: "block", width, height: L.total, cursor, touchAction: "none" }}
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
        onDoubleClick={(e) => {
          // pointer events carry no click count, so double-click is handled here: new marker on the markers lane
          const r = cv.current!.getBoundingClientRect();
          const x = e.clientX - r.left;
          const y = e.clientY - r.top;
          if (laneAt(y) === "markers" && markerAt(x) < 0) onMarkerAdd(clampT(xs(x)));
        }} />
      {ph >= 0 && ph <= width && (
        <>
          <div aria-hidden="true" style={{ position: "absolute", top: 0, bottom: 0, left: Math.round(ph), width: 1, background: "#F4F6F4", pointerEvents: "none" }} />
          <div aria-hidden="true" style={{ position: "absolute", top: 0, left: Math.round(ph) - 6, width: 0, height: 0, borderLeft: "6px solid transparent", borderRight: "6px solid transparent", borderTop: "8px solid #F4F6F4", pointerEvents: "none" }} />
        </>
      )}
    </div>
  );
}

function fmtShort(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t - m * 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Waveform of a short stretch of the finished episode (inspector close-up of a splice). */
export function drawCloseUp(c: HTMLCanvasElement, pieces: Piece[], assets: Assets, T0: number, T1: number) {
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth;
  const H = c.clientHeight;
  c.width = Math.round(W * dpr);
  c.height = Math.round(H * dpr);
  const ctx = c.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.lane;
  ctx.fillRect(0, 0, W, H);
  const pps = W / (T1 - T0);
  const mid = H / 2;
  let pi = Math.max(0, pieceIndex(pieces, T0));
  for (let px = 0; px < W; px++) {
    const T = T0 + px / pps;
    while (pi < pieces.length - 1 && pieces[pi + 1].T0 <= T) pi++;
    const p = pieces[pi];
    if (!p || T < p.T0 || T > p.T1) continue;
    const pk = assets.peaks[p.sid];
    if (!pk) continue;
    const t = p.a + (T - p.T0);
    let i0 = Math.max(0, Math.floor(t * pk.rate));
    const i1 = Math.min(pk.data.length / 2, Math.max(i0 + 1, Math.ceil((t + 1 / pps) * pk.rate)));
    let mn = 0;
    let mx = 0;
    for (; i0 < i1; i0++) {
      mn = Math.min(mn, pk.data[i0 * 2] / 127);
      mx = Math.max(mx, pk.data[i0 * 2 + 1] / 127);
    }
    ctx.fillStyle = C.wave;
    const top = mid - Math.min(1, mx * 1.6) * (H / 2 - 2);
    const bot = mid - Math.max(-1, mn * 1.6) * (H / 2 - 2);
    ctx.fillRect(px, top, 1, Math.max(1, bot - top));
  }
}
