"use client";

import Link from "next/link";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import { EngineBanner, useEngine } from "@/components/Shell";
import { isDesktop, openExternal, pickFolder, revealFile } from "@/lib/desktop";
import { engine, type Settings } from "@/lib/engine";
import { LANGS, locale, setLang, t, useLang } from "@/lib/i18n";
import { APP_VERSION, channel, displayVersion } from "@/lib/version";

const CHANGELOG_URL = "https://github.com/BrainFromUkraine/holos-studio/blob/main/CHANGELOG.md";

type Full = Settings & { mcp_config?: unknown; version?: string };

/** A translated sentence with {placeholders} replaced by elements. */
function rich(text: string, parts: Record<string, ReactNode>): ReactNode[] {
  return text.split(/(\{\w+\})/).map((x, i) => {
    const m = /^\{(\w+)\}$/.exec(x);
    return <Fragment key={i}>{m && m[1] in parts ? parts[m[1]] : x}</Fragment>;
  });
}

export default function SettingsPage() {
  const lang = useLang();
  const { health, mcpSeen } = useEngine();
  const [s, setS] = useState<Full | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (health) engine.settings().then((x) => setS(x as Full)).catch((e) => setErr(String(e.message ?? e)));
  }, [health]);

  const config = s?.mcp_config ? JSON.stringify(s.mcp_config, null, 2) : "";
  const seen = mcpSeen ? new Date(mcpSeen * 1000).toLocaleString(locale()) : null;

  return (
    <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 18, maxWidth: 980 }}>
      <EngineBanner />
      <div style={{ display: "flex", alignItems: "baseline" }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>{t("Settings")}</h1>
        <Link href="/" style={{ marginLeft: "auto", color: "var(--core)" }}>← {t("Projects")}</Link>
      </div>
      {err && <div className="banner error">{err}</div>}

      <section className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }} aria-labelledby="lang-h">
        <h2 id="lang-h" style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t("Language")}</h2>
        <div role="radiogroup" aria-labelledby="lang-h" className="seg" style={{ maxWidth: 360 }}>
          {LANGS.map((l) => (
            <button key={l.id} type="button" role="radio" lang={l.id} aria-checked={lang === l.id ? "true" : "false"} onClick={() => setLang(l.id)}>{l.name}</button>
          ))}
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>{t("Folder and file names are always in English.")}</p>
      </section>

      <section className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }} aria-labelledby="mcp-h">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className={`dot ${seen ? "ok" : ""}`} aria-hidden="true" />
          <h2 id="mcp-h" style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Claude (MCP)</h2>
          <span className="muted" style={{ fontSize: 12 }}>{seen ? t("last connected {time}", { time: seen }) : t("not connected yet")}</span>
        </div>
        <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8, color: "var(--text2)" }}>
          <li>{rich(t("Open Claude Desktop → Settings → Developer → {edit}. This opens the file {file}."), {
            edit: <b style={{ color: "var(--text)" }}>Edit Config</b>,
            file: <span className="mono">claude_desktop_config.json</span>,
          })}</li>
          <li>{rich(t("Copy the configuration below and paste it into the file. If the file already has {servers}, add only the {block} block inside it."), {
            servers: <span className="mono">mcpServers</span>,
            block: <span className="mono">holos-studio</span>,
          })}</li>
        </ol>
        <pre className="mono" style={{ margin: 0, padding: 12, background: "var(--lane)", border: "1px solid var(--border)", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{config || "…"}</pre>
        <div>
          <button className="btn" disabled={!config} onClick={async () => { await navigator.clipboard.writeText(config); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>{copied ? t("Copied") : t("Copy")}</button>
        </div>
        <ol start={3} style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8, color: "var(--text2)" }}>
          <li>{t("Save the file, quit Claude Desktop completely (from the system tray too), then start it again.")}</li>
          <li>{t("To check, ask Claude “Show my projects in Holos”. The Claude indicator at the top of this window turns green.")}</li>
        </ol>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>{t("Changes made by Claude can be undone with Ctrl+Z in the editor.")}</p>
      </section>

      <section className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }} aria-labelledby="dirs-h">
        <h2 id="dirs-h" style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t("Folders")}</h2>
        <div style={{ display: "grid", gridTemplateColumns: "160px minmax(0, 1fr) auto", gap: "8px 12px", alignItems: "center" }}>
          <span className="muted">{t("Projects")}</span>
          <span className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{s?.projects_dir ?? "…"}</span>
          {isDesktop() ? (
            <button className="btn" style={{ height: 30 }} onClick={async () => { const d = await pickFolder(s?.projects_dir); if (d) setS((await engine.saveSettings({ projects_dir: d })) as Full); }}>{t("Change…")}</button>
          ) : <span />}
          <span className="muted">{t("Video templates")}</span>
          <span className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{s?.templates_dir ?? "…"}</span>
          {isDesktop() && s ? <button className="btn" style={{ height: 30 }} onClick={() => revealFile(s.templates_dir)}>{t("Show")}</button> : <span />}
        </div>
      </section>

      <section className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 6 }} aria-labelledby="about-h">
        <h2 id="about-h" style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{t("About")}</h2>
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
          Holos Studio {displayVersion(APP_VERSION)}{channel(APP_VERSION) ? ` · ${t("pre-release")}` : ""} · {t("open source, MIT")} ·{" "}
          <a href={CHANGELOG_URL} onClick={(e) => { e.preventDefault(); openExternal(CHANGELOG_URL); }} style={{ color: "var(--core)" }}>{t("what's new")}</a><br />
          {t("Engine")}: {health ? `${health.version} · ${health.cuda_devices ? "GPU CUDA" : "CPU"} · ffmpeg ${health.ffmpeg ? "✓" : "—"}` : t("not running")}
        </div>
      </section>
    </div>
  );
}
