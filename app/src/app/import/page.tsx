"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EngineBanner, useEngine } from "@/components/Shell";
import { currentProject, engine, fmtDuration, type FileInfo, type Job, type Summary } from "@/lib/engine";
import { dirname, isDesktop, joinPath, onFilesDropped, pickAudioFiles, pickProjectPath } from "@/lib/desktop";

const TARGETS = [
  { v: -16, label: "Подкаст · −16 LUFS · −1 dBTP" },
  { v: -14, label: "YouTube · −14 LUFS" },
  { v: -23, label: "Мовлення EBU · −23 LUFS" },
];

const AUTO = [
  { keys: ["retake", "repeat"], label: "Дублі й повтори" },
  { keys: ["filler"], label: "Слова-паразити" },
  { keys: ["gain"], label: "Вдихи · −12 dB" },
  { keys: ["pause"], label: "Паузи > 0.9 с → 0.7 с" },
  { keys: ["fill"], label: "Провали фону" },
];

const STEPS = [
  { key: "create", label: "Імпорт" },
  { key: "analyze", label: "Аналіз звуку" },
  { key: "transcribe", label: "Транскрипція" },
  { key: "suggest", label: "Пошук дублів і повторів" },
];

type Phase = "pick" | "running" | "done" | "error";

function load<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
}
function save(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
}

export default function ImportPage() {
  const { health } = useEngine();
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hover, setHover] = useState(false);
  const [pasted, setPasted] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [language, setLanguage] = useState("uk");
  const [glossary, setGlossary] = useState<string[]>([]);
  const [term, setTerm] = useState("");
  const [target, setTarget] = useState(-16);
  const [auto, setAuto] = useState<string[]>(["gain", "pause", "fill", "retake", "repeat", "filler"]);
  const [phase, setPhase] = useState<Phase>("pick");
  const [job, setJob] = useState<Job | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);

  useEffect(() => {
    setGlossary(load("holos.glossary", [] as string[]));
    setTarget(load("holos.target", -16));
    setLanguage(load("holos.language", "uk"));
  }, []);

  const addFiles = useCallback(async (paths: string[]) => {
    if (!paths.length) return;
    setBusy(true);
    setErr(null);
    try {
      const all = Array.from(new Set([...files.map((f) => f.path), ...paths]));
      const info = await engine.inspect(all);
      setFiles(info);
      if (!projectPath && info.length) {
        const dir = dirname(info[0].path);
        setProjectPath(joinPath(dirname(dir) || dir, `${dir.split(/[\\/]/).pop() || "episode"}.holos`));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [files, projectPath]);

  useEffect(() => {
    let un: (() => void) | undefined;
    onFilesDropped((p) => addFiles(p), setHover).then((f) => (un = f));
    return () => un?.();
  }, [addFiles]);

  const unique = useMemo(() => files.filter((f) => !f.duplicate_of), [files]);
  const dups = files.length - unique.length;
  const recorded = unique.reduce((a, f) => a + f.duration, 0);

  const start = async () => {
    setErr(null);
    setPhase("running");
    save("holos.glossary", glossary);
    save("holos.target", target);
    save("holos.language", language);
    try {
      await engine.create({ path: projectPath, files: unique.map((f) => f.path), language, glossary, target_lufs: target, auto_apply: auto });
      currentProject.set(projectPath);
      const j = await engine.process(projectPath);
      setJob(j);
      engine.watch(j.id, async (u) => {
        setJob(u);
        if (u.state === "done") {
          setSummary(await engine.summary(projectPath));
          setPhase("done");
        } else if (u.state === "error") {
          setErr(u.error);
          setPhase("error");
        }
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  const asrSkipped = Boolean((job?.result as { transcribe?: { skipped?: boolean } } | null)?.transcribe?.skipped)
    || (job?.stage === "transcribe" && job.total === 0);

  const stepState = (key: string): "done" | "now" | "wait" | "skip" => {
    if (phase === "pick") return "wait";
    if (asrSkipped && (key === "transcribe" || key === "suggest") && (phase === "done" || job?.stage === "transcribe")) return "skip";
    if (key === "create") return "done";
    if (phase === "done") return "done";
    const order = STEPS.map((s) => s.key);
    const cur = job?.stage || "analyze";
    if (order.indexOf(key) < order.indexOf(cur)) return "done";
    return key === cur ? "now" : "wait";
  };

  const fileStatus = (i: number): { pct: number; text: string; color: string } => {
    if (phase === "pick") return { pct: 0, text: "готово до обробки", color: "var(--muted)" };
    if (phase === "done") return { pct: 100, text: "✓", color: "var(--text2)" };
    const stage = job?.stage ?? "analyze";
    const done = job?.done ?? 0;
    const base = { analyze: 0, transcribe: 33, suggest: 66 }[stage] ?? 0;
    if (i < done) return { pct: base + 33, text: stage === "transcribe" ? "розпізнано" : stage === "analyze" ? "проаналізовано" : "перевірено", color: "var(--text2)" };
    if (i === done) return { pct: base + 15, text: stage === "transcribe" ? "транскрипція…" : stage === "analyze" ? "аналіз…" : "пошук…", color: "var(--bright)" };
    return { pct: base, text: "у черзі", color: "var(--muted)" };
  };

  const overall = phase === "done" ? 100 : phase === "running" && job
    ? Math.round((({ analyze: 0, transcribe: 1, suggest: 2 } as Record<string, number>)[job.stage] ?? 0) * 33 + (job.total ? (job.done / job.total) * 33 : 0))
    : 0;

  const applied = summary ? Object.values(summary.counts).reduce((a, c) => a + (c.accepted ?? 0), 0) : 0;

  return (
    <div className="main">
      <section style={{ flex: "999 1 560px", minWidth: 0, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
        <EngineBanner />
        {err && <div className="banner error" role="alert">{err}</div>}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
          <div
            aria-label="Додати файли"
            style={{ flex: "1 1 360px", minHeight: 120, border: `1px dashed ${hover ? "var(--core)" : "var(--dim)"}`, background: hover ? "#0c1a10" : "var(--lane)", display: "flex", alignItems: "center", justifyContent: "center", gap: 16, padding: 16 }}
          >
            <svg width="34" height="34" viewBox="0 0 34 34" fill="none" stroke="#3FD17A" strokeWidth="1.6" aria-hidden="true"><path d="M17 4v18M10 11l7-7 7 7" /><path d="M5 22v8h24v-8" /></svg>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Перетягніть записи сюди</div>
              <div className="muted" style={{ marginTop: 4 }}>WAV, FLAC, MP3, M4A · порядок за назвою файлу · дублікати відкидаються</div>
            </div>
            <button className="btn" disabled={!health || busy || phase === "running"} onClick={async () => addFiles(await pickAudioFiles())}>
              {busy ? "Читаю…" : "Вибрати файли"}
            </button>
          </div>
          <div className="panel" style={{ flex: "0 1 300px", border: "1px solid var(--border)", padding: 14, display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "10px 16px", alignContent: "center" }}>
            <div><div className="muted" style={{ fontSize: 11 }}>Файлів</div><div className="mono" style={{ fontSize: 20 }}>{unique.length}</div></div>
            <div><div className="muted" style={{ fontSize: 11 }}>Дублікатів пропущено</div><div className="mono" style={{ fontSize: 20 }}>{dups}</div></div>
            <div><div className="muted" style={{ fontSize: 11 }}>Запис</div><div className="mono" style={{ fontSize: 20 }}>{fmtDuration(recorded)}</div></div>
            <div><div className="muted" style={{ fontSize: 11 }}>Формат</div><div className="mono" style={{ fontSize: 14, paddingTop: 4 }}>{unique[0] ? `${unique[0].sr / 1000}k · ${unique[0].channels === 2 ? "стерео" : "моно"}` : "—"}</div></div>
          </div>
        </div>

        {!isDesktop() && (
          <details className="panel" style={{ border: "1px solid var(--border)", padding: "8px 12px" }}>
            <summary className="muted">Режим браузера: вставити шляхи до файлів вручну</summary>
            <textarea className="input" style={{ width: "100%", height: 90, marginTop: 8, padding: 8, fontFamily: "var(--mono)", fontSize: 11 }}
              value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={"C:\\Users\\...\\POD00005.WAV\nC:\\Users\\...\\POD00008.WAV"} />
            <button className="btn" style={{ marginTop: 8 }} disabled={!health || busy} onClick={() => addFiles(pasted.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))}>Додати</button>
          </details>
        )}

        <div style={{ border: "1px solid var(--border)", overflow: "auto", maxHeight: 520 }}>
          <table className="table">
            <thead>
              <tr><th style={{ width: 40 }}>#</th><th>Файл</th><th>Тривалість</th><th>Формат</th><th style={{ width: "34%" }}>Стан</th></tr>
            </thead>
            <tbody>
              {files.length === 0 && (
                <tr><td colSpan={5} className="muted" style={{ padding: 18 }}>Файлів ще немає.</td></tr>
              )}
              {files.map((f) => {
                const idx = unique.indexOf(f);
                const st = f.duplicate_of ? { pct: 0, text: `дублікат ${f.duplicate_of}`, color: "var(--muted)" } : fileStatus(idx);
                return (
                  <tr key={f.path} style={{ opacity: f.duplicate_of ? 0.5 : 1 }}>
                    <td className="mono muted">{f.duplicate_of ? "—" : idx + 1}</td>
                    <td className="mono">{f.name}</td>
                    <td className="mono">{fmtDuration(f.duration)}</td>
                    <td style={{ color: "var(--text2)" }}>{f.sr / 1000} kHz · {f.channels === 2 ? "стерео" : "моно"}</td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <div className="bar" style={{ flex: "1 1 auto" }}><i style={{ width: `${st.pct}%` }} /></div>
                        <span className="mono" style={{ fontSize: 11, minWidth: 110, color: st.color }}>{st.text}</span>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <aside className="panel" style={{ flex: "0 1 340px", minWidth: 290, borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column" }}>
        <section style={{ padding: 14, borderBottom: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 10 }}>
          <h2 className="section-title">Обробка</h2>
          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 2 }}>
            {STEPS.map((s) => {
              const st = stepState(s.key);
              const now = st === "now";
              return (
                <li key={s.key} style={{ display: "flex", gap: 8, padding: "7px 8px", background: now ? "var(--raised)" : "transparent" }}>
                  <span aria-hidden="true" style={{ width: 18, textAlign: "center", color: st === "done" ? "var(--core)" : now ? "var(--bright)" : "#6a706a" }}>{st === "done" ? "✓" : now ? "●" : st === "skip" ? "–" : "○"}</span>
                  <span style={{ flex: "1 1 auto" }}>
                    <span style={{ color: st === "skip" ? "var(--muted)" : "var(--bright)" }}>{s.label}</span>
                    {st === "skip" && <><br /><span className="mono muted" style={{ fontSize: 11 }}>пропущено: розпізнавання мови не встановлено</span></>}
                    {now && job && <><br /><span className="mono muted" style={{ fontSize: 11 }}>{job.total ? `${job.done} / ${job.total} · ` : ""}{job.detail}</span></>}
                  </span>
                </li>
              );
            })}
          </ol>
          <div className="bar" style={{ height: 4 }}><i style={{ width: `${overall}%` }} /></div>
          <div className="mono muted" style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
            <span>загалом {overall}%</span><span>{job ? `${job.elapsed.toFixed(0)} с` : ""}</span>
          </div>

          {phase === "done" && summary && (
            <div style={{ border: "1px solid var(--border)", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ color: "var(--bright)", fontWeight: 600 }}>Готово</div>
              <div className="mono" style={{ fontSize: 12 }}>{fmtDuration(summary.recorded_s)} → {fmtDuration(summary.edited_s)}</div>
              <div style={{ fontSize: 12 }}>Застосовано автоматично: <span className="mono">{applied}</span></div>
              <div style={{ fontSize: 12, color: summary.questions.length ? "var(--question)" : "var(--text2)" }}>Питань до вас: <span className="mono">{summary.questions.length}</span></div>
              <Link href="/edit/" className="btn primary big" style={{ display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none" }}>До редагування</Link>
            </div>
          )}
          {phase !== "done" && (
            <button className="btn primary big" disabled={!health || unique.length === 0 || !projectPath || phase === "running"} onClick={start}>
              {phase === "running" ? "Обробка…" : "Почати обробку"}
            </button>
          )}
        </section>

        <section style={{ padding: 14, display: "flex", flexDirection: "column", gap: 12 }}>
          <h2 className="section-title">Налаштування епізоду</h2>
          <label className="field"><span>Файл проєкту</span>
            <span style={{ display: "flex" }}>
              <input className="input mono" style={{ flex: "1 1 auto", minWidth: 0, fontSize: 11, borderRight: 0 }} value={projectPath} onChange={(e) => setProjectPath(e.target.value)} placeholder="…\episode.holos" />
              <button className="btn" aria-label="Вибрати, куди зберегти проєкт" onClick={async () => { const p = await pickProjectPath(projectPath || undefined); if (p) setProjectPath(p.endsWith(".holos") ? p : `${p}.holos`); }}>…</button>
            </span>
          </label>
          <label className="field"><span>Мова</span>
            <select className="select" value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="uk">Українська</option>
              <option value="en">English</option>
            </select>
          </label>
          <div className="field">
            <span>Словник термінів · {glossary.length}</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {glossary.map((t) => (
                <span key={t} className="chip">{t}<button aria-label={`Прибрати ${t}`} onClick={() => setGlossary(glossary.filter((g) => g !== t))}>×</button></span>
              ))}
            </div>
            <input className="input" value={term} placeholder="Додати термін і Enter (напр. ESP32)" onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && term.trim()) {
                  const add = term.split(",").map((s) => s.trim()).filter((s) => s && !glossary.includes(s));
                  setGlossary([...glossary, ...add]);
                  setTerm("");
                }
              }} />
          </div>
          <label className="field"><span>Ціль гучності</span>
            <select className="select" value={target} onChange={(e) => setTarget(Number(e.target.value))}>
              {TARGETS.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
            </select>
          </label>
          <fieldset style={{ border: "1px solid var(--border)", padding: "10px 12px", margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            <legend className="muted" style={{ fontSize: 12, padding: "0 4px" }}>Застосовувати автоматично</legend>
            {AUTO.map((a) => {
              const on = a.keys.every((k) => auto.includes(k));
              return (
                <label key={a.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <input type="checkbox" checked={on} style={{ width: 16, height: 16, accentColor: "#3FD17A" }}
                    onChange={() => setAuto(on ? auto.filter((k) => !a.keys.includes(k)) : [...auto, ...a.keys])} />
                  <span>{a.label}</span>
                </label>
              );
            })}
          </fieldset>
        </section>
      </aside>
    </div>
  );
}
