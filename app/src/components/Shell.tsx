"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { EngineSetup } from "@/components/EngineSetup";
import { UpdateBanner } from "@/components/UpdateBanner";
import { currentProject, engine, EngineDownError, setEngineConnection, type Health } from "@/lib/engine";
import { engineUsable, useEngineInfo } from "@/lib/engineHost";
import { t, useLang } from "@/lib/i18n";
import { APP_VERSION, channel, displayVersion } from "@/lib/version";

/** `error` is null when the engine simply cannot be reached (EngineDownError) — only real engine errors are kept. */
type EngineState = { health: Health | null; error: string | null; mcpSeen: number | null; packaged: boolean };
const EngineCtx = createContext<EngineState>({ health: null, error: null, mcpSeen: null, packaged: false });
export const useEngine = () => useContext(EngineCtx);

function Logo() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="1" y="7" width="2" height="4" fill="#3FD17A" />
      <rect x="5" y="4" width="2" height="10" fill="#3FD17A" />
      <rect x="9" y="1" width="2" height="16" fill="#3FD17A" />
      <rect x="13" y="5" width="2" height="8" fill="#3FD17A" />
    </svg>
  );
}

/** Project name + path of the open project, kept in sync across pages. */
export function useCurrentProject(): { path: string | null; name: string | null } {
  const [p, setP] = useState<{ path: string | null; name: string | null }>({ path: null, name: null });
  useEffect(() => {
    const read = () => setP({ path: currentProject.get(), name: currentProject.name() });
    read();
    window.addEventListener("holos-project", read);
    window.addEventListener("storage", read);
    return () => {
      window.removeEventListener("holos-project", read);
      window.removeEventListener("storage", read);
    };
  }, []);
  return p;
}

const MCP_FRESH_S = 6 * 3600;

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname() ?? "/";
  const lang = useLang();
  const info = useEngineInfo();
  const usable = engineUsable(info);
  // Packaged app: the shell started the engine on a free port with a token. Set before children render.
  if (info.state === "ready") setEngineConnection(info.url, info.token);
  const [state, setState] = useState<EngineState>({ health: null, error: null, mcpSeen: null, packaged: false });
  const project = useCurrentProject();

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  useEffect(() => {
    if (!usable) return;
    let alive = true;
    let n = 0;
    let mcpSeen: number | null = null;
    const tick = async () => {
      try {
        const h = await engine.health();
        if (n++ % 6 === 0) mcpSeen = (await engine.settings().catch(() => null))?.mcp_last_seen ?? mcpSeen;
        if (alive) setState({ health: h, error: null, mcpSeen, packaged: info.state === "ready" });
      } catch (e) {
        if (alive) setState((s) => ({ ...s, health: null, error: e instanceof EngineDownError ? null : e instanceof Error ? e.message : String(e) }));
      }
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [usable, info.state, info.url, info.token]);

  if (!usable) return <EngineSetup info={info} />;

  const h = state.health;
  const gpu = !h?.asr ? t("speech recognition not installed") : h.cuda_devices ? "GPU · CUDA" : h.cuda_devices === 0 ? "CPU" : t("ready");
  const inProject = Boolean(project.path) && (path.startsWith("/edit") || path.startsWith("/export") || path.startsWith("/automation"));
  const claudeOn = state.mcpSeen !== null && Date.now() / 1000 - state.mcpSeen < MCP_FRESH_S;

  return (
    <EngineCtx.Provider value={state}>
      <div className="app">
        <header className="titlebar">
          <Link href="/" className="brand" style={{ textDecoration: "none" }} title={t("All projects")}>
            <Logo />
            {inProject ? <span style={{ color: "var(--text2)", fontWeight: 400 }}>{t("Projects")}</span> : "Holos Studio"}
            {!inProject && channel(APP_VERSION) && (
              <span className="mono" title={t("Version {version} — pre-release, may have bugs", { version: displayVersion(APP_VERSION) })}
                style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".06em", padding: "1px 5px", border: "1px solid var(--q-border)", background: "var(--q-bg)", color: "var(--question)" }}>
                {channel(APP_VERSION)!.toUpperCase()}
              </span>
            )}
          </Link>
          {inProject && (
            <>
              <span style={{ color: "var(--dim)" }} aria-hidden="true">/</span>
              <span style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 380 }}>{project.name ?? t("Project")}</span>
              <nav aria-label={t("Stages")}>
                <Link href="/edit/" aria-current={path.startsWith("/edit") || path.startsWith("/automation") ? "page" : undefined}>{t("Editor")}</Link>
                <Link href="/export/" aria-current={path.startsWith("/export") ? "page" : undefined}>{t("Export")}</Link>
              </nav>
            </>
          )}
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 16, fontSize: 12 }} className="muted">
            <span style={{ display: "flex", alignItems: "center", gap: 6 }} title={h ? t("engine {version}", { version: h.version }) : state.error ?? t("The engine is not responding.")}>
              <span className={`dot ${h ? "ok" : "bad"}`} aria-hidden="true" />
              {h ? t("engine · {status}", { status: gpu }) : t("engine not running")}
            </span>
            <Link href="/settings/" style={{ display: "flex", alignItems: "center", gap: 6, textDecoration: "none", color: "inherit" }}
              title={claudeOn ? t("Claude connected via MCP") : t("How to connect Claude")}>
              <span className={`dot ${claudeOn ? "ok" : ""}`} aria-hidden="true" />
              {claudeOn ? "Claude · MCP" : t("Claude not connected")}
            </Link>
            <Link href="/settings/" aria-label={t("Settings")} title={t("Settings")} style={{ display: "flex", color: "var(--text2)" }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
              </svg>
            </Link>
          </span>
        </header>
        <UpdateBanner />
        {children}
      </div>
    </EngineCtx.Provider>
  );
}

export function EngineBanner() {
  useLang();
  const { health, error, packaged } = useEngine();
  if (health) return null;
  return (
    <div className="banner error" role="alert">
      {error ? t("Engine error: {error}.", { error }) : t("No connection to the engine.")}{" "}
      {packaged ? t("Restart Holos Studio.") : <>{t("Start it from a terminal:")} <code className="mono">cd engine; uv run holos serve --dev</code></>}
    </div>
  );
}
