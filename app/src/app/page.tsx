"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { EngineBanner, useEngine } from "@/components/Shell";
import { isDesktop, onFilesDropped, pickAudioFiles, pickFile, pickFolder, revealFile } from "@/lib/desktop";
import { currentProject, engine, fmtDuration, type ProjectRow } from "@/lib/engine";
import { t, locale, useLang } from "@/lib/i18n";
import { NEW_FILES_KEY, stash } from "@/lib/session";

function startNew(router: ReturnType<typeof useRouter>, files: string[]) {
  stash(NEW_FILES_KEY, files);
  router.push("/new/");
}

const STATUS: Record<ProjectRow["status"], { color: string; bg: string; border: string }> = {
  processing: { color: "var(--text2)", bg: "var(--raised)", border: "var(--border)" },
  ready: { color: "var(--core)", bg: "#0f2016", border: "#1f4a2c" },
  exported: { color: "var(--text2)", bg: "var(--raised)", border: "var(--border)" },
  new: { color: "var(--question)", bg: "var(--q-bg)", border: "var(--q-border)" },
};

function statusLabel(s: ProjectRow["status"]): string {
  switch (s) {
    case "processing":
      return t("processing…");
    case "ready":
      return t("ready to export");
    case "exported":
      return t("exported");
    default:
      return t("not processed");
  }
}

function Thumb({ v }: { v: number[] }) {
  if (!v.length) return <span style={{ display: "block", width: 180, height: 40, background: "var(--lane)", border: "1px solid #1c1f1c" }} />;
  const n = v.length;
  const top = v.map((x, i) => `${(i / (n - 1)) * 180},${20 - (x / 100) * 18}`).join(" L");
  const bot = v.map((x, i) => `${((n - 1 - i) / (n - 1)) * 180},${20 + (v[n - 1 - i] / 100) * 18}`).join(" L");
  return (
    <svg width="180" height="40" viewBox="0 0 180 40" aria-hidden="true" style={{ display: "block", flex: "0 0 180px", background: "var(--lane)", border: "1px solid #1c1f1c" }}>
      <path d={`M${top} L${bot} Z`} fill="var(--wave)" />
    </svg>
  );
}

export default function StartPage() {
  const router = useRouter();
  useLang();
  const { health } = useEngine();
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [root, setRoot] = useState("");
  const [q, setQ] = useState("");
  const [hover, setHover] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = () =>
    engine.projects().then((r) => {
      setRows(r.projects);
      setRoot(r.root);
    }).catch((e) => setErr(String(e.message ?? e)));

  useEffect(() => {
    if (health) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(health)]);

  useEffect(() => {
    let off = () => {};
    onFilesDropped((paths) => paths.length && startNew(router, paths), setHover).then((u) => (off = u));
    return () => off();
  }, [router]);

  const open = (r: ProjectRow) => {
    currentProject.set(r.path, r.name);
    router.push(r.status === "processing" ? "/new/?watch=1" : "/edit/");
  };

  const shown = useMemo(() => (rows ?? []).filter((r) => r.name.toLowerCase().includes(q.toLowerCase())), [rows, q]);

  return (
    <div className="main" style={{ alignItems: "stretch" }}>
      <section aria-labelledby="new-h" style={{ flex: "1 1 420px", maxWidth: 520, minWidth: 0, padding: "40px 36px", display: "flex", flexDirection: "column", gap: 18, borderRight: "1px solid var(--border)" }}>
        <h1 id="new-h" style={{ margin: 0, fontSize: 26, fontWeight: 600 }}>{t("New episode")}</h1>
        <p style={{ margin: 0, color: "var(--text2)", lineHeight: 1.6 }}>
          {t("Drag in your recordings — the app copies them into a project, joins them in order, cleans out pauses, breaths and clicks, and opens the editor.")}
        </p>
        <div style={{ height: 260, border: `1px dashed ${hover ? "var(--core)" : "var(--dim)"}`, background: hover ? "#0f2016" : "var(--lane)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14 }}>
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="var(--core)" strokeWidth="1.6" aria-hidden="true"><path d="M12 16V4" /><path d="M7 9l5-5 5 5" /><path d="M4 15v5h16v-5" /></svg>
          <div style={{ fontSize: 15, fontWeight: 500 }}>{hover ? t("Release to create a project") : t("Drag recordings here")}</div>
          <div className="muted" style={{ fontSize: 12 }}>{t("WAV · FLAC · MP3 · M4A — one or more files of one episode")}</div>
        </div>
        <button className="btn primary" style={{ height: 52, fontSize: 15 }} disabled={!health}
          onClick={async () => {
            if (!isDesktop()) return router.push("/new/");
            const f = await pickAudioFiles();
            if (f.length) startNew(router, f);
          }}>{t("New project…")}</button>
        <button className="btn" style={{ height: 40 }} disabled={!health}
          onClick={async () => {
            const f = await pickFile(["holos"]);
            if (f) {
              try {
                const s = await engine.open(f);
                currentProject.set(f, s.name);
                router.push("/edit/");
              } catch (e) {
                setErr(e instanceof Error ? e.message : String(e));
              }
            }
          }}>{t("Open a project from another folder…")}</button>
        <div className="muted" style={{ marginTop: "auto", fontSize: 12, lineHeight: 1.6 }}>
          {t("Projects are stored in")}<br />
          <span className="mono" style={{ color: "var(--text2)" }}>{root || "…"}</span>
          {isDesktop() && (
            <> · <button style={{ border: 0, background: "none", color: "var(--core)", padding: 0, textDecoration: "underline" }}
              onClick={async () => { const d = await pickFolder(root); if (d) { await engine.saveSettings({ projects_dir: d }); reload(); } }}>{t("change")}</button></>
          )}
        </div>
      </section>

      <section aria-labelledby="recent-h" style={{ flex: "999 1 560px", minWidth: 0, padding: "40px 36px", display: "flex", flexDirection: "column", gap: 16 }}>
        <EngineBanner />
        {err && <div className="banner error" role="alert">{err}</div>}
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h2 id="recent-h" className="section-title">{t("Recent projects")}</h2>
          <label style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8, fontSize: 12 }} className="muted">
            {t("Search")} <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("episode name")} style={{ width: 220, height: 30 }} />
          </label>
        </div>
        <div role="list" style={{ display: "flex", flexDirection: "column", border: "1px solid var(--border)" }}>
          {rows === null && <div className="muted" style={{ padding: 16 }}>{t("Loading…")}</div>}
          {rows && shown.length === 0 && (
            <div className="muted" style={{ padding: 16, lineHeight: 1.6 }}>{rows.length ? t("Nothing found.") : t("No projects yet. Drag recordings in on the left to create your first one.")}</div>
          )}
          {shown.map((r) => {
            const st = STATUS[r.status];
            return (
              <div role="listitem" key={r.path} style={{ display: "flex", alignItems: "center", borderBottom: "1px solid #1c1f1c" }}>
                <button onClick={() => open(r)} style={{ flex: "1 1 auto", minWidth: 0, display: "flex", alignItems: "center", gap: 18, padding: "12px 16px", border: 0, background: "transparent", textAlign: "left" }}>
                  <Thumb v={r.thumb} />
                  <span style={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                    <span style={{ color: "var(--bright)", fontWeight: 500, fontSize: 14 }}>{r.name}</span>
                    <span className="mono muted" style={{ fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.folder}</span>
                  </span>
                  <span className="mono" style={{ flex: "0 0 70px", color: "var(--text2)" }}>{fmtDuration(r.length ?? r.recorded)}</span>
                  <span className="mono muted" style={{ flex: "0 0 92px", fontSize: 12 }}>{new Date(r.modified * 1000).toLocaleDateString(locale())}</span>
                  <span className="mono" style={{ flex: "0 0 auto", padding: "3px 8px", fontSize: 11, color: st.color, background: st.bg, border: `1px solid ${st.border}` }}>{statusLabel(r.status)}</span>
                </button>
                {isDesktop() && (
                  <button className="iconbtn" style={{ marginRight: 12, border: 0, background: "transparent" }} aria-label={t("Show “{name}” in folder", { name: r.name })} title={t("Show in folder")}
                    onClick={() => revealFile(r.path)}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M3 7h6l2 2h10v10H3z" /></svg>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
