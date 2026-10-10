"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EngineBanner } from "@/components/Shell";
import { dirname, isDesktop, joinPath, pickFile, pickFolder, revealFile } from "@/lib/desktop";
import {
  currentProject,
  engine,
  fmtClock,
  fmtDuration,
  parseTimecode,
  type ExportResult,
  type Job,
  type Summary,
  type TemplateInfo,
  type TemplateParam,
} from "@/lib/engine";

type Row = { key: number; time: string; title: string; orig?: number };

const STAGES: Record<string, string> = {
  render: "Зведення й обробка",
  wav: "WAV",
  mp3: "MP3 з розділами",
  video: "Відео",
  mux: "Звук і розділи у відео",
  done: "Готово",
};

const FILE_LABEL: Record<string, string> = {
  wav: "WAV",
  mp3: "MP3",
  timecodes: "Таймкоди",
  video: "Відео",
  preview: "Перегляд відео",
};

let rowKey = 0;
const toRows = (s: Summary | null, hours: boolean): Row[] =>
  (s?.chapters ?? []).map((c) => ({ key: ++rowKey, time: fmtClock(c.time, hours), title: c.title, orig: c.time }));

export default function ExportPage() {
  const [path, setPath] = useState<string | null>(null);
  const [s, setS] = useState<Summary | null>(null);
  const [tpls, setTpls] = useState<TemplateInfo[]>([]);
  const [userDir, setUserDir] = useState("");
  const [err, setErr] = useState<string | null>(null);

  // export options
  const [wav, setWav] = useState(true);
  const [mp3, setMp3] = useState(true);
  const [txt, setTxt] = useState(true);
  const [embed, setEmbed] = useState(true);
  const [tplId, setTplId] = useState<string>("");
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [outDir, setOutDir] = useState("");

  // chapters editor
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  // job
  const [job, setJob] = useState<Job | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const stop = useRef<() => void>(() => {});

  const hours = (s?.edited_s ?? 0) >= 3600;
  const tpl = tpls.find((t) => t.id === tplId) ?? null;
  const running = job?.state === "running" || job?.state === "queued";

  const applySummary = useCallback((sum: Summary, first: boolean) => {
    setS(sum);
    if (first) {
      setWav(sum.export.wav);
      setMp3(sum.export.mp3);
      setTxt(sum.export.chapters_txt);
      setEmbed(sum.export.chapters_embed);
    }
  }, []);

  // initial load
  useEffect(() => {
    const p = currentProject.get();
    setPath(p);
    if (!p) return;
    setOutDir(joinPath(dirname(p), "export"));
    Promise.all([engine.summary(p), engine.templates(p)])
      .then(([sum, t]) => {
        applySummary(sum, true);
        setRows(toRows(sum, (sum.edited_s ?? 0) >= 3600));
        setTpls(t.templates);
        setUserDir(t.user_dir);
        const chosen = t.templates.find((x) => x.id === sum.export.video.template);
        if (chosen) {
          setTplId(chosen.id);
          setParams(chosen.initial);
        }
      })
      .catch((e) => setErr(String(e.message ?? e)));
    return () => stop.current();
  }, [applySummary]);

  // chapters written by Claude (MCP) show up without reloading, unless the user is editing
  useEffect(() => {
    if (!path || dirty) return;
    const id = window.setInterval(() => {
      engine
        .summary(path)
        .then((sum) => {
          applySummary(sum, false);
          setRows((old) => {
            const fresh = toRows(sum, (sum.edited_s ?? 0) >= 3600);
            const same = old.length === fresh.length && old.every((r, i) => r.time === fresh[i].time && r.title === fresh[i].title);
            return same ? old : fresh;
          });
        })
        .catch(() => {});
    }, 4000);
    return () => window.clearInterval(id);
  }, [path, dirty, applySummary]);

  const chooseTemplate = (id: string) => {
    setTplId(id);
    setParams(tpls.find((t) => t.id === id)?.initial ?? {});
  };

  // ---- chapters ---------------------------------------------------------------------------------
  const badRows = useMemo(() => rows.filter((r) => r.title.trim() && parseTimecode(r.time) === null).map((r) => r.key), [rows]);
  const edit = (key: number, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const addRow = () => {
    const last = rows.length ? parseTimecode(rows[rows.length - 1].time) ?? 0 : 0;
    setRows((rs) => [...rs, { key: ++rowKey, time: fmtClock(rs.length ? last + 60 : 0, hours), title: "" }]);
    setDirty(true);
  };
  const removeRow = (key: number) => {
    setRows((rs) => rs.filter((r) => r.key !== key));
    setDirty(true);
  };
  const saveChapters = async () => {
    if (!path || badRows.length) return;
    setSaving(true);
    try {
      const items = rows
        .filter((r) => r.title.trim())
        // an untouched time keeps its exact value (the field shows it rounded down to the second)
        .map((r) => ({
          time: r.orig !== undefined && r.time === fmtClock(r.orig, hours) ? r.orig : parseTimecode(r.time) ?? 0,
          title: r.title.trim(),
        }));
      const sum = await engine.setChapters(path, items);
      applySummary(sum, false);
      setRows(toRows(sum, hours));
      setDirty(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    setRows(toRows(s, hours));
    setDirty(false);
  };
  const youtubeText = (s?.chapters ?? []).map((c) => `${fmtClock(c.time, hours)} ${c.title}`).join("\n");
  const copyTimecodes = async () => {
    try {
      await navigator.clipboard.writeText(youtubeText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  // ---- export -----------------------------------------------------------------------------------
  const missingRequired = tpl?.params.filter((p) => p.required && (params[p.key] === undefined || params[p.key] === null || params[p.key] === "")) ?? [];
  const nothing = !wav && !mp3 && !txt && !tpl;
  const blocker =
    (tpl && !tpl.ready && `Шаблон «${tpl.name}» потребує: ${tpl.missing.join(", ")}`) ||
    (missingRequired.length > 0 && `Заповніть: ${missingRequired.map((p) => p.label).join(", ")}`) ||
    (dirty && "Збережіть або скасуйте зміни в розділах") ||
    (nothing && "Нічого не вибрано") ||
    null;

  const start = async (preview: number) => {
    if (!path) return;
    setErr(null);
    setResult(null);
    try {
      const j = await engine.exportProject({
        path,
        out_dir: outDir || null,
        wav,
        mp3,
        chapters_txt: txt,
        chapters_embed: embed,
        video: { template: tpl ? tpl.id : null, params: tpl ? params : {} },
        preview,
      });
      setJob(j);
      stop.current = engine.watch(j.id, (u) => {
        setJob(u);
        if (u.state === "done") setResult(u.result as ExportResult);
        if (u.state === "error") setErr(u.error);
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  if (!path) {
    return (
      <div className="main" style={{ padding: 20 }}>
        <div className="banner">
          Проєкт не відкрито. <Link href="/import/">Почніть з імпорту</Link>.
        </div>
      </div>
    );
  }

  const m = result?.measured;
  const checks: { label: string; v: string; ok: boolean }[] = [
    { label: "Тривалість", v: fmtDuration(result?.duration_s ?? s?.edited_s), ok: true },
    { label: "Гучність (ціль)", v: s?.settings.target_lufs != null ? `${s.settings.target_lufs} LUFS` : "—", ok: true },
    ...(m
      ? [
          { label: "Гучність (виміряно)", v: `${m.integrated_lufs?.toFixed(1)} LUFS`, ok: true },
          { label: "True peak", v: `${m.true_peak_dbtp?.toFixed(1)} dBTP`, ok: (m.true_peak_dbtp ?? 0) <= -1 },
        ]
      : []),
    { label: "Питань без відповіді", v: String(s?.questions.length ?? "—"), ok: (s?.questions.length ?? 0) === 0 },
    { label: "Розділів", v: String(s?.chapters.length ?? 0), ok: (s?.chapter_warnings.length ?? 0) === 0 },
  ];

  return (
    <div className="main">
      {/* ---- column 1: what to make ---- */}
      <section style={{ flex: "1 1 340px", minWidth: 0, padding: "18px 20px", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 16 }}>
        <EngineBanner />
        <h2 className="section-title">Аудіо</h2>
        <div style={{ display: "flex", flexDirection: "column", border: "1px solid var(--border)" }}>
          <Option on={wav} set={setWav} name="WAV" sub={`${s?.export.wav_bits ?? 24}-bit · ${(s?.sample_rate ?? 48000) / 1000} kHz · стерео — майстер`} />
          <Option on={mp3} set={setMp3} name="MP3" sub={`${s?.export.mp3_kbps ?? 192} kbps · для публікації`} last />
        </div>

        <h2 className="section-title">Таймкоди</h2>
        <div style={{ display: "flex", flexDirection: "column", border: "1px solid var(--border)" }}>
          <Option on={txt} set={setTxt} name="Файл таймкодів для YouTube" sub="00:00 Назва — вставити в опис відео" />
          <Option on={embed} set={setEmbed} name="Розділи всередині MP3 і MP4" sub="плеєри й подкаст-застосунки показують їх самі" last />
        </div>

        <h2 className="section-title">Відео</h2>
        <label className="field">
          <span>Шаблон</span>
          <select className="select" value={tplId} onChange={(e) => chooseTemplate(e.target.value)} disabled={running}>
            <option value="">Без відео</option>
            {tpls.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.ready ? "" : " — потрібні модулі"}
              </option>
            ))}
          </select>
        </label>
        {tpl && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, borderLeft: "2px solid var(--core)", paddingLeft: 12 }}>
            {tpl.description && <div className="muted" style={{ lineHeight: 1.5 }}>{tpl.description}</div>}
            {!tpl.ready && (
              <div className="banner error">
                Бракує модулів Python: <span className="mono">{tpl.missing.join(", ")}</span>
                {tpl.install && (
                  <>
                    . Встановіть: <span className="mono">{tpl.install}</span> і перезапустіть рушій.
                  </>
                )}
              </div>
            )}
            {tpl.params.map((p) => (
              <ParamField key={p.key} p={p} value={params[p.key]} disabled={running} onChange={(v) => setParams((o) => ({ ...o, [p.key]: v }))} />
            ))}
          </div>
        )}
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
          Свої шаблони кладіть у <span className="mono">{userDir || "Documents\\Holos Studio\\templates"}</span>
        </div>
      </section>

      {/* ---- column 2: chapters ---- */}
      <section style={{ flex: "1 1 400px", minWidth: 0, padding: "18px 20px", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <h2 className="section-title">Розділи</h2>
          <span className="muted" style={{ fontSize: 12 }}>час у готовому епізоді</span>
        </div>
        <div className="panel" style={{ border: "1px solid var(--border)", padding: "10px 12px", lineHeight: 1.55, color: "var(--text2)" }}>
          Попросіть Claude: <span style={{ color: "var(--bright)" }}>«Зроби розділи для {s?.name ?? "цього епізоду"}»</span>. Він прочитає
          транскрипт і запише розділи сюди — вони з’являться самі. Далі можна поправити назви й час.
        </div>

        <ol style={{ listStyle: "none", margin: 0, padding: 0, border: "1px solid var(--border)" }} aria-label="Розділи">
          {rows.length === 0 && <li className="muted" style={{ padding: "10px 12px" }}>Розділів ще немає.</li>}
          {rows.map((r, i) => {
            const bad = badRows.includes(r.key);
            return (
              <li key={r.key} style={{ display: "flex", gap: 0, borderBottom: "1px solid #1c1f1c", alignItems: "stretch" }}>
                <input
                  aria-label={`Час розділу ${i + 1}`}
                  className="input mono"
                  value={i === 0 ? fmtClock(0, hours) : r.time}
                  disabled={i === 0 || running}
                  title={i === 0 ? "Перший розділ завжди починається з 00:00" : "ХХ:СС"}
                  onChange={(e) => edit(r.key, { time: e.target.value })}
                  style={{ width: 84, border: 0, borderRight: "1px solid var(--border)", background: "transparent", color: bad ? "var(--cut)" : "var(--core)" }}
                />
                <input
                  aria-label={`Назва розділу ${i + 1}`}
                  className="input"
                  value={r.title}
                  disabled={running}
                  placeholder="Назва"
                  onChange={(e) => edit(r.key, { title: e.target.value })}
                  style={{ flex: "1 1 auto", minWidth: 0, border: 0, background: "transparent" }}
                />
                <button className="btn" aria-label={`Видалити розділ ${i + 1}`} title="Видалити" disabled={running} onClick={() => removeRow(r.key)} style={{ height: 34, border: 0, background: "transparent", color: "var(--muted)" }}>
                  ×
                </button>
              </li>
            );
          })}
        </ol>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="btn" onClick={addRow} disabled={running}>+ Розділ</button>
          {dirty && (
            <>
              <button className="btn primary" onClick={saveChapters} disabled={saving || badRows.length > 0}>
                {saving ? "Зберігаю…" : "Зберегти розділи"}
              </button>
              <button className="btn" onClick={discard}>Скасувати</button>
            </>
          )}
        </div>
        {badRows.length > 0 && <div style={{ color: "var(--cut-text)", fontSize: 12 }}>Час у форматі ХХ:СС, наприклад 02:35</div>}
        {!dirty && (s?.chapter_warnings.length ?? 0) > 0 && (
          <div className="banner" style={{ fontSize: 12, lineHeight: 1.5 }}>
            {s!.chapter_warnings.map((w) => (
              <div key={w}>{translateWarning(w)}</div>
            ))}
          </div>
        )}
        {!dirty && youtubeText && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className="muted" style={{ fontSize: 12 }}>Для опису на YouTube</span>
              <button className="btn" style={{ height: 28, fontSize: 12 }} onClick={copyTimecodes}>{copied ? "Скопійовано" : "Копіювати"}</button>
            </div>
            <pre className="mono" style={{ margin: 0, padding: 10, background: "var(--lane)", border: "1px solid var(--border)", fontSize: 12, whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{youtubeText}</pre>
          </>
        )}
      </section>

      {/* ---- column 3: check & run ---- */}
      <aside className="panel" style={{ flex: "0 1 340px", minWidth: 290, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 className="section-title">Перевірка</h2>
        <table className="table">
          <tbody>
            {checks.map((k) => (
              <tr key={k.label}>
                <td style={{ paddingLeft: 0, color: "var(--text2)" }}>{k.label}</td>
                <td className="mono" style={{ textAlign: "right", color: "var(--bright)" }}>{k.v}</td>
                <td style={{ width: 18, paddingRight: 0, textAlign: "right", color: k.ok ? "var(--core)" : "var(--question)" }} aria-label={k.ok ? "в нормі" : "увага"}>
                  {k.ok ? "✓" : "!"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <label className="field">
          <span>Папка</span>
          <span style={{ display: "flex" }}>
            <input className="input mono" style={{ flex: "1 1 auto", minWidth: 0, fontSize: 11, borderRight: 0 }} value={outDir} onChange={(e) => setOutDir(e.target.value)} disabled={running} />
            {isDesktop() && (
              <button className="btn" style={{ height: 34 }} aria-label="Вибрати папку" disabled={running} onClick={async () => { const d = await pickFolder(outDir); if (d) setOutDir(d); }}>
                …
              </button>
            )}
          </span>
        </label>

        {blocker && <div className="muted" style={{ fontSize: 12 }}>{blocker}</div>}
        <button className="btn primary" style={{ height: 52, fontSize: 15 }} disabled={running || !!blocker} onClick={() => start(0)}>
          {running ? "Експортую…" : "Експортувати"}
        </button>
        {tpl?.preview && (
          <button className="btn" disabled={running || !!blocker} onClick={() => start(15)} title="Рендер лише перших 15 секунд відео">
            Перегляд відео · 15 с
          </button>
        )}

        {job && running && <Progress job={job} />}
        {err && <div className="banner error" role="alert" style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{err}</div>}

        {result && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h2 className="section-title">{result.preview ? "Перегляд готовий" : `Готово за ${fmtDuration(result.seconds)}`}</h2>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, border: "1px solid var(--border)" }}>
              {Object.entries(result.files).map(([k, f]) => (
                <li key={k} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 10px", borderBottom: "1px solid #1c1f1c" }}>
                  <span style={{ minWidth: 72, color: "var(--text2)" }}>{FILE_LABEL[k] ?? k}</span>
                  <span className="mono" style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11 }} title={f}>
                    {f.split(/[\\/]/).pop()}
                  </span>
                  {isDesktop() && (
                    <button className="btn" style={{ height: 26, fontSize: 11, padding: "0 8px" }} onClick={() => revealFile(f).catch((e) => setErr(String(e)))}>
                      Показати
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {!isDesktop() && <div className="mono muted" style={{ fontSize: 11 }}>{result.out_dir}</div>}
          </div>
        )}
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.5, marginTop: "auto" }}>
          Після рендеру гучність і піки вимірюються ще раз. Звіт зберігається поруч із файлами.
        </div>
      </aside>
    </div>
  );
}

function Option({ on, set, name, sub, last }: { on: boolean; set: (v: boolean) => void; name: string; sub: string; last?: boolean }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderBottom: last ? 0 : "1px solid var(--border)", background: on ? "var(--panel)" : "transparent", cursor: "pointer" }}>
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} style={{ width: 16, height: 16, accentColor: "var(--core)" }} />
      <span>
        <span style={{ color: "var(--bright)", fontWeight: 500 }}>{name}</span>
        <br />
        <span className="muted" style={{ fontSize: 12 }}>{sub}</span>
      </span>
    </label>
  );
}

function ParamField({ p, value, onChange, disabled }: { p: TemplateParam; value: unknown; onChange: (v: unknown) => void; disabled: boolean }) {
  const label = (
    <span>
      {p.label}
      {p.required && <span style={{ color: "var(--question)" }}> *</span>}
    </span>
  );
  const help = p.help ? <span className="muted" style={{ fontSize: 11 }}>{p.help}</span> : null;
  if (p.type === "bool") {
    return (
      <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input type="checkbox" checked={!!value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} style={{ width: 16, height: 16, accentColor: "var(--core)" }} />
        {p.label}
      </label>
    );
  }
  if (p.type === "choice") {
    return (
      <div className="field">
        {label}
        <div role="radiogroup" aria-label={p.label} style={{ display: "grid", gridTemplateColumns: `repeat(${p.options.length}, minmax(0, 1fr))`, border: "1px solid var(--border)" }}>
          {p.options.map((o, i) => {
            const sel = String(value ?? p.default) === o.value;
            return (
              <button
                key={o.value}
                role="radio"
                aria-checked={sel}
                disabled={disabled}
                onClick={() => onChange(o.value)}
                style={{ minHeight: 40, padding: "6px 8px", border: 0, borderLeft: i ? "1px solid var(--border)" : 0, background: sel ? "var(--sel-row)" : "var(--panel)", color: sel ? "var(--bright)" : "var(--text2)", boxShadow: sel ? "inset 0 -2px 0 var(--core)" : "none" }}
              >
                {o.label || o.value}
              </button>
            );
          })}
        </div>
        {help}
      </div>
    );
  }
  if (p.type === "file") {
    const v = (value as string) ?? "";
    return (
      <div className="field">
        {label}
        <span style={{ display: "flex" }}>
          <input className="input mono" style={{ flex: "1 1 auto", minWidth: 0, fontSize: 11, borderRight: isDesktop() ? 0 : undefined }} value={v} disabled={disabled} placeholder="Шлях до файлу" onChange={(e) => onChange(e.target.value)} />
          {isDesktop() && (
            <button className="btn" style={{ height: 34 }} aria-label={`Вибрати: ${p.label}`} disabled={disabled} onClick={async () => { const f = await pickFile(p.filters, v || undefined); if (f) onChange(f); }}>
              …
            </button>
          )}
        </span>
        {help}
      </div>
    );
  }
  if (p.type === "int" || p.type === "float") {
    const slider = p.type === "float" && p.min != null && p.max != null;
    const num = value === null || value === undefined || value === "" ? "" : String(value);
    const set = (raw: string) => onChange(raw === "" ? null : p.type === "int" ? parseInt(raw, 10) : parseFloat(raw));
    return (
      <div className="field">
        {label}
        <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {slider && (
            <input type="range" aria-label={p.label} min={p.min!} max={p.max!} step={p.step ?? 0.01} value={num || String(p.default ?? p.min)} disabled={disabled} onChange={(e) => set(e.target.value)} style={{ flex: "1 1 auto", accentColor: "var(--core)" }} />
          )}
          <input className="input mono" type="number" min={p.min ?? undefined} max={p.max ?? undefined} step={p.step ?? (p.type === "int" ? 1 : 0.01)} value={num} disabled={disabled} onChange={(e) => set(e.target.value)} style={{ width: slider ? 80 : 120 }} />
        </span>
        {help}
      </div>
    );
  }
  return (
    <label className="field">
      {label}
      <input className="input" value={(value as string) ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      {help}
    </label>
  );
}

function Progress({ job }: { job: Job }) {
  const pct = job.total > 0 && job.done > 0 ? Math.min(100, (100 * job.done) / job.total) : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }} aria-live="polite">
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
        <span>{STAGES[job.stage] ?? job.stage ?? "Черга"}</span>
        <span className="mono muted">
          {job.stage === "video" && job.total > 0 && job.done > 0 ? `${fmtClock(job.done)} / ${fmtClock(job.total)} · ` : ""}
          {fmtClock(job.elapsed)}
        </span>
      </div>
      <div className="bar">
        <i style={{ width: pct === null ? "100%" : `${pct}%`, opacity: pct === null ? 0.35 : 1 }} />
      </div>
      {job.detail && job.stage === "render" && <span className="mono muted" style={{ fontSize: 11 }}>{job.detail}</span>}
    </div>
  );
}

function translateWarning(w: string): string {
  const few = w.match(/at least (\d+)$/);
  if (few) return `YouTube показує розділи, лише коли їх щонайменше ${few[1]}.`;
  const short = w.match(/^chapter '(.*)' is shorter than (\d+) s$/);
  if (short) return `Розділ «${short[1]}» коротший за ${short[2]} с — YouTube його не покаже.`;
  return w;
}
