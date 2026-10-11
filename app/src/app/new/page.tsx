"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EngineBanner, useEngine } from "@/components/Shell";
import { isDesktop, joinPath, onFilesDropped, pickAudioFiles } from "@/lib/desktop";
import { currentProject, engine, fmtDuration, type Automation, type FileInfo, type Job } from "@/lib/engine";
import { t, useLang } from "@/lib/i18n";
import { JOB_KEY, NEW_FILES_KEY, recall, remember, take } from "@/lib/session";

const ORDER = ["copy", "analyze", "transcribe", "suggest", "view"];

function steps(): { key: string; title: string; sub: string }[] {
  return [
    { key: "copy", title: t("Copy into project"), sub: t("recordings, ordered by file name") },
    { key: "analyze", title: t("Sound analysis"), sub: t("pauses, breaths, mouth clicks, drop-outs") },
    { key: "transcribe", title: t("Speech recognition"), sub: t("on the GPU · for retakes and timecodes") },
    { key: "suggest", title: t("Retakes and repeats"), sub: t("phrases re-recorded across and within files") },
    { key: "view", title: t("Preparing the editor"), sub: t("waveform, spectrum, loudness") },
  ];
}

// Speech recognition languages — always shown by their own name.
const ASR_LANGS = [["uk", "Українська"], ["en", "English"], ["pl", "Polski"], ["de", "Deutsch"], ["ru", "Русский"]];

/** "Electronics weekly — episode 2" → "… episode 3". The name becomes a folder name, so the default stays English. */
function nextName(prev: string | undefined): string {
  if (!prev) return "New episode";
  const m = prev.match(/^(.*?)(\d+)(\D*)$/);
  return m ? `${m[1]}${Number(m[2]) + 1}${m[3]}` : `${prev} (new)`;
}

/** [label, value, active] for the automation summary. */
function autoLines(a: Automation | null): [string, string, boolean][] {
  if (!a) return [];
  const cut = (k: string) => a.kinds[k] === "cut";
  const pol = (k: string) => (cut(k) ? t("cut") : t("off"));
  const clicks = { off: t("off"), light: t("light"), normal: t("normal"), strong: t("strong") }[a.clicks];
  return [
    [t("Pauses"), a.pauses ? t("longer than {max} s → {target} s", { max: a.pause_max, target: a.pause_target }) : t("off"), a.pauses],
    [t("Mouth clicks"), clicks, a.clicks !== "off"],
    [t("Breaths"), a.breaths === "off" ? t("off") : a.breaths === "cut" ? t("remove") : t("lower by {db} dB", { db: a.breath_db }), a.breaths !== "off"],
    [t("Repeats and retakes"), cut("repeat") === cut("retake") ? pol("repeat") : `${pol("repeat")} / ${pol("retake")}`, cut("repeat") || cut("retake")],
    [t("Fillers (um, uh)"), pol("filler"), cut("filler")],
    [t("Unclear speech"), pol("unclear"), cut("unclear")],
  ];
}

export default function NewProjectPage() {
  const router = useRouter();
  const uiLang = useLang();
  const { health } = useEngine();
  const [files, setFiles] = useState<FileInfo[]>([]);
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const [auto, setAuto] = useState<Automation | null>(null);
  const [lang, setLang] = useState("uk");
  const [glossary, setGlossary] = useState<string[]>([]);
  const [term, setTerm] = useState("");
  const [paste, setPaste] = useState("");
  const [hover, setHover] = useState(false);
  const [job, setJob] = useState<Job | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const addFiles = useCallback(async (paths: string[]) => {
    if (!paths.length) return;
    setErr(null);
    try {
      const known = new Set(files.map((f) => f.path));
      const info = await engine.inspect([...files.map((f) => f.path), ...paths.filter((p) => !known.has(p))]);
      setFiles(info);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [files]);

  const watch = useCallback((id: string, fallbackName: string) => {
    engine.watch(id, (u) => {
      setJob(u);
      if (u.state === "done") {
        const res = u.result as { path: string };
        remember(JOB_KEY, null);
        currentProject.set(res.path, fallbackName);
        router.push("/edit/");
      } else if (u.state === "error") {
        setErr(u.error);
      }
    });
  }, [router]);

  useEffect(() => {
    if (!health) return;
    setLang(recall("holos.language", "uk"));
    setGlossary(recall<string[]>("holos.glossary", []));
    engine.automationDefaults().then(setAuto).catch(() => {});
    engine.projects().then((r) => {
      setRoot(r.root);
      setName((n) => n || nextName(r.projects[0]?.name));
    }).catch(() => {});
    const running = recall<{ id: string; name: string } | null>(JOB_KEY, null);
    if (running && new URLSearchParams(window.location.search).get("watch")) {
      engine.job(running.id).then((j) => { setJob(j); setName(running.name); watch(running.id, running.name); }).catch(() => {});
    }
    const pending = take<string[]>(NEW_FILES_KEY);
    if (pending?.length) addFiles(pending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(health)]);

  useEffect(() => {
    let off = () => {};
    onFilesDropped((p) => addFiles(p), setHover).then((u) => (off = u));
    return () => off();
  }, [addFiles]);

  const unique = files.filter((f) => !f.duplicate_of);
  const recorded = unique.reduce((a, f) => a + f.duration, 0);
  const fmt = unique[0] ? `${unique[0].sr / 1000}k · ${unique[0].channels > 1 ? t("stereo") : t("mono")}` : "—";
  const running = job && (job.state === "running" || job.state === "queued");

  const start = async () => {
    setErr(null);
    setBusy(true);
    remember("holos.language", lang);
    remember("holos.glossary", glossary);
    try {
      const j = await engine.newEpisode({ name: name.trim() || "New episode", files: unique.map((f) => f.path), language: lang, glossary });
      remember(JOB_KEY, { id: j.id, name: name.trim() });
      setJob(j);
      watch(j.id, name.trim());
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const STEPS = steps();
  const stage = job?.stage || "copy";
  const curIdx = ORDER.indexOf(stage);
  const stepState = (k: string): "done" | "now" | "wait" => {
    if (!job) return "wait";
    if (job.state === "done") return "done";
    const i = ORDER.indexOf(k);
    if (i < curIdx) return "done";
    if (i === curIdx) return job.stage === "transcribe" && job.total === 0 && job.detail.startsWith("skipped") ? "done" : "now";
    return "wait";
  };
  const overall = !job ? 0 : job.state === "done" ? 100
    : Math.round(((Math.max(0, curIdx) + (job.total ? Math.min(1, Math.max(0, job.done) / job.total) : 0)) / STEPS.length) * 100);

  const fileState = (i: number) => {
    if (!job) return { text: t("ready to process"), pct: 0, now: false };
    if (job.state === "done") return { text: "✓", pct: 100, now: false };
    const perFile = stage === "analyze" || stage === "transcribe" || stage === "suggest" || stage === "view";
    if (!perFile) return { text: stage === "copy" ? t("copying…") : t("queued"), pct: stage === "copy" ? job.done : 0, now: stage === "copy" };
    const base = (Math.max(0, curIdx - 1) / (STEPS.length - 1)) * 100;
    const words: Record<string, [string, string]> = {
      analyze: [t("analyzed"), t("analyzing…")],
      transcribe: [t("transcribed"), t("transcribing…")],
      suggest: [t("checked"), t("searching…")],
      view: [t("done"), t("waveform and spectrum…")],
    };
    if (i < job.done) return { text: words[stage][0], pct: base + 25, now: false };
    if (i === job.done) return { text: words[stage][1], pct: base + 12, now: true };
    return { text: t("queued"), pct: base, now: false };
  };

  const lines = useMemo(() => autoLines(auto), [auto, uiLang]);

  return (
    <div className="main">
      <section aria-label={t("Episode and files")} style={{ flex: "999 1 640px", minWidth: 0, padding: "22px 24px", display: "flex", flexDirection: "column", gap: 16 }}>
        <EngineBanner />
        {err && <div className="banner error" role="alert" style={{ whiteSpace: "pre-wrap" }}>{err}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 14 }}>
          <label className="field"><span>{t("Episode name")}</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} disabled={Boolean(running)} style={{ height: 38, fontSize: 14, color: "var(--bright)" }} />
          </label>
          <label className="field"><span>{t("Project folder (recordings are copied here)")}</span>
            <input className="input mono" readOnly value={root ? joinPath(root, name.trim() || "…") : "…"} style={{ height: 38, fontSize: 11, color: "var(--text2)" }} />
          </label>
        </div>

        <div className="card" style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
          {[[t("Files"), String(unique.length)], [t("Recorded"), fmtDuration(recorded)], [t("Format"), fmt], [t("Duplicates"), String(files.length - unique.length)]].map(([k, v], i) => (
            <div key={k} style={{ padding: "10px 14px", borderLeft: i ? "1px solid var(--border)" : 0 }}>
              <div className="muted" style={{ fontSize: 11 }}>{k}</div>
              <div className="mono" style={{ fontSize: 20, color: "var(--bright)" }}>{v}</div>
            </div>
          ))}
        </div>

        {files.length === 0 ? (
          <div style={{ flex: "1 1 auto", minHeight: 260, border: `1px dashed ${hover ? "var(--core)" : "var(--dim)"}`, background: hover ? "#0f2016" : "var(--lane)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 20 }}>
            <div style={{ fontSize: 15, fontWeight: 500 }}>{t("Drag recordings here")}</div>
            {isDesktop() ? (
              <button className="btn" onClick={async () => addFiles(await pickAudioFiles())}>{t("Choose files…")}</button>
            ) : (
              <div style={{ width: "100%", maxWidth: 640, display: "flex", flexDirection: "column", gap: 8 }}>
                <textarea className="input mono" rows={4} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={t("File paths, one per line")} style={{ height: "auto", padding: 8, fontSize: 11 }} />
                <button className="btn" onClick={() => addFiles(paste.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))}>{t("Add")}</button>
              </div>
            )}
          </div>
        ) : (
          <div style={{ border: "1px solid var(--border)", overflow: "auto", flex: "1 1 auto", maxHeight: "calc(100vh - 290px)" }}>
            <table className="table">
              <thead><tr><th style={{ width: 36 }}>#</th><th>{t("File")}</th><th>{t("Duration")}</th><th style={{ width: "46%" }}>{t("Status")}</th></tr></thead>
              <tbody>
                {unique.map((f, i) => {
                  const st = fileState(i);
                  return (
                    <tr key={f.path}>
                      <td className="mono muted">{i + 1}</td>
                      <td className="mono">{f.name}</td>
                      <td className="mono" style={{ color: "var(--text2)" }}>{fmtDuration(f.duration)}</td>
                      <td>
                        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span className="bar" style={{ flex: "1 1 auto", height: 4 }}><i style={{ width: `${st.pct}%`, opacity: st.pct ? 1 : 0.35 }} /></span>
                          <span className="mono" style={{ flex: "0 0 120px", textAlign: "right", fontSize: 11, color: st.now ? "var(--bright)" : "var(--text2)" }}>{st.text}</span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
                {files.filter((f) => f.duplicate_of).map((f) => (
                  <tr key={f.path}><td /><td className="mono muted">{f.name}</td><td /><td className="muted" style={{ fontSize: 12 }}>{t("duplicate of {name} — skipped", { name: f.duplicate_of ?? "" })}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {files.length > 0 && !running && isDesktop() && (
          <button className="btn" style={{ alignSelf: "flex-start" }} onClick={async () => addFiles(await pickAudioFiles())}>+ {t("Add files")}</button>
        )}
      </section>

      <aside aria-label={t("Processing")} className="panel" style={{ flex: "0 1 380px", minWidth: 320, borderLeft: "1px solid var(--border)", padding: "22px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
        <h2 className="section-title">{t("Automatic processing")}</h2>
        <ol style={{ listStyle: "none", margin: 0, padding: 0, border: "1px solid var(--border)" }}>
          {STEPS.map((s, i) => {
            const st = stepState(s.key);
            return (
              <li key={s.key} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderBottom: "1px solid #1c1f1c", background: st === "now" ? "var(--sel-row)" : "transparent", boxShadow: st === "now" ? "inset 2px 0 0 var(--core)" : "none" }}>
                <span style={{ flex: "0 0 22px", height: 22, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, border: `1px solid ${st === "done" ? "var(--core)" : st === "now" ? "var(--bright)" : "var(--dim)"}`, background: st === "done" ? "var(--core)" : "transparent", color: st === "done" ? "var(--bg)" : st === "now" ? "var(--bright)" : "var(--dim)" }}>
                  {st === "done" ? "✓" : i + 1}
                </span>
                <span style={{ flex: "1 1 auto", display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontWeight: 500, color: st === "wait" ? "var(--muted)" : "var(--bright)" }}>{s.title}</span>
                  <span className="muted" style={{ fontSize: 11.5 }}>{s.sub}</span>
                </span>
                <span className="mono" style={{ fontSize: 11, color: "var(--text2)" }}>
                  {st === "now" && job && job.total > 0 ? (s.key === "copy" ? `${job.done}%` : `${job.done} / ${job.total}`) : ""}
                </span>
              </li>
            );
          })}
        </ol>
        <div className="bar"><i style={{ width: `${overall}%` }} /></div>
        <div className="mono muted" style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
          <span>{t("overall {n}%", { n: overall })}</span><span>{job ? t("{n} s", { n: Math.round(job.elapsed) }) : ""}</span>
        </div>

        <div className="card" style={{ background: "transparent", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "baseline" }}>
            <span style={{ fontWeight: 500 }}>{t("Automation")}</span>
            <Link href="/automation/?scope=defaults" style={{ marginLeft: "auto", fontSize: 12, color: "var(--core)" }}>{t("change")}</Link>
          </div>
          {lines.map(([k, v, on]) => (
            <div key={k} style={{ display: "flex", gap: 8, fontSize: 12 }}>
              <span style={{ color: on ? "var(--core)" : "var(--dim)" }}>{on ? "✓" : "–"}</span>
              <span style={{ flex: "1 1 auto", color: "var(--text2)" }}>{k}</span>
              <span className="mono">{v}</span>
            </div>
          ))}
        </div>

        <details className="card" style={{ background: "transparent", padding: "10px 12px" }}>
          <summary style={{ cursor: "pointer", fontWeight: 500 }}>{t("Speech recognition")}</summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
            <label className="field"><span>{t("Language")}</span>
              <select className="select" value={lang} onChange={(e) => setLang(e.target.value)}>
                {ASR_LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="field"><span>{t("Glossary · {n}", { n: glossary.length })}</span>
              <input className="input" value={term} placeholder={t("Add a term and press Enter (e.g. ESP32)")} onChange={(e) => setTerm(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && term.trim()) { setGlossary((g) => [...new Set([...g, term.trim()])]); setTerm(""); } }} />
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {glossary.map((g) => (
                <span key={g} className="chip">{g}<button aria-label={t("Remove {term}", { term: g })} onClick={() => setGlossary((x) => x.filter((y) => y !== g))}>×</button></span>
              ))}
            </div>
          </div>
        </details>

        <button className="btn primary" style={{ height: 52, fontSize: 15, marginTop: "auto" }} disabled={!health || !unique.length || Boolean(running) || busy} onClick={start}>
          {running ? t("Processing…") : t("Create and process")}
        </button>
        <p className="muted" style={{ margin: 0, fontSize: 12, lineHeight: 1.6 }}>{t("The editor opens as soon as processing is done.")}</p>
      </aside>
    </div>
  );
}
