"use client";

// Whole-episode strip above the lanes: mini waveform, cuts and questions, and the visible window.
// Click or drag to move the window.

import { useEffect, useRef } from "react";
import type { Timeline } from "@/lib/timeline";
import type { Assets, View } from "./Lanes";

export const OVERVIEW_H = 40;

export function Overview({ tl, assets, view, width, onView }: { tl: Timeline; assets: Assets; view: View; width: number; onView: (v: View) => void }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const total = Math.max(1, tl.original_length);
  const scale = width / total;

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
    // mini waveform: max |peak| per pixel
    for (const s of tl.sources) {
      const pk = assets.peaks[s.id];
      const x0 = Math.floor(s.offset * scale);
      const x1 = Math.ceil((s.offset + s.duration) * scale);
      if (!pk) {
        ctx.fillStyle = "#141614";
        ctx.fillRect(x0, mid - 2, x1 - x0, 4);
        continue;
      }
      const n = pk.data.length / 2;
      for (let px = x0; px < x1; px++) {
        const i0 = Math.floor(((px / scale - s.offset) * pk.rate));
        const i1 = Math.min(n, Math.floor((((px + 1) / scale - s.offset) * pk.rate)));
        let m = 0;
        for (let i = Math.max(0, i0); i < i1; i++) m = Math.max(m, -pk.data[i * 2], pk.data[i * 2 + 1]);
        const h = Math.min(mid - 2, (m / 127) * (mid - 2) * 1.5);
        ctx.fillStyle = "#1b5e38";
        ctx.fillRect(px, mid - h, 1, Math.max(1, 2 * h));
      }
    }
    // cuts and questions
    for (const e of tl.edits) {
      if (e.type !== "cut" || e.status === "rejected") continue;
      const s = tl.sources.find((x) => x.id === e.source);
      if (!s) continue;
      ctx.fillStyle = e.status === "suggested" ? "#ffb020" : "#ff4d4d";
      const x = (s.offset + e.start) * scale;
      ctx.fillRect(x, e.status === "suggested" ? 0 : OVERVIEW_H - 6, Math.max(2, (e.end - e.start) * scale), 6);
    }
    // visible window
    const vx = view.x0 * scale;
    const vw = Math.max(4, (width / view.pps) * scale);
    ctx.fillStyle = "rgba(244,246,244,0.08)";
    ctx.fillRect(vx, 0, vw, OVERVIEW_H);
    ctx.strokeStyle = "#f4f6f4";
    ctx.strokeRect(vx + 0.5, 0.5, vw - 1, OVERVIEW_H - 1);
  }, [tl, assets, assets.version, view, width, scale]);

  const move = (clientX: number) => {
    const r = cv.current!.getBoundingClientRect();
    const t = (clientX - r.left) / scale;
    const span = width / view.pps;
    onView({ ...view, x0: Math.min(Math.max(0, t - span / 2), Math.max(0, total - span)) });
  };

  return (
    <canvas
      ref={cv}
      role="img"
      aria-label="Увесь епізод"
      style={{ display: "block", width, height: OVERVIEW_H, cursor: "pointer", borderBottom: "1px solid #262926", touchAction: "none" }}
      onPointerDown={(e) => {
        cv.current?.setPointerCapture(e.pointerId);
        move(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) move(e.clientX);
      }}
    />
  );
}
