"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EngineBanner, useEngine } from "@/components/Shell";
import { dirname, isDesktop, joinPath, pickFile, revealFile } from "@/lib/desktop";
import {
  currentProject, engine, fmtClock, fmtDuration, parseTimecode,
  type ExportResult, type Job, type Summary, type TemplateInfo, type TemplateParam,
} from "@/lib/engine";

type Row = { key: number; time: string; title: string; orig?: number };
type Prev = { state: "idle" | "busy" | "ready" | "error"; video?: string; poster?: string; error?: string; started?: number };

const STAGES: Record<string, string> = {
  render: "Зведення й обробка звуку", wav: "WAV", mp3: "MP3 з розділами", video: "Відео", mux: "Звук і розділи у відео", done: "Готово",
};
let rowKey = 0;
const toRows = (s: Summary | null, hours: boolean): Row[] => (s?.chapters ?? []).map((c) => ({ key: ++rowKey, time: fmtClock(c.time, hours), title: c.title, orig: c.time }));

function missingRequired(t: TemplateInfo | null, params: Record<string, unknown>): TemplateParam[] {
  return t?.params.filter((p) => p.required && (params[p.key] === undefined || params[p.key] === null || params[p.key] === "")) ?? [];
}

export default function ExportPage() {
  const { health } = useEngine();
  const [path, setPath] = useState<string | null>(null);
  const [s, setS] = useState<Summary | null>(null);
  const [measured, setMeasured] = useState<{ integrated_lufs?: number; true_peak_dbtp?: number; lra_lu?: number } | null>(null);
  const [tpls, setTpls] = useState<TemplateInfo[]>([]);
  const [mode, setMode] = useState<"audio" | "video">("audio");
  const [tplId, setTplId] = useState("");
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [wav, setWav] = useState(true);
  const [mp3, setMp3] = useState(true);
  const [posters, setPosters] = useState<Record<string, string>>({});
  const [prev, setPrev] = useState<Prev>({ state: "idle" });
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const prevReq = useRef(0);
  const stamp = useRef<number | null>(null);

  const hours = (s?.edited_s ?? 0) >= 3600;
  const tpl = tpls.find((t) => t.id === tplId) ?? null;
  const running = job?.state === "running" || job?.state === "queued";

  const load = useCallback(async (p: string, first: boolean) => {
    const [sum, tl] = await Promise.all([engine.summary(p), engine.timeline(p)]);
    setS(sum);
    setMeasured(tl.measured);
    if (first) {
      setWav(sum.export.wav);
      setMp3(sum.export.mp3);
    }
    setRows((old) => (first || !dirty ? toRows(sum, (sum.edited_s ?? 0) >= 3600) : old));
    stamp.current = (await engine.stamp(p)).mtime;
    return sum;
  }, [dirty]);

  useEffect(() => {
    const p = currentProject.get();
    setPath(p);
    if (!p || !health) return;
    Promise.all([load(p, true), engine.templates(p)]).then(([sum, t]) => {
      setTpls(t.templates);
      const chosen = t.templates.find((x) => x.id === sum.export.video.template && x.ready);
      if (chosen) {
        setMode("video");
        setTplId(chosen.id);
        setParams(chosen.initial);
      } else if (t.templates.find((x) => x.ready)) {
        const first = t.templates.find((x) => x.ready)!;
        setTplId(first.id);
        setParams(first.initial);
      }
    }).catch((e) => setErr(String(e.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(health)]);

  // chapters set by Claude (MCP) appear without reloading
  useEffect(() => {
    if (!path) return;
    const id = setInterval(async () => {
      try {
        const m = (await engine.stamp(path)).mtime;
        if (m && stamp.current && m > stamp.current + 0.001 && !dirty) await load(path, false);
      } catch {}
    }, 3000);
    return () => clearInterval(id);
  }, [path, dirty, load]);

  // card posters: a 3-second render of each template with its saved / default parameters
  useEffect(() => {
    if (!path || mode !== "video" || !tpls.length) return;
    let alive = true;
    (async () => {
      for (const t of tpls) {
        if (!alive || posters[t.id] || !t.ready || missingRequired(t, t.initial).length) continue;
        try {
          const r = await engine.preview(path, t.id, t.initial, 3);
          if (alive) setPosters((p) => ({ ...p, [t.id]: engine.cacheUrl(r.poster) }));
        } catch {}
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, mode, tpls]);

  // live preview of the chosen template with the current parameters (debounced)
  useEffect(() => {
    if (!path || mode !== "video" || !tpl) return;
    if (!tpl.ready) return setPrev({ state: "error", error: `Шаблону бракує модулів Python: ${tpl.missing.join(", ")}` });
    const miss = missingRequired(tpl, params);
    if (miss.length) return setPrev({ state: "idle", error: `Заповніть: ${miss.map((p) => p.label).join(", ")} — і тут з'явиться прев'ю` });
    const req = ++prevReq.current;
    const timer = window.setTimeout(async () => {
      setPrev((p) => ({ ...p, state: "busy", started: Date.now() }));
      try {
        const r = await engine.preview(path, tpl.id, params, 6);
        if (req !== prevReq.current) return;
        setPrev({ state: "ready", video: engine.cacheUrl(r.video), poster: engine.cacheUrl(r.poster) });
        setPosters((p) => ({ ...p, [tpl.id]: engine.cacheUrl(r.poster) }));
      } catch (e) {
        if (req === prevReq.current) setPrev({ state: "error", error: e instanceof Error ? e.message : String(e) });
      }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [path, mode, tpl, params]);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (prev.state !== "busy") return;
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, [prev.state]);

  // ---- chapters ---------------------------------------------------------------------------------
  const badRows = useMemo(() => rows.filter((r) => r.title.trim() && parseTimecode(r.time) === null).map((r) => r.key), [rows]);
  const editRow = (key: number, patch: Partial<Row>) => { setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r))); setDirty(true); };
  const saveChapters = async () => {
    if (!path || badRows.length) return;
    try {
      const items = rows.filter((r) => r.title.trim()).map((r) => ({
        time: r.orig !== undefined && r.time === fmtClock(r.orig, hours) ? r.orig : parseTimecode(r.time) ?? 0,
        title: r.title.trim(),
      }));
      const sum = await engine.setChapters(path, items);
      setS(sum);
      setRows(toRows(sum, hours));
      setDirty(false);
      stamp.current = (await engine.stamp(path)).mtime;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const askClaude = async () => {
    try {
      await navigator.clipboard.writeText(`Зроби таймкоди (розділи) для випуску «${s?.name ?? ""}» у Holos Studio.`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {}
  };

  // ---- export -----------------------------------------------------------------------------------
  const video = mode === "video" && tpl;
  const blocker = (video && !tpl!.ready && "Шаблону бракує модулів") || (video && missingRequired(tpl, params).length && `Заповніть: ${missingRequired(tpl, params).map((p) => p.label).join(", ")}`)
    || (dirty && "Збережіть таймкоди") || (!wav && !mp3 && !video && "Нічого не вибрано") || null;

  const start = async () => {
    if (!path) return;
    setErr(null);
    setResult(null);
    try {
      const j = await engine.exportProject({ path, wav, mp3, chapters_txt: true, chapters_embed: true, video: { template: video ? tpl!.id : null, params: video ? params : {} } });
      setJob(j);
      engine.watch(j.id, (u) => {
        setJob(u);
        if (u.state === "done") {
          setResult(u.result as ExportResult);
          engine.timeline(path).then((t) => setMeasured(t.measured)).catch(() => {});
        }
        if (u.state === "error") setErr(u.error);
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (!path) {
    return <div className="main" style={{ padding: 20 }}><div className="banner">Проєкт не відкрито. <Link href="/">Виберіть або створіть проєкт</Link>.</div></div>;
  }

  const name = s?.name ?? "епізод";
  const outDir = joinPath(dirname(path), "export");
  const files: [string, string, string][] = [];
  if (wav) files.push(["WAV", `${name}.wav`, "var(--text2)"]);
  if (mp3) files.push(["MP3", `${name}.mp3`, "var(--text2)"]);
  if (video) files.push(["MP4", `${name}.mp4`, "var(--loud)"]);
  if (rows.length) files.push(["TXT", "таймкоди.txt", "var(--core)"]);
  const warn = s?.chapter_warnings ?? [];

  return (
    <div className="main">
      <section aria-label="Що експортувати" style={{ flex: "0 1 400px", minWidth: 320, padding: "18px 20px", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 14 }}>
        <EngineBanner />
        <h2 className="section-title">Що зробити</h2>
        <div role="radiogroup" aria-label="Що експортувати" className="seg">
          <button role="radio" aria-checked={mode === "audio"} style={{ minHeight: 62, textAlign: "left", padding: "8px 12px" }} disabled={running} onClick={() => setMode("audio")}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Тільки аудіо</span><br /><span className="muted" style={{ fontSize: 11.5 }}>WAV + MP3 + таймкоди</span>
          </button>
          <button role="radio" aria-checked={mode === "video"} style={{ minHeight: 62, textAlign: "left", padding: "8px 12px" }} disabled={running} onClick={() => setMode("video")}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Аудіо + відео</span><br /><span className="muted" style={{ fontSize: 11.5 }}>+ MP4 для YouTube</span>
          </button>
        </div>

        {mode === "video" && (
          <>
            <h2 className="section-title" style={{ marginTop: 4 }}>Вигляд відео</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 8 }}>
              {tpls.map((t) => {
                const on = t.id === tplId;
                return (
                  <button key={t.id} aria-pressed={on} disabled={running} onClick={() => { setTplId(t.id); setParams(t.initial); }}
                    style={{ padding: 0, border: on ? "2px solid var(--core)" : "1px solid var(--border)", background: on ? "var(--sel-row)" : "var(--panel)", color: on ? "var(--bright)" : "var(--text2)", overflow: "hidden", textAlign: "left" }}>
                    {posters[t.id]
                      ? <img src={posters[t.id]} alt="" style={{ display: "block", width: "100%", aspectRatio: "16 / 9", objectFit: "cover" }} />
                      : <span style={{ display: "flex", alignItems: "center", justifyContent: "center", aspectRatio: "16 / 9", background: "#000", fontSize: 10.5, color: "var(--muted)", padding: 4, textAlign: "center" }}>{t.ready ? "прев'ю…" : "бракує модулів"}</span>}
                    <span style={{ display: "block", padding: "6px 6px 7px", fontSize: 11.5, lineHeight: 1.3 }}>{t.name}</span>
                  </button>
                );
              })}
            </div>
            {tpl && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {tpl.description && <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>{tpl.description}</div>}
                {!tpl.ready && <div className="banner error" style={{ fontSize: 12 }}>Бракує модулів Python: <span className="mono">{tpl.missing.join(", ")}</span>{tpl.install ? <> — <span className="mono">{tpl.install}</span></> : null}</div>}
                {tpl.params.map((p) => (
                  <ParamField key={p.key} p={p} value={params[p.key]} disabled={running} onChange={(v) => setParams((o) => ({ ...o, [p.key]: v }))} />
                ))}
              </div>
            )}
          </>
        )}

        <h2 className="section-title" style={{ marginTop: 4 }}>Формати</h2>
        <label className="check"><input type="checkbox" checked={wav} disabled={running} onChange={(e) => setWav(e.target.checked)} />WAV <span className="muted" style={{ fontSize: 12 }}>24-bit · 48 kHz — майстер</span></label>
        <label className="check"><input type="checkbox" checked={mp3} disabled={running} onChange={(e) => setMp3(e.target.checked)} />MP3 <span className="muted" style={{ fontSize: 12 }}>192 kbps, розділи всередині</span></label>
      </section>

      <section aria-label="Прев'ю і таймкоди" style={{ flex: "999 1 560px", minWidth: 0, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
        {err && <div className="banner error" role="alert" style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{err}</div>}
        {mode === "video" && (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <h2 className="section-title">Живе прев&apos;ю</h2>
              <span className="muted" style={{ fontSize: 12 }}>перші 6 с вашого епізоду через шаблон · змінюйте налаштування — перемальовується саме</span>
            </div>
            <div style={{ position: "relative", background: "#000", border: "1px solid var(--border)", aspectRatio: "16 / 9", maxHeight: "48vh" }}>
              {prev.video && (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video key={prev.video} src={prev.video} poster={prev.poster} autoPlay loop muted playsInline controls
                  style={{ display: "block", width: "100%", height: "100%", objectFit: "contain" }} aria-label="Прев'ю відео" />
              )}
              {prev.state !== "ready" && (
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, background: prev.video ? "rgba(0,0,0,0.6)" : "transparent", padding: 20, textAlign: "center" }}>
                  {prev.state === "busy" ? (
                    <>
                      <span style={{ color: "var(--bright)" }}>Рендерю прев&apos;ю…</span>
                      <span className="mono muted" style={{ fontSize: 11 }} data-tick={tick}>{prev.started ? `${Math.round((Date.now() - prev.started) / 1000)} с` : ""} · перший раз ще зводиться звук епізоду</span>
                    </>
                  ) : (
                    <span className="muted" style={{ maxWidth: 420, lineHeight: 1.5 }}>{prev.error ?? "Виберіть вигляд відео ліворуч"}</span>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <h2 className="section-title">Таймкоди</h2>
          <span className="muted" style={{ fontSize: 12 }}>{s?.chapters.some((c) => c.origin === "claude") ? "поставив Claude · можна правити" : "можна правити"}</span>
          <button className="btn" style={{ marginLeft: "auto", height: 28, fontSize: 12 }} onClick={askClaude} title="Скопіювати запит і вставити в Claude Desktop">{copied ? "Скопійовано — вставте в Claude" : "Попросити Claude"}</button>
          <button className="btn" style={{ height: 28, fontSize: 12 }} disabled={running} onClick={() => {
            const last = rows.length ? parseTimecode(rows[rows.length - 1].time) ?? 0 : -60;
            setRows((r) => [...r, { key: ++rowKey, time: fmtClock(Math.max(0, last + 60), hours), title: "" }]);
            setDirty(true);
          }}>+ Таймкод</button>
        </div>
        {rows.length === 0 ? (
          <div className="card" style={{ padding: 14, lineHeight: 1.6, color: "var(--text2)" }}>
            Таймкодів ще немає. Попросіть Claude: «Зроби таймкоди для {name}» — він прочитає епізод і поставить розділи, вони з&apos;являться тут самі. Або додайте вручну, чи маркерами в редакторі (M).
          </div>
        ) : (
          <ol aria-label="Таймкоди" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", borderTop: "1px solid var(--border)", borderLeft: "1px solid var(--border)" }}>
            {rows.map((r, i) => (
              <li key={r.key} style={{ display: "flex", borderRight: "1px solid var(--border)", borderBottom: "1px solid var(--border)" }}>
                <input aria-label={`Час ${i + 1}`} className="input mono" value={i === 0 ? fmtClock(0, hours) : r.time} disabled={i === 0 || running}
                  onChange={(e) => editRow(r.key, { time: e.target.value })}
                  style={{ width: 70, border: 0, borderRight: "1px solid var(--border)", background: "transparent", textAlign: "center", color: badRows.includes(r.key) ? "var(--cut)" : "var(--core)" }} />
                <input aria-label={`Назва ${i + 1}`} className="input" value={r.title} disabled={running} placeholder="Назва розділу" onChange={(e) => editRow(r.key, { title: e.target.value })}
                  style={{ flex: "1 1 auto", minWidth: 0, border: 0, background: "transparent" }} />
                <button className="iconbtn" style={{ border: 0, background: "transparent", height: 34 }} aria-label={`Видалити ${i + 1}`} disabled={running}
                  onClick={() => { setRows((rs) => rs.filter((x) => x.key !== r.key)); setDirty(true); }}>×</button>
              </li>
            ))}
          </ol>
        )}
        {dirty && (
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn primary" disabled={badRows.length > 0} onClick={saveChapters}>Зберегти таймкоди</button>
            <button className="btn" onClick={() => { setRows(toRows(s, hours)); setDirty(false); }}>Скасувати</button>
            {badRows.length > 0 && <span style={{ color: "var(--cut-text)", fontSize: 12, alignSelf: "center" }}>Час у форматі ХХ:СС</span>}
          </div>
        )}
        {!dirty && warn.length > 0 && <div className="banner" style={{ fontSize: 12 }}>{warn.map((w) => <div key={w}>{translateWarning(w)}</div>)}</div>}
        <div className="muted" style={{ fontSize: 12 }}>Ці ж таймкоди підуть у файл для опису YouTube і всередину MP3 / MP4 — плеєри покажуть розділи самі.</div>
      </section>

      <aside aria-label="Куди і перевірка" className="panel" style={{ flex: "0 1 320px", minWidth: 280, borderLeft: "1px solid var(--border)", padding: "18px", display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 className="section-title">Буде у папці проєкту</h2>
        <div className="mono muted" style={{ fontSize: 11, lineHeight: 1.5, wordBreak: "break-all" }}>{outDir}</div>
        <ul style={{ listStyle: "none", margin: 0, padding: 0, border: "1px solid var(--border)" }}>
          {files.map(([ext, n, c]) => (
            <li key={ext} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid #1c1f1c" }}>
              <span className="mono" style={{ flex: "0 0 40px", fontSize: 10.5, color: "var(--bg)", background: c, textAlign: "center", padding: "1px 0" }}>{ext}</span>
              <span style={{ flex: "1 1 auto", minWidth: 0, fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n}</span>
            </li>
          ))}
        </ul>
        <table className="table" style={{ fontSize: 12.5 }}>
          <tbody>
            <Check k="Тривалість" v={fmtDuration(s?.edited_s)} ok />
            <Check k="Гучність" v={measured?.integrated_lufs !== undefined ? `${measured.integrated_lufs.toFixed(1)} LUFS` : `${s?.settings.target_lufs ?? -16} LUFS (ціль)`} ok />
            <Check k="True peak" v={measured?.true_peak_dbtp !== undefined ? `${measured.true_peak_dbtp.toFixed(1)} dBTP` : "−2.0 dBTP (стеля)"} ok={(measured?.true_peak_dbtp ?? -2) <= -1} />
            <Check k="Таймкодів" v={String(s?.chapters.length ?? 0)} ok={warn.length === 0 && (s?.chapters.length ?? 0) > 0} />
          </tbody>
        </table>
        {blocker && <div className="muted" style={{ fontSize: 12 }}>{blocker}</div>}
        <button className="btn primary" style={{ height: 54, fontSize: 15 }} disabled={running || !!blocker || !health} onClick={start}>{running ? "Експортую…" : "Експортувати"}</button>
        {job && running && <Progress job={job} />}
        {result && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h2 className="section-title">Готово за {fmtDuration(result.seconds)}</h2>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, border: "1px solid var(--border)" }}>
              {Object.entries(result.files).map(([k, f]) => (
                <li key={k} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 10px", borderBottom: "1px solid #1c1f1c" }}>
                  <span className="mono" style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }} title={f}>{f.split(/[\\/]/).pop()}</span>
                  {isDesktop() && <button className="btn" style={{ height: 26, fontSize: 11, padding: "0 8px" }} onClick={() => revealFile(f)}>Показати</button>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.55, marginTop: "auto" }}>Після рендеру гучність і піки вимірюються ще раз, звіт кладеться поруч.</div>
      </aside>
    </div>
  );
}

function Check({ k, v, ok }: { k: string; v: string; ok: boolean }) {
  return (
    <tr>
      <td style={{ paddingLeft: 0, color: "var(--text2)" }}>{k}</td>
      <td className="mono" style={{ textAlign: "right", color: "var(--bright)" }}>{v}</td>
      <td style={{ width: 18, paddingRight: 0, textAlign: "right", color: ok ? "var(--core)" : "var(--question)" }}>{ok ? "✓" : "!"}</td>
    </tr>
  );
}

function Progress({ job }: { job: Job }) {
  const pct = job.total > 0 && job.done > 0 ? Math.min(100, (100 * job.done) / job.total) : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }} aria-live="polite">
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
        <span>{STAGES[job.stage] ?? job.stage ?? "Черга"}</span>
        <span className="mono muted">{job.stage === "video" && pct !== null ? `${fmtClock(job.done)} / ${fmtClock(job.total)} · ` : ""}{fmtClock(job.elapsed)}</span>
      </div>
      <div className="bar"><i style={{ width: pct === null ? "100%" : `${pct}%`, opacity: pct === null ? 0.35 : 1 }} /></div>
    </div>
  );
}

function ParamField({ p, value, onChange, disabled }: { p: TemplateParam; value: unknown; onChange: (v: unknown) => void; disabled: boolean }) {
  const label = <span>{p.label}{p.required && <span style={{ color: "var(--question)" }}> *</span>}</span>;
  const help = p.help ? <span className="muted" style={{ fontSize: 11 }}>{p.help}</span> : null;
  if (p.type === "bool") {
    return <label className="check"><input type="checkbox" checked={!!value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />{p.label}</label>;
  }
  if (p.type === "choice") {
    return (
      <div className="field">{label}
        <div role="radiogroup" aria-label={p.label} className="seg">
          {p.options.map((o) => (
            <button key={o.value} role="radio" aria-checked={String(value ?? p.default) === o.value} disabled={disabled} onClick={() => onChange(o.value)} style={{ minHeight: 38 }}>{o.label || o.value}</button>
          ))}
        </div>{help}
      </div>
    );
  }
  if (p.type === "file") {
    const v = (value as string) ?? "";
    return (
      <div className="field">{label}
        <span style={{ display: "flex" }}>
          <input className="input mono" style={{ flex: "1 1 auto", minWidth: 0, fontSize: 11, borderRight: isDesktop() ? 0 : undefined }} value={v} disabled={disabled} placeholder="Шлях до файлу" onChange={(e) => onChange(e.target.value)} />
          {isDesktop() && <button className="btn" style={{ height: 34 }} aria-label={`Вибрати: ${p.label}`} disabled={disabled} onClick={async () => { const f = await pickFile(p.filters, v || undefined); if (f) onChange(f); }}>…</button>}
        </span>{help}
      </div>
    );
  }
  if (p.type === "int" || p.type === "float") {
    const slider = p.type === "float" && p.min != null && p.max != null;
    const num = value === null || value === undefined || value === "" ? "" : String(value);
    const set = (raw: string) => onChange(raw === "" ? null : p.type === "int" ? parseInt(raw, 10) : parseFloat(raw));
    return (
      <div className="field">{label}
        <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {slider && <input type="range" aria-label={p.label} min={p.min!} max={p.max!} step={p.step ?? 0.01} value={num || String(p.default ?? p.min)} disabled={disabled} onChange={(e) => set(e.target.value)} style={{ flex: "1 1 auto" }} />}
          <input className="input mono" type="number" min={p.min ?? undefined} max={p.max ?? undefined} step={p.step ?? (p.type === "int" ? 1 : 0.01)} value={num} disabled={disabled} onChange={(e) => set(e.target.value)} style={{ width: slider ? 80 : 120 }} />
        </span>{help}
      </div>
    );
  }
  return <label className="field">{label}<input className="input" value={(value as string) ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value)} />{help}</label>;
}

function translateWarning(w: string): string {
  const few = w.match(/at least (\d+)$/);
  if (few) return `YouTube показує розділи, лише коли їх щонайменше ${few[1]}.`;
  const short = w.match(/^chapter '(.*)' is shorter than (\d+) s$/);
  if (short) return `Розділ «${short[1]}» коротший за ${short[2]} с — YouTube його не покаже.`;
  return w;
}
