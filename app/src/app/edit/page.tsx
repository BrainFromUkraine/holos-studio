"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EngineBanner, useEngine } from "@/components/Shell";
import { Overview, OVERVIEW_H } from "@/components/editor/Overview";
import { Player, type Pos } from "@/components/editor/player";
import { drawCloseUp, spliceLabel, TimelineCanvas, type Assets, type ESel, type Tool, type View } from "@/components/editor/Timeline";
import { currentProject, engine, type EditRequest } from "@/lib/engine";
import { buildPieces, clipBoxes, fmtEp, rangeToSources, toSource } from "@/lib/resultmap";
import { t, tn, useLang } from "@/lib/i18n";
import { episodeTime, reasonText, type Timeline } from "@/lib/timeline";

const HEAD_W = 190;
const MAX_PPS = 1500;

function useAssets(path: string | null, tl: Timeline | null): Assets {
  const [a, setA] = useState<Assets>({ peaks: {}, spec: {}, loud: {}, version: 0 });
  const key = tl ? tl.sources.map((s) => s.id).join(",") : "";
  useEffect(() => {
    if (!path || !tl) return;
    let alive = true;
    const bump = (f: (p: Assets) => Assets) => alive && setA((p) => ({ ...f(p), version: p.version + 1 }));
    const one = async (sid: string) => {
      try {
        const pk = await engine.peaks(path, sid);
        bump((p) => ({ ...p, peaks: { ...p.peaks, [sid]: pk } }));
        await new Promise<void>((res) => {
          const img = new Image();
          img.onload = () => { bump((p) => ({ ...p, spec: { ...p.spec, [sid]: img } })); res(); };
          img.onerror = () => res();
          img.src = engine.assetUrl("spectrogram", path, sid);
        });
        const L = await engine.loudness(path, sid);
        bump((p) => ({ ...p, loud: { ...p.loud, [sid]: L } }));
      } catch {}
    };
    const queue = tl.sources.map((s) => s.id);
    Promise.all(Array.from({ length: 3 }, async () => { while (alive && queue.length) await one(queue.shift()!); }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key]);
  return a;
}

// labels are English keys, shown with t()
const TOOLS: { id: Tool; label: string; key: string; icon: ReactNode }[] = [
  { id: "select", label: "Select", key: "A", icon: <path d="M5 3l14 8-6 2-3 6z" /> },
  { id: "blade", label: "Blade", key: "B", icon: <><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12" /></> },
  { id: "range", label: "Range", key: "R", icon: <path d="M4 4v16M20 4v16M4 12h16" /> },
];

export default function EditorPage() {
  useLang();
  const { health } = useEngine();
  const [path, setPath] = useState<string | null>(null);
  const [tl, setTl] = useState<Timeline | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState<Tool>("select");
  const [snap, setSnap] = useState(true);
  const [showSpec, setShowSpec] = useState(true);
  const [loop, setLoop] = useState(false);
  const [sel, setSel] = useState<ESel>(null);
  const [splits, setSplits] = useState<number[]>([]);
  const [view, setView] = useState<View>({ x0: 0, pps: 1 });
  const [T, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [markerTitle, setMarkerTitle] = useState("");
  const area = useRef<HTMLDivElement>(null);
  const player = useRef<Player | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const stamp = useRef<number | null>(null);
  const fitted = useRef(false);
  const assets = useAssets(path, tl);
  const pieces = useMemo(() => (tl ? buildPieces(tl) : []), [tl]);
  const clips = useMemo(() => (tl ? clipBoxes(tl, pieces) : []), [tl, pieces]);
  const length = tl?.length ?? 0;
  const width = Math.max(200, size.w - HEAD_W);

  // ---- load & external changes (Claude via MCP edits the same project) --------------------------
  const refreshStamp = useCallback(async (p: string) => {
    try { stamp.current = (await engine.stamp(p)).mtime; } catch {}
  }, []);

  useEffect(() => {
    const p = currentProject.get();
    setPath(p);
    if (!p || !health) return;
    engine.timeline(p).then((t) => {
      setTl(t);
      currentProject.set(p, t.name);
      refreshStamp(p);
    }).catch((e) => setErr(String(e.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(health)]);

  useEffect(() => {
    if (!path) return;
    const id = setInterval(async () => {
      try {
        const m = (await engine.stamp(path)).mtime;
        if (m && stamp.current && m > stamp.current + 0.001) {
          stamp.current = m;
          setTl(await engine.timeline(path));
        }
      } catch {}
    }, 3000);
    return () => clearInterval(id);
  }, [path]);

  useEffect(() => {
    if (!path) return;
    const pl = new Player(path);
    pl.onState = setPlaying;
    player.current = pl;
    return () => pl.destroy();
  }, [path]);

  useEffect(() => { if (tl) player.current?.setTimeline(tl); }, [tl]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [tl]);

  const minPps = width / Math.max(1, length);
  const clampView = useCallback((v: View): View => {
    const pps = Math.max(minPps, Math.min(MAX_PPS, v.pps));
    const span = width / pps;
    return { pps, x0: Math.max(-0.5, Math.min(v.x0, Math.max(0, length - span + 0.5))) };
  }, [minPps, width, length]);
  const changeView = useCallback((v: View) => setView(clampView(v)), [clampView]);

  useEffect(() => {
    if (tl && size.w > 0 && !fitted.current) {
      fitted.current = true;
      setView({ x0: 0, pps: width / Math.max(1, length) });
    }
  }, [tl, size.w, width, length]);

  // ---- playback ---------------------------------------------------------------------------------
  const posOf = useCallback((Tt: number): Pos | null => toSource(pieces, Tt), [pieces]);
  useEffect(() => {
    const pl = player.current;
    if (!pl || !tl) return;
    pl.onTick = (p) => {
      const e = episodeTime(tl, p.sid, p.t);
      if (e === null) return;
      setT(e);
      if (loop && sel?.kind === "range" && e >= Math.max(sel.A, sel.B)) {
        const from = posOf(Math.min(sel.A, sel.B));
        if (from) pl.play(from);
      }
    };
  }, [tl, loop, sel, posOf]);

  useEffect(() => {
    if (!playing) return;
    const span = width / view.pps;
    if (T > view.x0 + span * 0.92 || T < view.x0) changeView({ ...view, x0: T - span * 0.1 });
  }, [T, playing, view, width, changeView]);

  const play = (from: number, until?: number) => {
    const pl = player.current;
    const a = posOf(from);
    if (!pl || !a) return;
    pl.pause();
    pl.play(a, until !== undefined ? posOf(until) : null);
  };
  const togglePlay = () => {
    if (playing) return player.current?.pause();
    if (loop && sel?.kind === "range") return play(Math.min(sel.A, sel.B));
    play(T);
  };
  const seek = (Tt: number) => {
    setT(Tt);
    if (playing) play(Tt);
  };

  // ---- edits ------------------------------------------------------------------------------------
  const run = (req: Omit<EditRequest, "path">, after?: (t: Timeline & { ids?: string[] }) => void) => {
    if (!path) return;
    setBusy(true);
    setErr(null);
    queue.current = queue.current.then(async () => {
      try {
        const t = await engine.edit({ path, ...req });
        setTl(t);
        after?.(t);
        await refreshStamp(path);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    });
  };

  const cutRange = (A: number, B: number) => {
    const ranges = rangeToSources(pieces, A, B);
    if (!ranges.length) return;
    run({ op: "cuts", ranges, snap }, () => {
      setSel(null);
      setSplits((s) => s.filter((x) => x < Math.min(A, B) - 0.01 || x > Math.max(A, B) + 0.01));
      setT(Math.min(A, B));
    });
  };

  const splice = sel?.kind === "splice" ? tl?.splices[sel.i] ?? null : null;
  const spliceEdits = useMemo(() => (splice && tl ? tl.edits.filter((e) => splice.edits.includes(e.id)) : []), [splice, tl]);
  const cutEdits = spliceEdits.filter((e) => e.type === "cut");
  const leftEdit = cutEdits.length ? cutEdits.reduce((a, b) => (b.start < a.start ? b : a)) : null;
  const rightEdit = cutEdits.length ? cutEdits.reduce((a, b) => (b.end > a.end ? b : a)) : null;

  const restore = () => {
    if (!splice) return;
    const at = splice.episode_time;
    run({ op: "status", ids: splice.edits, status: "rejected" }, () => { setSel(null); setT(at); });
  };

  const saveMarkers = (list: { time: number; title: string }[]) => {
    if (!path) return;
    setBusy(true);
    engine.setChapters(path, list).then(async () => {
      setTl(await engine.timeline(path));
      await refreshStamp(path);
    }).catch((e) => setErr(String(e.message ?? e))).finally(() => setBusy(false));
  };
  const addMarker = (at: number) => {
    if (!tl) return;
    const list = [...tl.chapters.map((c) => ({ time: c.time, title: c.title })), { time: at, title: tl.chapters.length ? t("New chapter") : t("Intro") }];
    saveMarkers(list);
  };

  useEffect(() => {
    if (sel?.kind === "marker" && tl) setMarkerTitle(tl.chapters[sel.i]?.title ?? "");
  }, [sel, tl]);

  const jumpSplice = (dir: 1 | -1) => {
    if (!tl?.splices.length) return;
    const list = tl.splices.map((s, i) => ({ i, t: s.episode_time })).sort((a, b) => a.t - b.t);
    const cur = sel?.kind === "splice" ? tl.splices[sel.i].episode_time : T;
    const nxt = dir > 0 ? list.find((s) => s.t > cur + 0.01) : [...list].reverse().find((s) => s.t < cur - 0.01);
    if (!nxt) return;
    setSel({ kind: "splice", i: nxt.i });
    setT(Math.max(0, nxt.t - 1.5));
    const span = width / view.pps;
    if (nxt.t < view.x0 || nxt.t > view.x0 + span) changeView({ ...view, x0: nxt.t - span / 2 });
  };

  // ---- keyboard ---------------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      const tag = el?.tagName;
      const typing = tag === "TEXTAREA" || tag === "SELECT" || (tag === "INPUT" && !["range", "checkbox", "radio", "button"].includes((el as HTMLInputElement).type));
      if (typing) return;
      if (tag === "INPUT" && (e.code === "ArrowLeft" || e.code === "ArrowRight") && (el as HTMLInputElement).type === "range") return;
      const mod = e.ctrlKey || e.metaKey;
      const code = e.code;
      if (mod && code === "KeyZ") { e.preventDefault(); run({ op: e.shiftKey ? "redo" : "undo" }); }
      else if (mod && code === "KeyY") { e.preventDefault(); run({ op: "redo" }); }
      else if (code === "Space") { e.preventDefault(); togglePlay(); }
      else if (!mod && (code === "KeyA" || code === "KeyV")) setTool("select");
      else if (!mod && code === "KeyB") setTool("blade");
      else if (!mod && code === "KeyR") setTool("range");
      else if (!mod && code === "KeyM") addMarker(T);
      else if (!mod && code === "KeyL") setLoop((l) => !l);
      else if ((code === "Delete" || code === "Backspace" || code === "KeyC") && sel?.kind === "range") { e.preventDefault(); cutRange(sel.A, sel.B); }
      else if (code === "ArrowRight") { e.preventDefault(); jumpSplice(1); }
      else if (code === "ArrowLeft") { e.preventDefault(); jumpSplice(-1); }
      else if (code === "Home") seek(0);
      else if (code === "End") seek(length);
      else if (code === "Equal" || code === "NumpadAdd") changeView({ x0: view.x0 + (width / view.pps) * 0.25, pps: view.pps * 2 });
      else if (code === "Minus" || code === "NumpadSubtract") changeView({ x0: view.x0 - width / view.pps / 2, pps: view.pps / 2 });
      else if (code === "Escape") { setSel(null); setSplits([]); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // close-up of the selected splice
  const close = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (splice && close.current) drawCloseUp(close.current, pieces, assets, splice.episode_time - 1.2, splice.episode_time + 1.2);
  }, [splice, pieces, assets, assets.version]);

  if (!path) {
    return <div className="main" style={{ padding: 20 }}><div className="banner">{t("No project is open.")} <Link href="/">{t("Choose or create a project")}</Link>.</div></div>;
  }

  const counts: Record<string, number> = {};
  for (const e of tl?.edits ?? []) if (e.status === "accepted") counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  const zoomLog = (pps: number) => Math.round((Math.log(pps / minPps) / Math.log(MAX_PPS / minPps)) * 100);
  const fromZoomLog = (v: number) => minPps * Math.pow(MAX_PPS / minPps, v / 100);
  const recorded = tl?.sources.reduce((a, s) => a + s.duration, 0) ?? 0;
  const m = tl?.measured;
  const auto = tl?.automation;

  return (
    <div className="full">
      {/* ---- toolbar ---- */}
      <div role="toolbar" aria-label={t("Tools")} style={{ flex: "0 0 48px", display: "flex", alignItems: "center", gap: 10, padding: "0 12px", background: "var(--panel)", borderBottom: "1px solid var(--border)" }}>
        <div role="group" aria-label={t("Tool")} style={{ display: "flex", border: "1px solid var(--border)" }}>
          {TOOLS.map((tb) => (
            <button key={tb.id} className="tool" aria-pressed={tool === tb.id} title={`${t(tb.label)} (${tb.key})`} onClick={() => setTool(tb.id)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">{tb.icon}</svg>
              {t(tb.label)} <span className="kbd">{tb.key}</span>
            </button>
          ))}
        </div>
        <button className="tool" style={{ border: "1px solid var(--border)", color: snap ? "var(--core)" : undefined, background: snap ? "var(--sel-row)" : undefined }} aria-pressed={snap}
          title={t("Moves cut edges to the quietest point nearby")} onClick={() => setSnap((s) => !s)}>{t("Snap to silence")}</button>
        <div role="group" aria-label={t("History")} style={{ display: "flex", gap: 4 }}>
          <button className="iconbtn" aria-label={`${t("Undo")} (Ctrl+Z)`} title={`${tl?.history.undo_label ? t("Undo: {action}", { action: t(tl.history.undo_label) }) : t("Undo")} (Ctrl+Z)`} disabled={!tl?.history.can_undo || busy} onClick={() => run({ op: "undo" })}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 010 12h-3" /></svg>
          </button>
          <button className="iconbtn" aria-label={`${t("Redo")} (Ctrl+Shift+Z)`} title={`${tl?.history.redo_label ? t("Redo: {action}", { action: t(tl.history.redo_label) }) : t("Redo")} (Ctrl+Shift+Z)`} disabled={!tl?.history.can_redo || busy} onClick={() => run({ op: "redo" })}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 14l5-5-5-5" /><path d="M20 9H10a6 6 0 000 12h3" /></svg>
          </button>
        </div>

        <div role="group" aria-label={t("Transport")} style={{ marginLeft: "auto", display: "flex", gap: 3 }}>
          <button className="iconbtn" aria-label={t("Go to start (Home)")} onClick={() => seek(0)}><svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="2" y="2" width="1.6" height="10" /><path d="M12 2v10L4.5 7z" /></svg></button>
          <button className="iconbtn" aria-label={t("Back 5 s")} onClick={() => seek(Math.max(0, T - 5))}><svg width="14" height="12" viewBox="0 0 16 14" fill="currentColor" aria-hidden="true"><path d="M8 2v10L2 7zM15 2v10L9 7z" /></svg></button>
          <button className="btn primary" style={{ width: 46, height: 32, padding: 0 }} aria-label={playing ? t("Pause (Space)") : t("Play (Space)")} onClick={togglePlay}>
            {playing ? <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="3" y="2" width="3" height="10" /><rect x="8" y="2" width="3" height="10" /></svg>
              : <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M3 2l9 5-9 5z" /></svg>}
          </button>
          <button className="iconbtn" aria-label={t("Forward 5 s")} onClick={() => seek(Math.min(length, T + 5))}><svg width="14" height="12" viewBox="0 0 16 14" fill="currentColor" aria-hidden="true"><path d="M1 2v10l6-5zM8 2v10l6-5z" /></svg></button>
          <button className="iconbtn" aria-pressed={loop} aria-label={t("Loop selection (L)")} title={t("Loop selection (L)")} onClick={() => setLoop((l) => !l)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M17 2l3 3-3 3" /><path d="M4 11V9a4 4 0 014-4h12" /><path d="M7 22l-3-3 3-3" /><path d="M20 13v2a4 4 0 01-4 4H4" /></svg>
          </button>
        </div>
        <div style={{ padding: "2px 12px", background: "var(--lane)", border: "1px solid var(--border)", display: "flex", flexDirection: "column", minWidth: 160 }}>
          <span className="mono" style={{ fontSize: 19, color: "var(--bright)" }}>{fmtEp(T, true)}</span>
          <span className="mono muted" style={{ fontSize: 10.5 }}>{t("of {total}", { total: fmtEp(length) })}</span>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <span className="muted" style={{ fontSize: 12 }}>{t("Zoom")}</span>
          <input type="range" aria-label={t("Zoom")} min={0} max={100} value={Number.isFinite(zoomLog(view.pps)) ? zoomLog(view.pps) : 0}
            onChange={(e) => { const pps = fromZoomLog(Number(e.target.value)); const c = view.x0 + width / view.pps / 2; changeView({ pps, x0: c - width / pps / 2 }); }} style={{ width: 120 }} />
          <Link href="/automation/" className="btn" style={{ height: 32, display: "flex", alignItems: "center", gap: 6, textDecoration: "none" }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></svg>
            {t("Automation")}
          </Link>
        </div>
      </div>

      {/* ---- what was done automatically ---- */}
      <div style={{ flex: "0 0 32px", display: "flex", alignItems: "center", gap: 18, padding: "0 14px", background: "#0d0f0d", borderBottom: "1px solid var(--border)", fontSize: 12, color: "var(--text2)", whiteSpace: "nowrap", overflow: "hidden" }}>
        <span className="muted">{t("Done automatically:")}</span>
        {([["repeat", "repeats", "var(--cut)"], ["retake", "retakes", "var(--cut)"], ["filler", "uh/um", "var(--cut)"], ["pause", "pauses", "#6a706a"], ["gain", "breaths", "var(--breath)"], ["fill", "drop-outs", "var(--dim)"]] as [string, string, string][]).map(([k, l, c]) => (
          <span key={k}><i style={{ display: "inline-block", width: 8, height: 8, background: c, marginRight: 6 }} />{t(l)} {counts[k === "gain" ? "breath" : k] ?? 0}</span>
        ))}
        <span><i style={{ display: "inline-block", width: 8, height: 8, background: auto?.clicks === "off" ? "var(--dim)" : "var(--loud)", marginRight: 6 }} />{auto?.clicks === "off" ? t("mouth clicks off") : t("mouth clicks removed")}</span>
        {counts.manual ? <span><i style={{ display: "inline-block", width: 8, height: 8, background: "var(--cut)", marginRight: 6 }} />{t("manual cuts")} {counts.manual}</span> : null}
        <span className="mono muted" style={{ marginLeft: "auto" }}>{t("{length} · recorded {recorded}", { length: fmtEp(length), recorded: fmtEp(recorded) })}</span>
      </div>

      <div style={{ flex: "1 1 auto", display: "flex", minHeight: 0 }}>
        <div style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div ref={area} style={{ flex: "1 1 auto", display: "flex", minHeight: 0, overflow: "hidden", position: "relative" }}>
            {!tl ? (
              <div style={{ padding: 20 }}><EngineBanner />{err ? <div className="banner error">{err}</div> : <span className="muted">{t("Loading episode…")}</span>}</div>
            ) : (
              <>
                <TrackHeaders height={size.h} showSpec={showSpec} onToggleSpec={() => setShowSpec((s) => !s)} clipsCount={tl.sources.length} chain={tl.chain.filter((c) => c.enabled).length} />
                <TimelineCanvas tl={tl} pieces={pieces} clips={clips} assets={assets} view={view} width={width} height={size.h} tool={tool} sel={sel} splits={splits}
                  playhead={T} showSpec={showSpec} onView={changeView} onSelect={setSel} onSeek={seek}
                  onSplit={(t) => setSplits((s) => [...s, t].sort((a, b) => a - b))}
                  onMarkerMove={(i, t) => saveMarkers(tl.chapters.map((c, k) => ({ time: k === i ? t : c.time, title: c.title })))}
                  onMarkerAdd={addMarker} />
              </>
            )}
            {err && tl && <div className="banner error" role="alert" style={{ position: "absolute", left: HEAD_W + 12, right: 12, bottom: 12 }}>{err}</div>}
          </div>
          <div style={{ flex: `0 0 ${OVERVIEW_H + 1}px`, display: "flex", borderTop: "1px solid var(--border)", background: "var(--panel)" }}>
            <div style={{ flex: `0 0 ${HEAD_W}px`, padding: "7px 10px", borderRight: "1px solid var(--border)", fontSize: 12 }}>
              <div style={{ color: "var(--bright)" }}>{t("Whole episode")}</div>
              <div className="mono muted" style={{ fontSize: 10.5 }}>{t("{length} · recorded {recorded}", { length: fmtEp(length), recorded: fmtEp(recorded) })}</div>
            </div>
            {tl && <Overview tl={tl} pieces={pieces} assets={assets} view={view} width={width} onView={changeView} />}
          </div>
        </div>

        {/* ---- inspector ---- */}
        <aside aria-label={t("Inspector")} className="panel" style={{ flex: "0 0 300px", borderLeft: "1px solid var(--border)", padding: 14, display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" }}>
          {splice && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <i style={{ width: 10, height: 10, background: splice.kinds.every((k) => k === "pause") ? "#8b8f8b" : "var(--cut)" }} />
                <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t("Splice · {kinds}", { kinds: spliceLabel(splice.kinds) })}</h2>
                <span className="chip" style={{ marginLeft: "auto" }}>{splice.kinds.includes("manual") ? t("Manual") : t("Auto")}</span>
              </div>
              <div style={{ color: "var(--text2)", lineHeight: 1.5 }}>
                {(() => {
                  const [pre, post = ""] = t("Removed {amount} at {time}.", { time: fmtEp(splice.episode_time) }).split("{amount}");
                  return <>{pre}<span className="mono" style={{ color: "var(--bright)" }}>{t("{n} s", { n: splice.removed.toFixed(2) })}</span>{post}</>;
                })()}
                {spliceEdits.map((e) => reasonText(e.reason)).filter(Boolean).slice(0, 2).map((r) => <span key={r}> {r}</span>)}
              </div>
              <div style={{ position: "relative", height: 96, border: "1px solid var(--border)" }}>
                <canvas ref={close} style={{ display: "block", width: "100%", height: 94 }} aria-label={t("Splice close-up")} role="img" />
                <div aria-hidden="true" style={{ position: "absolute", top: 0, bottom: 0, left: "50%", width: 1, background: "var(--cut)" }} />
                <span className="mono muted" style={{ position: "absolute", right: 6, bottom: 4, fontSize: 10 }}>{t("crossfade {n} ms", { n: auto?.crossfade_ms ?? 40 })}</span>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button className="iconbtn" style={{ width: 44, height: 42 }} aria-label={t("Play splice")} title={t("2 s before and after")} onClick={() => play(Math.max(0, splice.episode_time - 2), splice.episode_time + 2)}>
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M3 2l9 5-9 5z" /></svg>
                </button>
                <button className="btn" style={{ flex: 1, height: 42, fontWeight: 600 }} disabled={busy} onClick={restore}>{t("Restore removed audio")}</button>
              </div>
              {leftEdit && rightEdit && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <h3 className="section-title" style={{ fontSize: 11 }}>{t("Splice point")}</h3>
                  <div style={{ display: "grid", gridTemplateColumns: "60px 1fr 1fr", gap: 6, alignItems: "center" }}>
                    <span className="muted" style={{ fontSize: 12 }}>{t("Left")}</span>
                    <button className="btn" style={{ height: 28 }} disabled={busy} title={t("Cut 10 ms more on the left")} onClick={() => run({ op: "adjust", id: leftEdit.id, start: leftEdit.start - 0.01 })}>{t("{n} ms", { n: "−10" })}</button>
                    <button className="btn" style={{ height: 28 }} disabled={busy} title={t("Bring back 10 ms on the left")} onClick={() => run({ op: "adjust", id: leftEdit.id, start: leftEdit.start + 0.01 })}>{t("{n} ms", { n: "+10" })}</button>
                    <span className="muted" style={{ fontSize: 12 }}>{t("Right")}</span>
                    <button className="btn" style={{ height: 28 }} disabled={busy} title={t("Bring back 10 ms on the right")} onClick={() => run({ op: "adjust", id: rightEdit.id, end: rightEdit.end - 0.01 })}>{t("{n} ms", { n: "−10" })}</button>
                    <button className="btn" style={{ height: 28 }} disabled={busy} title={t("Cut 10 ms more on the right")} onClick={() => run({ op: "adjust", id: rightEdit.id, end: rightEdit.end + 0.01 })}>{t("{n} ms", { n: "+10" })}</button>
                  </div>
                  <button className="btn" style={{ height: 28 }} disabled={busy} onClick={() => { if (rightEdit.id === leftEdit.id) run({ op: "adjust", id: leftEdit.id, snap: "both" }); else { run({ op: "adjust", id: leftEdit.id, snap: "start" }); run({ op: "adjust", id: rightEdit.id, snap: "end" }); } }}>{t("Move to silence")}</button>
                </div>
              )}
            </>
          )}

          {sel?.kind === "range" && (
            <>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t("Selection")}</h2>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <tbody>
                  <Row k={t("In")} v={fmtEp(Math.min(sel.A, sel.B), true)} />
                  <Row k={t("Out")} v={fmtEp(Math.max(sel.A, sel.B), true)} />
                  <Row k={t("Duration")} v={t("{n} s", { n: Math.abs(sel.B - sel.A).toFixed(2) })} />
                </tbody>
              </table>
              <div style={{ display: "flex", gap: 6 }}>
                <button className="iconbtn" style={{ width: 44, height: 42 }} aria-label={t("Play selection")} onClick={() => play(Math.min(sel.A, sel.B), Math.max(sel.A, sel.B))}>
                  <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M3 2l9 5-9 5z" /></svg>
                </button>
                <button className="btn cut big" style={{ flex: 1 }} disabled={busy || Math.abs(sel.B - sel.A) < 0.02} onClick={() => cutRange(sel.A, sel.B)} title="Delete">{t("Cut")} (Delete)</button>
              </div>
              <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>{t("Cuts close up immediately (ripple).")}{snap ? ` ${t("Edges will move to the quietest point nearby.")}` : ""}</div>
            </>
          )}

          {sel?.kind === "marker" && tl?.chapters[sel.i] && (
            <>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t("Marker · chapter")}</h2>
              <label className="field"><span>{t("Title")}</span>
                <input className="input" value={markerTitle} onChange={(e) => setMarkerTitle(e.target.value)}
                  onBlur={() => markerTitle.trim() && markerTitle !== tl.chapters[sel.i].title && saveMarkers(tl.chapters.map((c, k) => ({ time: c.time, title: k === sel.i ? markerTitle.trim() : c.title })))}
                  onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
              </label>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}><tbody><Row k={t("Time")} v={fmtEp(tl.chapters[sel.i].time)} /></tbody></table>
              <div className="muted" style={{ fontSize: 12 }}>{t("Drag the marker to move it. Double-click the marker lane or press M to add a marker.")}</div>
              <button className="btn" style={{ color: "var(--cut-text)" }} disabled={busy} onClick={() => { saveMarkers(tl.chapters.filter((_, k) => k !== sel.i).map((c) => ({ time: c.time, title: c.title }))); setSel(null); }}>{t("Delete marker")}</button>
            </>
          )}

          {!sel && tl && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, lineHeight: 1.55 }}>
              <h2 className="section-title">{t("Episode")}</h2>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {t("Click a splice on the track to hear it or restore what was cut. Range (R) selects a section to remove; Blade (B) splits the track so you can remove a segment. ← → jump between splices, M adds a marker, L toggles loop.")}
              </div>
            </div>
          )}

          <div style={{ marginTop: "auto", borderTop: "1px solid var(--border)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <h3 className="section-title" style={{ fontSize: 11 }}>{t("Episode loudness")}</h3>
            <div className="mono" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 }} title={m ? t("Measured on the last render") : t("Appears after the first export")}>
              {([["INT", m?.integrated_lufs], ["LRA", m?.lra_lu], ["TP", m?.true_peak_dbtp]] as [string, number | undefined][]).map(([k, v]) => (
                <div key={k}><div className="muted" style={{ fontSize: 10 }}>{k}</div><div style={{ fontSize: 17, color: "var(--bright)" }}>{v?.toFixed(1) ?? "—"}</div></div>
              ))}
            </div>
            <Link href="/export/" className="btn primary" style={{ height: 40, display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none", marginTop: 4 }}>{t("Go to export")}</Link>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <tr>
      <td className="muted" style={{ padding: "4px 0" }}>{k}</td>
      <td className="mono" style={{ padding: "4px 0", textAlign: "right", color: "var(--bright)" }}>{v}</td>
    </tr>
  );
}

function TrackHeaders({ height, showSpec, onToggleSpec, clipsCount, chain }: { height: number; showSpec: boolean; onToggleSpec: () => void; clipsCount: number; chain: number }) {
  useLang();
  const spec = showSpec ? 140 : 0;
  const track = Math.max(140, height - 26 - 28 - spec - 60);
  return (
    <div style={{ flex: `0 0 ${HEAD_W}px`, background: "var(--panel)", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column" }}>
      <div style={{ height: 26, borderBottom: "1px solid var(--border)" }} />
      <div style={{ height: 28, borderBottom: "1px solid var(--border)", padding: "0 10px", display: "flex", alignItems: "center", fontSize: 12, color: "var(--text2)" }}>{t("Markers · chapters")}</div>
      <div style={{ height: track, borderBottom: "1px solid var(--border)", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}><span className="mono" style={{ fontSize: 11, color: "var(--core)" }}>A1</span><span style={{ fontWeight: 600, color: "var(--bright)" }}>{t("Voice")}</span></div>
        <div className="mono muted" style={{ fontSize: 11 }}>{t("0.0 dB · stereo")}</div>
        <div className="muted" style={{ fontSize: 11, lineHeight: 1.5 }}>{tn("{n} clip", "{n} clips", clipsCount)}<br />{tn("processing: {n} module", "processing: {n} modules", chain)}</div>
      </div>
      {showSpec && (
        <div style={{ height: 140, borderBottom: "1px solid var(--border)", padding: "8px 10px", fontSize: 12 }}>
          <div style={{ color: "var(--bright)", fontWeight: 500 }}>{t("Spectrum A1")}</div>
          <div className="muted" style={{ fontSize: 11 }}>{t("60 Hz – 12 kHz")}</div>
          <button className="btn" style={{ height: 24, fontSize: 11, marginTop: 8, padding: "0 8px" }} onClick={onToggleSpec}>{t("Hide")}</button>
        </div>
      )}
      <div style={{ height: 60, borderBottom: "1px solid var(--border)", padding: "8px 10px", fontSize: 12, display: "flex", flexDirection: "column" }}>
        <div style={{ color: "var(--bright)", fontWeight: 500 }}>{t("Loudness")}</div>
        <div className="muted" style={{ fontSize: 11 }}>{t("ST 3 s · target {lufs}", { lufs: "−16" })}</div>
        {!showSpec && <button className="btn" style={{ height: 20, fontSize: 10.5, padding: "0 6px", marginTop: 2, alignSelf: "flex-start" }} onClick={onToggleSpec}>{t("Show spectrum")}</button>}
      </div>
    </div>
  );
}
