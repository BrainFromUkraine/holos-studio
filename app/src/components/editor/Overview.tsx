"use client";

// Whole finished episode under the timeline: mini waveform, cuts, chapters and the visible window.
// Click or drag to move the window.

import { useEffect, useMemo, useRef } from "react";
import type { Piece } from "@/lib/resultmap";
import type { Timeline } from "@/lib/timeline";
import type { Assets, View } from "./Timeline";

export const OVERVIEW_H = 44;

export function Overview({ tl, pieces, assets, view, width, onView }: { tl: Timeline; pieces: Piece[]; assets: Assets; view: View; width: number; onView: (v: View) => void }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const total = Math.max(1, tl.length ?? 1);
  const scale = width / total;

  // max |peak| per pixel of the finished episode — recomputed only when audio, edits or width change
  const env = useMemo(() => {
    const out = new Float32Array(Math.max(1, Math.floor(width)));
    for (const p of pieces) {
      const pk = assets.peaks[p.sid];
      if (!pk) continue;
      const n = pk.data.length / 2;
      const x0 = Math.floor(p.T0 * scale);
      const x1 = Math.min(out.length, Math.ceil(p.T1 * scale));
      for (let px = Math.max(0, x0); px < x1; px++) {
        const ta = p.a + (px / scale - p.T0);
        const tb = p.a + ((px + 1) / scale - p.T0);
        let m = 0;
        for (let i = Math.max(0, Math.floor(ta * pk.rate)); i < Math.min(n, Math.ceil(tb * pk.rate)); i++) {
          m = Math.max(m, -pk.data[i * 2], pk.data[i * 2 + 1]);
        }
        out[px] = Math.max(out[px], m / 127);
      }
    }
    return out;
  }, [pieces, assets.version, assets.peaks, scale, width]);

  useEffect(() => {
    const c = cv.current;
    if (!c || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = OVERVIEW_H * dpr;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#080908";
    ctx.fillRect(0, 0, width, OVERVIEW_H);
    const mid = OVERVIEW_H / 2;
    ctx.fillStyle = "#1B5E38";
    for (let px = 0; px < env.length; px++) {
      const h = Math.min(mid - 3, env[px] * (mid - 3) * 1.5);
      ctx.fillRect(px, mid - h, 1, Math.max(1, 2 * h));
    }
    for (const sp of tl.splices) {
      const isPause = sp.kinds.every((k) => k === "pause");
      if (isPause) continue;
      ctx.fillStyle = "#FF4D4D";
      ctx.fillRect(sp.episode_time * scale, OVERVIEW_H - 7, 2, 7);
    }
    for (const ch of tl.chapters) {
      ctx.fillStyle = "#3FD17A";
      ctx.fillRect(ch.time * scale, 0, 2, 7);
    }
    const vx = view.x0 * scale;
    const vw = Math.max(4, (width / view.pps) * scale);
    ctx.fillStyle = "rgba(244,246,244,0.08)";
    ctx.fillRect(vx, 0, vw, OVERVIEW_H);
    ctx.strokeStyle = "#F4F6F4";
    ctx.strokeRect(vx + 0.5, 0.5, vw - 1, OVERVIEW_H - 1);
  }, [env, tl.splices, tl.chapters, view, width, scale]);

  const move = (clientX: number) => {
    const r = cv.current!.getBoundingClientRect();
    const t = (clientX - r.left) / scale;
    const span = width / view.pps;
    onView({ ...view, x0: t - span / 2 });
  };

  return (
    <canvas ref={cv} role="img" aria-label="Увесь епізод" style={{ display: "block", width, height: OVERVIEW_H, cursor: "pointer", touchAction: "none" }}
      onPointerDown={(e) => { cv.current?.setPointerCapture(e.pointerId); move(e.clientX); }}
      onPointerMove={(e) => { if (e.buttons & 1) move(e.clientX); }} />
  );
}
