"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { EngineBanner, useEngine } from "@/components/Shell";
import { isDesktop, pickFolder, revealFile } from "@/lib/desktop";
import { engine, type Settings } from "@/lib/engine";

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
        <p style={{ margin: 0, lineHeight: 1.6, color: "var(--text2)" }}>
          Як з KiCad: Claude Desktop бачить ваші проєкти і може різати, відновлювати, міняти автоматику, ставити таймкоди й запускати експорт. Усе, що він робить, можна скасувати Ctrl+Z.
        </p>
        <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.8, color: "var(--text2)" }}>
          <li>Claude Desktop → Settings → Developer → <b style={{ color: "var(--text)" }}>Edit Config</b>.</li>
          <li>Додайте <span className="mono">holos-studio</span> у <span className="mono">mcpServers</span> (поруч з іншими серверами, наприклад kicad):</li>
        </ol>
        <pre className="mono" style={{ margin: 0, padding: 12, background: "var(--lane)", border: "1px solid var(--border)", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{config || "…"}</pre>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="btn" disabled={!config} onClick={async () => { await navigator.clipboard.writeText(config); setCopied(true); setTimeout(() => setCopied(false), 2000); }}>{copied ? "Скопійовано" : "Копіювати"}</button>
          <span className="muted" style={{ fontSize: 12 }}>3. Перезапустіть Claude Desktop і напишіть: «Зроби таймкоди для мого останнього випуску в Holos».</span>
        </div>
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
          Holos Studio {s?.version ?? health?.version ?? ""} · відкритий код, MIT · github.com/BrainFromUkraine/holos-studio<br />
          Рушій: {health ? `${health.version} · ${health.cuda_devices ? "GPU CUDA" : "CPU"} · ffmpeg ${health.ffmpeg ? "✓" : "—"}` : "не запущено"}
        </div>
      </section>
    </div>
  );
}
