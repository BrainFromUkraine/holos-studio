"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { engine, type Health } from "@/lib/engine";

type EngineState = { health: Health | null; error: string | null };
const EngineCtx = createContext<EngineState>({ health: null, error: null });
export const useEngine = () => useContext(EngineCtx);

const STAGES = [
  { href: "/import/", label: "Імпорт" },
  { href: "/edit/", label: "Редагування" },
  { href: "/export/", label: "Експорт" },
];

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

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname() ?? "/";
  const [state, setState] = useState<EngineState>({ health: null, error: null });

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const h = await engine.health();
        if (alive) setState({ health: h, error: null });
      } catch (e) {
        if (alive) setState({ health: null, error: e instanceof Error ? e.message : String(e) });
      }
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const h = state.health;
  const gpu = !h?.asr ? "ASR не встановлено" : h.cuda_devices ? "GPU · CUDA" : h.cuda_devices === 0 ? "CPU" : "ASR";

  return (
    <EngineCtx.Provider value={state}>
      <div className="app">
        <header className="titlebar">
          <span className="brand">
            <Logo />
            Holos Studio
          </span>
          <nav aria-label="Етапи">
            {STAGES.map((s) => (
              <Link key={s.href} href={s.href} aria-current={path.startsWith(s.href.slice(0, -1)) ? "page" : undefined}>
                {s.label}
              </Link>
            ))}
          </nav>
          <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }} className="muted">
            <span className={`dot ${h ? "ok" : "bad"}`} aria-hidden="true" />
            {h ? `engine ${h.version} · ${gpu}` : "engine не запущено"}
          </span>
        </header>
        {children}
        <footer className="statusbar">
          <span>{h?.ffmpeg ? "ffmpeg ✓" : "ffmpeg —"}</span>
          <span>{h?.asr ? "розпізнавання мови ✓" : "розпізнавання мови —"}</span>
          <span style={{ marginLeft: "auto" }}>Holos Studio 0.1.0</span>
        </footer>
      </div>
    </EngineCtx.Provider>
  );
}

export function EngineBanner() {
  const { health, error } = useEngine();
  if (health) return null;
  return (
    <div className="banner error" role="alert">
      Немає зв'язку з engine{error ? ` (${error})` : ""}. Запустіть у терміналі:{" "}
      <code className="mono">cd engine; uv run holos serve --dev</code>
    </div>
  );
}
