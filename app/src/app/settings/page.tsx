"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { EngineBanner, useEngine } from "@/components/Shell";
import { isDesktop, openExternal, pickFolder, revealFile } from "@/lib/desktop";
import { engine, type Settings } from "@/lib/engine";
import { APP_VERSION, channel, displayVersion } from "@/lib/version";

const CHANGELOG_URL = "https://github.com/BrainFromUkraine/holos-studio/blob/main/CHANGELOG.md";

type Full = Settings & { mcp_config?: unknown; version?: string };

export default function SettingsPage() {
  const { health, mcpSeen } = useEngine();
  const [s, setS] = useState<Full | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (health) engine.settings().then((x) => setS(x as Full)).catch((e) => setErr(String(e.message ?? e)));
  }, [health]);

  const config = s?.mcp_config ? JSON.stringify(s.mcp_config, null, 2) : "";
  const seen = mcpSeen ? new Date(mcpSeen * 1000).toLocaleString("uk-UA") : null;

  return (
    <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 18, maxWidth: 980 }}>
      <EngineBanner />
      <div style={{ display: "flex", alignItems: "baseline" }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Налаштування</h1>
        <Link href="/" style={{ marginLeft: "auto", color: "var(--core)" }}>← Проєкти</Link>
      </div>
      {err && <div className="banner error">{err}</div>}

      <section className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }} aria-labelledby="mcp-h">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className={`dot ${seen ? "ok" : ""}`} aria-hidden="true" />
          <h2 id="mcp-h" style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Claude (MCP)</h2>
          <span className="muted" style={{ fontSize: 12 }}>{seen ? `останній зв'язок ${seen}` : "ще не підключався"}</span>
        </div>
        <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8, color: "var(--text2)" }}>
          <li>Відкрийте Claude Desktop → Settings → Developer → <b style={{ color: "var(--text)" }}>Edit Config</b>. Відкриється файл <span className="mono">claude_desktop_config.json</span>.</li>
          <li>Скопіюйте конфігурацію нижче і вставте у файл. Якщо у файлі вже є <span className="mono">mcpServers</span>, додайте всередину нього лише блок <span className="mono">holos-studio</span>.</li>
        </ol>
        <pre className="mono" style={{ margin: 0, padding: 12, background: "var(--lane)", border: "1px solid var(--border)", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{config || "…"}</pre>
        <div>
          <button className="btn" disabled={!config} onClick={async () => { await navigator.clipboard.writeText(config); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>{copied ? "Скопійовано" : "Копіювати"}</button>
        </div>
        <ol start={3} style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8, color: "var(--text2)" }}>
          <li>Збережіть файл і повністю закрийте Claude Desktop (з трею), потім запустіть знову.</li>
          <li>Перевірка: напишіть у Claude «Покажи мої проєкти в Holos». Індикатор Claude вгорі цього вікна стане зеленим.</li>
        </ol>
        <p className="muted" style={{ margin: 0, fontSize: 12 }}>Зміни, які робить Claude, скасовуються Ctrl+Z у редакторі.</p>
      </section>

      <section className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }} aria-labelledby="dirs-h">
        <h2 id="dirs-h" style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Папки</h2>
        <div style={{ display: "grid", gridTemplateColumns: "160px minmax(0, 1fr) auto", gap: "8px 12px", alignItems: "center" }}>
          <span className="muted">Проєкти</span>
          <span className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{s?.projects_dir ?? "…"}</span>
          {isDesktop() ? (
            <button className="btn" style={{ height: 30 }} onClick={async () => { const d = await pickFolder(s?.projects_dir); if (d) setS((await engine.saveSettings({ projects_dir: d })) as Full); }}>Змінити…</button>
          ) : <span />}
          <span className="muted">Шаблони відео</span>
          <span className="mono" style={{ fontSize: 12, wordBreak: "break-all" }}>{s?.templates_dir ?? "…"}</span>
          {isDesktop() && s ? <button className="btn" style={{ height: 30 }} onClick={() => revealFile(s.templates_dir)}>Показати</button> : <span />}
        </div>
      </section>

      <section className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 6 }} aria-labelledby="about-h">
        <h2 id="about-h" style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Про програму</h2>
        <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
          Holos Studio {displayVersion(APP_VERSION)}{channel(APP_VERSION) ? " · тестова версія" : ""} · відкритий код, MIT ·{" "}
          <a href={CHANGELOG_URL} onClick={(e) => { e.preventDefault(); openExternal(CHANGELOG_URL); }} style={{ color: "var(--core)" }}>що нового</a><br />
          Рушій: {health ? `${health.version} · ${health.cuda_devices ? "GPU CUDA" : "CPU"} · ffmpeg ${health.ffmpeg ? "✓" : "—"}` : "не запущено"}
        </div>
      </section>
    </div>
  );
}
