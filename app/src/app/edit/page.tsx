"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EngineBanner } from "@/components/Shell";
import { Lanes, laneLayout, selectionText, type Assets, type Sel, type View } from "@/components/editor/Lanes";
import { Overview, OVERVIEW_H } from "@/components/editor/Overview";
import { Player, type Pos } from "@/components/editor/player";
import { currentProject, engine, type EditRequest } from "@/lib/engine";
import { KIND_LABEL, episodeTime, fmtShort, fmtTc, reasonUk, type Timeline, type TlEdit } from "@/lib/timeline";

type Filter = "questions" | "auto" | "mine" | "all";
const LABEL_W = 104;

const KIND_COLOR: Record<string, string> = {
  pause: "#6a706a",
  breath: "var(--breath)",
  fill: "var(--dim)",
};
const colorOf = (e: TlEdit) => (e.type === "cut" ? (e.status === "suggested" ? "var(--question)" : e.status === "rejected" ? "var(--muted)" : "var(--cut)") : KIND_COLOR[e.kind] ?? "var(--dim)");

function useAssets(path: string | null, tl: Timeline | null): Assets {
  const [a, setA] = useState<Assets>({ peaks: {}, spec: {}, loud: {}, version: 0 });
  const key = tl ? tl.sources.map((s) => s.id).join(",") : "";
  useEffect(() => {
    if (!path || !tl) return;
    let alive = true;
    const ids = tl.sources.map((s) => s.id);
    const bump = (f: (p: Assets) => Assets) => alive && setA((p) => ({ ...f(p), version: p.version + 1 }));
    const one = async (sid: string) => {
      try {
        const pk = await engine.peaks(path, sid);
        bump((p) => ({ ...p, peaks: { ...p.peaks, [sid]: pk } }));
        await new Promise<void>((res) => {
          const img = new Image();
          img.onload = () => {
            bump((p) => ({ ...p, spec: { ...p.spec, [sid]: img } }));
            res();
          };
          img.onerror = () => res();
          img.src = engine.assetUrl("spectrogram", path, sid);
        });
        const L = await engine.loudness(path, sid);
        bump((p) => ({ ...p, loud: { ...p.loud, [sid]: L } }));
      } catch {}
    };
    (async () => {
      const queue = [...ids];
      await Promise.all(Array.from({ length: 3 }, async () => {
        while (alive && queue.length) await one(queue.shift()!);
      }));
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, key]);
  return a;
}

export default function EditPage() {
  const [path, setPath] = useState<string | null>(null);
  const [tl, setTl] = useState<Timeline | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Sel>(null);
  const [filter, setFilter] = useState<Filter>("questions");
  const [view, setView] = useState<View>({ x0: 0, pps: 1 });
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [pos, setPos] = useState<Pos | null>(null);
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<"result" | "original">("result");
  const player = useRef<Player | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);
  const assets = useAssets(path, tl);
  const layout = useMemo(() => laneLayout(height - OVERVIEW_H - 46), [height]);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  // ---- load -------------------------------------------------------------------------------------
  useEffect(() => {
    const p = currentProject.get();
    setPath(p);
    if (!p) return;
    engine.timeline(p).then((t) => {
      setTl(t);
      const q = t.edits.filter((e) => e.status === "suggested").sort((a, b) => (a.episode_time ?? 0) - (b.episode_time ?? 0));
      if (q.length) setSel({ kind: "edit", id: q[0].id });
      else setFilter("all");
      if (t.sources[0]) setPos({ sid: t.sources[0].id, t: t.sources[0].a0 ?? 0 });
    }).catch((e) => setErr(String(e.message ?? e)));
    const pl = new Player(p);
    pl.onTick = (q) => setPos(q);
    pl.onState = (on) => setPlaying(on);
    player.current = pl;
    return () => pl.destroy();
  }, []);

  useEffect(() => {
    if (tl) player.current?.setTimeline(tl);
  }, [tl]);
  useEffect(() => {
    player.current?.setMode(mode);
  }, [mode]);

  // canvas width follows the window
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWidth(Math.max(200, el.clientWidth - LABEL_W));
      setHeight(el.clientHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [tl]);

  const total = tl?.original_length ?? 1;
  const clampView = useCallback(
    (v: View): View => {
      const minPps = width / Math.max(1, total);
      const pps = Math.max(minPps, Math.min(2000, v.pps));
      const span = width / pps;
      return { pps, x0: Math.min(Math.max(-0.5, v.x0), Math.max(0, total - span + 0.5)) };
    },
    [width, total],
  );
  const changeView = useCallback((v: View) => setView(clampView(v)), [clampView]);

  // start with the whole episode in view
  useEffect(() => {
    if (tl && width > 0 && !fitted.current) {
      fitted.current = true;
      setView({ x0: 0, pps: width / Math.max(1, tl.original_length) });
    }
  }, [tl, width]);

  const xOf = useCallback((sid: string, t: number) => {
    const s = tl?.sources.find((q) => q.id === sid);
    return s ? s.offset + t : 0;
  }, [tl]);

  // keep the playhead visible while playing
  useEffect(() => {
    if (!playing || !pos || !tl) return;
    const x = xOf(pos.sid, pos.t);
    const span = width / view.pps;
    if (x > view.x0 + span * 0.92 || x < view.x0) changeView({ ...view, x0: x - span * 0.1 });
  }, [pos, playing, tl, width, view, xOf, changeView]);

  const zoomTo = (seconds: number | "all") => {
    if (!tl) return;
    if (seconds === "all") return changeView({ x0: 0, pps: width / Math.max(1, tl.original_length) });
    const center = pos ? xOf(pos.sid, pos.t) : view.x0 + width / view.pps / 2;
    const pps = width / seconds;
    changeView({ pps, x0: center - seconds * 0.35 });
  };

  const focusEdit = (e: TlEdit) => {
    setSel({ kind: "edit", id: e.id });
    const x0 = xOf(e.source, e.start);
    const x1 = xOf(e.source, e.end);
    const span = width / view.pps;
    const needZoom = span > 60 || x1 - x0 > span * 0.8;
    const pps = needZoom ? width / Math.max(8, (x1 - x0) * 4) : view.pps;
    const nspan = width / pps;
    if (needZoom || x0 < view.x0 || x1 > view.x0 + span) changeView({ pps, x0: (x0 + x1) / 2 - nspan / 2 });
    setPos({ sid: e.source, t: Math.max(0, e.start - 1) });
  };

  // ---- edits ------------------------------------------------------------------------------------
  // operations run strictly one after another, so a fast Ctrl+Z never overtakes the cut it should undo
  const run = (req: Omit<EditRequest, "path">, next?: (t: Timeline & { id?: string }) => void) => {
    if (!path) return;
    setBusy(true);
    setErr(null);
    queue.current = queue.current.then(async () => {
      try {
        const t = await engine.edit({ path, ...req });
        setTl(t);
        next?.(t);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    });
  };

  const questions = useMemo(() => (tl?.edits ?? []).filter((e) => e.status === "suggested").sort((a, b) => (a.episode_time ?? 0) - (b.episode_time ?? 0)), [tl]);
  const selected = sel?.kind === "edit" ? tl?.edits.find((e) => e.id === sel.id) ?? null : null;

  const decide = (e: TlEdit, cut: boolean) => {
    const wasQuestion = e.status === "suggested";
    run({ op: "status", ids: [e.id], status: cut ? "accepted" : "rejected" }, (t) => {
      if (!wasQuestion) return;
      const rest = t.edits.filter((x) => x.status === "suggested").sort((a, b) => (a.episode_time ?? 0) - (b.episode_time ?? 0));
      const nxt = rest.find((x) => (x.episode_time ?? 0) >= (e.episode_time ?? 0)) ?? rest[0];
      if (nxt) focusEdit(nxt);
    });
  };

  const cutSelection = () => {
    if (!sel || !tl) return;
    if (sel.kind === "range") {
      run({ op: "cut", source: sel.source, start: Math.min(sel.a, sel.b), end: Math.max(sel.a, sel.b), snap: true }, (t) => t.id && setSel({ kind: "edit", id: t.id }));
    } else if (sel.kind === "words") {
      run({ op: "cut_words", source: sel.source, i0: Math.min(sel.i0, sel.i1), i1: Math.max(sel.i0, sel.i1) }, (t) => t.id && setSel({ kind: "edit", id: t.id }));
    } else if (selected) {
      if (selected.kind === "manual") run({ op: "delete", id: selected.id }, () => setSel(null));
      else decide(selected, true);
    }
  };

  const nudge = (e: TlEdit, edge: "start" | "end", ms: number) =>
    run({ op: "adjust", id: e.id, ...(edge === "start" ? { start: e.start + ms / 1000 } : { end: e.end + ms / 1000 }) });

  // ---- playback ---------------------------------------------------------------------------------
  const togglePlay = () => {
    const pl = player.current;
    if (!pl || !pos) return;
    if (playing) pl.pause();
    else pl.play(pos);
  };

  const listen = (sid: string, a: number, b: number) => {
    const pl = player.current;
    if (!pl) return;
    pl.pause();
    pl.play({ sid, t: Math.max(0, a - 2) }, { sid, t: b + 2 });
  };

  const seek = (sid: string, t: number) => {
    setPos({ sid, t });
    if (playing) player.current?.play({ sid, t });
  };

  // ---- list -------------------------------------------------------------------------------------
  const lists = useMemo(() => {
    const es = [...(tl?.edits ?? [])].sort((a, b) => (a.episode_time ?? 0) - (b.episode_time ?? 0) || a.start - b.start);
    return {
      questions: es.filter((e) => e.status === "suggested"),
      auto: es.filter((e) => e.status !== "suggested" && e.kind !== "manual" && (e.type === "cut" || e.type === "pause")),
      mine: es.filter((e) => e.kind === "manual"),
      all: es,
    };
  }, [tl]);
  const items = lists[filter];

  // ---- keyboard ---------------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const k = ev.key.toLowerCase();
      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && (k === "z" || k === "я")) {
        ev.preventDefault();
        run({ op: ev.shiftKey ? "redo" : "undo" });
      } else if (mod && (k === "y" || k === "н")) {
        ev.preventDefault();
        run({ op: "redo" });
      } else if (ev.code === "Space") {
        ev.preventDefault();
        togglePlay();
      } else if (!mod && (ev.code === "KeyY" || ev.code === "KeyN")) {
        const target = selected?.type === "cut" ? selected : questions[0];
        if (target) decide(target, ev.code === "KeyY");
      } else if (!mod && (ev.code === "KeyC" || k === "delete" || k === "backspace")) {
        ev.preventDefault();
        cutSelection();
      } else if (k === "arrowdown" || k === "arrowup") {
        ev.preventDefault();
        const i = selected ? items.findIndex((e) => e.id === selected.id) : -1;
        const nxt = items[k === "arrowdown" ? i + 1 : Math.max(0, i - 1)];
        if (nxt) focusEdit(nxt);
      } else if (k === "home" && tl?.sources[0]) {
        seek(tl.sources[0].id, tl.sources[0].a0 ?? 0);
      } else if (k === "=" || k === "+") {
        changeView({ x0: view.x0 + (width / view.pps) * 0.25, pps: view.pps * 2 });
      } else if (k === "-") {
        changeView({ x0: view.x0 - width / view.pps / 2, pps: view.pps / 2 });
      } else if (k === "escape") {
        setSel(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!path) {
    return (
      <div className="main" style={{ padding: 20 }}>
        <div className="banner">Проєкт не відкрито. <Link href="/import/">Почніть з імпорту</Link>.</div>
      </div>
    );
  }

  const epNow = tl && pos ? episodeTime(tl, pos.sid, pos.t) : null;
  const srcName = tl && pos ? tl.sources.find((s) => s.id === pos.sid)?.name.replace(/\.wav$/i, "") : "";
  const m = tl?.measured;

  return (
    <div style={{ height: "calc(100vh - 64px)", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {/* ---- toolbar ---- */}
      <div role="toolbar" aria-label="Транспорт і масштаб" style={{ minHeight: 52, display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "6px 14px", background: "var(--panel)", borderBottom: "1px solid var(--border)" }}>
        <div role="group" aria-label="Транспорт" style={{ display: "flex", gap: 4 }}>
          <button className="btn" style={{ width: 34, height: 34, padding: 0 }} aria-label="На початок (Home)" title="На початок (Home)" onClick={() => tl?.sources[0] && seek(tl.sources[0].id, tl.sources[0].a0 ?? 0)}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="2" y="2" width="1.6" height="10" /><path d="M12 2v10L4.5 7z" /></svg>
          </button>
          <button className="btn primary" style={{ width: 42, height: 34, padding: 0 }} aria-label={playing ? "Пауза (Пробіл)" : "Відтворити (Пробіл)"} title="Пробіл" onClick={togglePlay}>
            {playing ? (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="3" y="2" width="3" height="10" /><rect x="8" y="2" width="3" height="10" /></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M3 2l9 5-9 5z" /></svg>
            )}
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", padding: "2px 12px", background: "var(--lane)", border: "1px solid var(--border)", minWidth: 200 }}>
          <span className="mono" style={{ fontSize: 19, color: "var(--bright)" }}>{fmtTc(epNow)}</span>
          <span className="mono muted" style={{ fontSize: 11 }}>
            {srcName ? `${srcName} · ${fmtShort(pos?.t)}` : ""} · з {fmtTc(tl?.length, false)}
          </span>
        </div>
        <div role="group" aria-label="Масштаб" style={{ display: "flex", border: "1px solid var(--border)" }}>
          {([["all", "Увесь епізод"], [60, "1 хв"], [10, "10 с"]] as [number | "all", string][]).map(([v, l]) => (
            <button key={String(v)} className="btn" style={{ height: 34, border: 0 }} onClick={() => zoomTo(v)}>{l}</button>
          ))}
        </div>
        <div role="radiogroup" aria-label="Що слухати" style={{ display: "flex", border: "1px solid var(--border)" }}>
          {([["result", "Результат"], ["original", "Оригінал"]] as const).map(([v, l]) => (
            <button key={v} role="radio" aria-checked={mode === v} className="btn" title={v === "result" ? "Вирізане пропускається" : "Усе як записано"} style={{ height: 34, border: 0, background: mode === v ? "var(--sel)" : undefined, color: mode === v ? "var(--bright)" : "var(--text2)" }} onClick={() => setMode(v)}>{l}</button>
          ))}
        </div>
        <div role="group" aria-label="Історія" style={{ display: "flex", gap: 4 }}>
          <button className="btn" style={{ height: 34 }} disabled={!tl?.history.can_undo || busy} title={`Скасувати${tl?.history.undo_label ? `: ${tl.history.undo_label}` : ""} (Ctrl+Z)`} onClick={() => run({ op: "undo" })}>↶ Скасувати</button>
          <button className="btn" style={{ height: 34 }} disabled={!tl?.history.can_redo || busy} title={`Повторити${tl?.history.redo_label ? `: ${tl.history.redo_label}` : ""} (Ctrl+Shift+Z)`} onClick={() => run({ op: "redo" })}>↷</button>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 16, alignItems: "center" }}>
          <div className="mono" style={{ display: "grid", gridTemplateColumns: "repeat(3, auto)", gap: "0 14px", fontSize: 11 }} title={m ? "Виміряно на останньому рендері" : "Ще не рендерилось — після експорту тут будуть виміри"}>
            <span className="muted">INT</span><span className="muted">LRA</span><span className="muted">TP</span>
            <span style={{ color: "var(--bright)", fontSize: 13 }}>{m?.integrated_lufs?.toFixed(1) ?? "—"}</span>
            <span style={{ color: "var(--bright)", fontSize: 13 }}>{m?.lra_lu?.toFixed(1) ?? "—"}</span>
            <span style={{ color: "var(--bright)", fontSize: 13 }}>{m?.true_peak_dbtp?.toFixed(1) ?? "—"}</span>
          </div>
          <Link href="/export/" className="btn primary" style={{ height: 34, display: "flex", alignItems: "center", textDecoration: "none" }}>До експорту</Link>
        </div>
      </div>

      <div style={{ flex: "1 1 auto", display: "flex", minHeight: 0 }}>
        {/* ---- edit list ---- */}
        <aside aria-label="Правки" style={{ flex: "0 0 270px", minWidth: 0, background: "var(--panel)", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div role="tablist" aria-label="Фільтр правок" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", borderBottom: "1px solid var(--border)" }}>
            {([["questions", "Питання"], ["auto", "Авто"], ["mine", "Мої"], ["all", "Усі"]] as [Filter, string][]).map(([f, l]) => (
              <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}
                style={{ height: 40, border: 0, background: filter === f ? "var(--raised)" : "transparent", color: filter === f ? "var(--bright)" : "var(--text2)", boxShadow: filter === f ? `inset 0 -2px 0 ${f === "questions" ? "var(--question)" : "var(--core)"}` : "none", fontSize: 12 }}>
                {l}
                <br />
                <span className="mono" style={{ fontSize: 11, color: f === "questions" && lists.questions.length ? "var(--question)" : "var(--muted)" }}>{lists[f].length}</span>
              </button>
            ))}
          </div>
          <ol style={{ listStyle: "none", margin: 0, padding: 0, overflowY: "auto", flex: "1 1 auto" }}>
            {items.length === 0 && (
              <li className="muted" style={{ padding: 14, lineHeight: 1.5 }}>
                {filter === "questions" ? "Питань немає. Можна слухати результат або йти до експорту." : filter === "mine" ? "Виділіть шматок на хвилі або слова й натисніть C, щоб вирізати." : "Порожньо."}
              </li>
            )}
            {items.map((e) => {
              const on = selected?.id === e.id;
              return (
                <li key={e.id}>
                  <button onClick={() => focusEdit(e)} aria-current={on || undefined}
                    style={{ width: "100%", textAlign: "left", display: "grid", gridTemplateColumns: "58px 1fr auto", gap: 8, alignItems: "baseline", padding: "8px 12px", border: 0, borderBottom: "1px solid #1c1f1c", background: on ? "var(--sel-row)" : "transparent", boxShadow: on ? "inset 2px 0 0 var(--core)" : "none" }}>
                    <span className="mono" style={{ fontSize: 11, color: e.status === "suggested" ? "var(--question)" : "var(--text2)" }}>{fmtShort(e.episode_time)}</span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                        <i style={{ width: 8, height: 8, background: colorOf(e), flex: "0 0 auto" }} />
                        {KIND_LABEL[e.kind] ?? e.kind}
                      </span>
                      {e.text && <span className="muted" style={{ display: "block", fontSize: 11.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.text}</span>}
                    </span>
                    <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>{e.status === "accepted" ? "✂" : e.status === "rejected" ? "↺" : "?"}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>

        {/* ---- lanes ---- */}
        <main ref={area} style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", overflowY: "auto", overflowX: "hidden" }}>
          <EngineBanner />
          {err && <div className="banner error" role="alert" style={{ margin: 8 }}>{err}</div>}
          {!tl ? (
            <div className="muted" style={{ padding: 20 }}>Завантажую епізод…</div>
          ) : (
            <>
              <div style={{ display: "flex" }}>
                <div style={{ flex: `0 0 ${LABEL_W}px`, height: OVERVIEW_H, background: "var(--panel)", borderRight: "1px solid var(--border)", borderBottom: "1px solid var(--border)", padding: "6px 10px", fontSize: 11 }} className="muted">
                  Огляд
                </div>
                <Overview tl={tl} assets={assets} view={view} width={width} onView={changeView} />
              </div>
              <div style={{ display: "flex" }}>
                <div style={{ flex: `0 0 ${LABEL_W}px`, background: "var(--panel)", borderRight: "1px solid var(--border)" }}>
                  {layout.map((l) => (
                    <div key={l.key} style={{ height: l.h, padding: l.h > 30 ? "6px 10px" : "4px 10px", borderBottom: "1px solid var(--border)", overflow: "hidden" }}>
                      <div style={{ fontWeight: 500, color: "var(--bright)", fontSize: 12 }}>{l.name}</div>
                      {l.h > 30 && <div className="muted" style={{ fontSize: 10.5 }}>{l.sub}</div>}
                    </div>
                  ))}
                </div>
                <Lanes tl={tl} layout={layout} assets={assets} view={view} width={width} sel={sel} playheadX={pos ? xOf(pos.sid, pos.t) : null}
                  onView={changeView} onSelect={setSel} onSeek={seek}
                  onAdjust={(id, start, end) => run({ op: "adjust", id, start, end })} />
              </div>
              <div className="muted" style={{ padding: "8px 12px", fontSize: 11.5, lineHeight: 1.6, minHeight: 0 }}>
                Клік — поставити курсор · тягнути по хвилі або спектру — виділити · клік по слову (Shift — розширити) · тягнути край правки — змінити межі ·
                Ctrl + колесо — масштаб · колесо — прокрутка · Пробіл — слухати · C — вирізати · Y / N — вирізати / залишити · ↑ ↓ — по правках · Ctrl+Z — скасувати
              </div>
            </>
          )}
        </main>

        {/* ---- inspector ---- */}
        <aside aria-label="Інспектор" style={{ flex: "0 0 300px", minWidth: 0, background: "var(--panel)", borderLeft: "1px solid var(--border)", padding: 14, display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" }}>
          {tl && selected && <EditInspector tl={tl} e={selected} busy={busy} onDecide={decide} onNudge={nudge}
            onSnap={(e) => run({ op: "adjust", id: e.id, snap: "both" })}
            onDelete={(e) => run({ op: "delete", id: e.id }, () => setSel(null))}
            onListen={() => listen(selected.source, selected.start, selected.end)} />}
          {tl && sel && sel.kind !== "edit" && (
            <SelectionInspector tl={tl} sel={sel} busy={busy} onCut={cutSelection}
              onListen={() => {
                const a = sel.kind === "range" ? Math.min(sel.a, sel.b) : tl.words[sel.source][Math.min(sel.i0, sel.i1)][1];
                const b = sel.kind === "range" ? Math.max(sel.a, sel.b) : tl.words[sel.source][Math.max(sel.i0, sel.i1)][2];
                const pl = player.current;
                pl?.pause();
                pl?.play({ sid: sel.source, t: a }, { sid: sel.source, t: b });
              }} />
          )}
          {tl && !sel && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, lineHeight: 1.55 }}>
              <h2 className="section-title">Як редагувати</h2>
              <div className="muted">Виберіть правку ліворуч або на доріжці «Правки», щоб прослухати її, вирізати чи залишити, або посунути межі.</div>
              <div className="muted">Щоб вирізати своє — виділіть шматок на хвилі чи спектрі, або слова на доріжці «Слова», і натисніть <b style={{ color: "var(--text)" }}>C</b>.</div>
              <div className="muted">«Результат» — слухати з вирізаним, «Оригінал» — усе як записано.</div>
            </div>
          )}
          {tl && (
            <div style={{ marginTop: "auto", borderTop: "1px solid var(--border)", paddingTop: 10 }}>
              <h2 className="section-title" style={{ marginBottom: 6 }}>Ланцюжок обробки</h2>
              {tl.chain.map((c) => (
                <div key={c.module} className="mono" style={{ display: "flex", justifyContent: "space-between", fontSize: 11, padding: "3px 0", color: c.enabled ? "var(--text2)" : "var(--muted)" }}>
                  <span>{c.module}</span>
                  <span className="muted">{c.module === "loudness" ? `${c.params.target_lufs} LUFS` : c.enabled ? "on" : "off"}</span>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <tr>
      <td className="muted" style={{ padding: "4px 0", fontSize: 12 }}>{k}</td>
      <td className="mono" style={{ padding: "4px 0", textAlign: "right", fontSize: 12, color: "var(--bright)" }}>{v}</td>
    </tr>
  );
}

function EditInspector({ tl, e, busy, onDecide, onNudge, onSnap, onDelete, onListen }: {
  tl: Timeline; e: TlEdit; busy: boolean;
  onDecide: (e: TlEdit, cut: boolean) => void; onNudge: (e: TlEdit, edge: "start" | "end", ms: number) => void;
  onSnap: (e: TlEdit) => void; onDelete: (e: TlEdit) => void; onListen: () => void;
}) {
  const src = tl.sources.find((s) => s.id === e.source);
  const state = e.status === "suggested" ? "Питання" : e.status === "accepted" ? (e.type === "cut" ? "Вирізано" : "Застосовано") : "Залишено";
  const yes = e.type === "cut" ? "Вирізати" : e.type === "pause" ? "Скоротити" : e.type === "gain" ? "Приглушити" : "Заповнити";
  const no = e.type === "cut" ? "Залишити" : "Не чіпати";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <i style={{ width: 10, height: 10, background: colorOf(e) }} />
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{KIND_LABEL[e.kind] ?? e.kind}</h2>
        <span className="chip" style={{ marginLeft: "auto", color: e.status === "suggested" ? "var(--question)" : "var(--text2)" }}>{state}</span>
      </div>
      {reasonUk(e.reason) && <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>{reasonUk(e.reason)}</div>}
      {(e.text || e.before || e.after) && (
        <div style={{ lineHeight: 1.55, padding: 10, background: "var(--lane)", border: "1px solid var(--border)" }}>
          <span className="muted">…{e.before} </span>
          <mark style={{ background: e.status === "suggested" ? "#3a2e10" : "#3a1414", color: e.status === "suggested" ? "#ffd99a" : "#ffb3b3", padding: "0 3px", textDecoration: e.status === "accepted" ? "line-through" : "none" }}>{e.text || "[без слів]"}</mark>
          <span className="muted"> {e.after}…</span>
        </div>
      )}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          <Row k="У епізоді" v={fmtShort(e.episode_time)} />
          <Row k="Файл" v={src?.name.replace(/\.wav$/i, "") ?? e.source} />
          <Row k="Діапазон" v={`${e.start.toFixed(3)}–${e.end.toFixed(3)}`} />
          <Row k="Тривалість" v={`${(e.end - e.start).toFixed(3)} с`} />
          {e.type === "gain" && <Row k="Приглушення" v={`${e.db} dB`} />}
          {e.type === "pause" && <Row k="Скоротити до" v={`${e.target} с`} />}
        </tbody>
      </table>
      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn" style={{ width: 44, height: 44, padding: 0 }} aria-label="Прослухати" title="Прослухати з 2 с до і після" onClick={onListen}>
          <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M3 2l9 5-9 5z" /></svg>
        </button>
        <button className={`btn big ${e.status === "accepted" ? "cut" : ""}`} style={{ flex: "1 1 0", outline: e.status === "accepted" ? "1px solid var(--cut)" : undefined, background: e.status !== "accepted" && e.type === "cut" ? "var(--cut-bg)" : undefined, color: e.type === "cut" ? "var(--cut-text)" : undefined }} title="Клавіша Y" disabled={busy} onClick={() => onDecide(e, true)}>{yes}</button>
        <button className="btn big" style={{ flex: "1 1 0", outline: e.status === "rejected" ? "1px solid var(--text2)" : undefined }} title="Клавіша N" disabled={busy} onClick={() => onDecide(e, false)}>{no}</button>
      </div>
      {e.type === "cut" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <h3 className="section-title">Межі</h3>
          {(["start", "end"] as const).map((edge) => (
            <div key={edge} style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span className="muted" style={{ width: 62, fontSize: 12 }}>{edge === "start" ? "Початок" : "Кінець"}</span>
              <button className="btn" style={{ flex: 1, height: 30 }} disabled={busy} onClick={() => onNudge(e, edge, -10)}>−10 мс</button>
              <button className="btn" style={{ flex: 1, height: 30 }} disabled={busy} onClick={() => onNudge(e, edge, +10)}>+10 мс</button>
            </div>
          ))}
          <button className="btn" style={{ height: 30 }} disabled={busy} onClick={() => onSnap(e)} title="Посунути обидві межі в найтихіше місце поруч">До тиші</button>
          {e.kind === "manual" && <button className="btn" style={{ height: 30, color: "var(--cut-text)" }} disabled={busy} onClick={() => onDelete(e)}>Видалити мій різ</button>}
        </div>
      )}
    </div>
  );
}

function SelectionInspector({ tl, sel, busy, onCut, onListen }: { tl: Timeline; sel: Exclude<Sel, null>; busy: boolean; onCut: () => void; onListen: () => void }) {
  if (sel.kind === "edit") return null;
  const src = tl.sources.find((s) => s.id === sel.source);
  const ws = tl.words[sel.source] ?? [];
  const a = sel.kind === "range" ? Math.min(sel.a, sel.b) : ws[Math.min(sel.i0, sel.i1)]?.[1] ?? 0;
  const b = sel.kind === "range" ? Math.max(sel.a, sel.b) : ws[Math.max(sel.i0, sel.i1)]?.[2] ?? 0;
  const text = selectionText(tl, sel);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Виділення</h2>
      <div style={{ lineHeight: 1.55, padding: 10, background: "var(--lane)", border: "1px solid var(--border)", minHeight: 40 }}>
        {text || <span className="muted">[без слів]</span>}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <tbody>
          <Row k="Файл" v={src?.name.replace(/\.wav$/i, "") ?? sel.source} />
          <Row k="Від – до" v={`${a.toFixed(2)} – ${b.toFixed(2)}`} />
          <Row k="Тривалість" v={`${(b - a).toFixed(2)} с`} />
        </tbody>
      </table>
      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn" style={{ width: 44, height: 44, padding: 0 }} aria-label="Прослухати виділене" onClick={onListen}>
          <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><path d="M3 2l9 5-9 5z" /></svg>
        </button>
        <button className="btn big cut" style={{ flex: 1 }} disabled={busy || b - a < 0.02} onClick={onCut} title="Клавіша C">Вирізати</button>
      </div>
      <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>Межі різу самі зсуваються в найтихіше місце поруч, щоб стик не було чути.</div>
    </div>
  );
}
