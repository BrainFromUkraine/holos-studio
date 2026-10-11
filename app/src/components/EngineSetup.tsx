"use client";

// Full-window screen while the packaged engine is being prepared (first run / after an update),
// started, or has failed. Render it instead of the app whenever `engineUsable(info)` is false.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { onSetupLine, restartEngine, type EngineInfo } from "@/lib/engineHost";

const C = {
  bg: "#0A0B0A",
  panel: "#141614",
  bar: "#060706",
  raised: "#1B1E1B",
  border: "#262926",
  text: "#E5E7E5",
  text2: "#AEB3AE",
  muted: "#8B8F8B",
  accent: "#3FD17A",
  error: "#FF4D4D",
  errorText: "#FFA3A3",
  sans: '"IBM Plex Sans", system-ui, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, monospace',
};

const MAX_LINES = 400;
const SHOWN_LINES = 14;

// ---- uv output → rough progress ----------------------------------------------------------------------------------

export type SetupProgress = {
  /** 0–100, or null while nothing measurable has happened yet (indeterminate bar). */
  pct: number | null;
  stage: string;
  /** "634 / 2410 МБ" while downloading. */
  detail: string | null;
};

const SIZE_RE = /\(([\d.]+)\s*(B|KiB|MiB|GiB)\)\s*$/;
const UNIT: Record<string, number> = { B: 1 / 1048576, KiB: 1 / 1024, MiB: 1, GiB: 1024 };

/**
 * uv prints (without a terminal) lines like:
 *   Downloading cpython-3.12.12-windows-x86_64-none (download) (21.3MiB)
 *   Downloading nvidia-cudnn-cu12 (634.0MiB)
 *    Downloaded nvidia-cudnn-cu12
 *   Prepared 84 packages in 2m 10s
 *   Installed 85 packages in 3.1s
 *   Bytecode compiled 2345 files in 6.2s
 * Downloads dominate the time, so they get most of the bar, weighted by size.
 */
export function estimateProgress(lines: string[]): SetupProgress {
  const sizes = new Map<string, number>();
  const done = new Set<string>();
  let python = false;
  let prepared = false;
  let installed = false;
  let compiled = false;
  let finished = false;

  for (const raw of lines) {
    const line = raw.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^Downloading\s+(\S+)/))) {
      const s = line.match(SIZE_RE);
      sizes.set(m[1], s ? parseFloat(s[1]) * UNIT[s[2]] : 1);
      if (m[1].startsWith("cpython")) python = true;
    } else if ((m = line.match(/^Downloaded\s+(\S+)/))) {
      done.add(m[1]);
    } else if (/^Installed Python/.test(line)) {
      python = true;
    } else if (/^Prepared \d+/.test(line)) {
      prepared = true;
    } else if (/^Installed \d+/.test(line)) {
      installed = true;
    } else if (/^Bytecode compiled/.test(line)) {
      compiled = true;
    } else if (line === "Готово.") {
      finished = true;
    }
  }

  if (finished) return { pct: 100, stage: "Готово", detail: null };
  if (compiled) return { pct: 99, stage: "Завершення", detail: null };
  if (installed) return { pct: 95, stage: "Компіляція Python-коду", detail: null };
  if (prepared) return { pct: 88, stage: "Встановлення бібліотек", detail: null };

  let total = 0;
  let got = 0;
  for (const [name, mb] of sizes) {
    total += mb;
    if (done.has(name)) got += mb;
  }
  if (total > 0) {
    const pythonPending = [...sizes.keys()].some((n) => n.startsWith("cpython") && !done.has(n));
    return {
      pct: 4 + Math.round((got / total) * 82),
      stage: pythonPending ? "Завантаження Python 3.12" : "Завантаження бібліотек",
      detail: `${Math.round(got)} / ${Math.round(total)} МБ`,
    };
  }
  return { pct: python ? 3 : null, stage: lines.length ? "Підготовка" : "Початок", detail: null };
}

// ---- component ---------------------------------------------------------------------------------------------------

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="1" y="7" width="2" height="4" fill={C.accent} />
      <rect x="5" y="4" width="2" height="10" fill={C.accent} />
      <rect x="9" y="1" width="2" height="16" fill={C.accent} />
      <rect x="13" y="5" width="2" height="8" fill={C.accent} />
    </svg>
  );
}

const btn = (primary: boolean): CSSProperties => ({
  height: 36,
  padding: "0 16px",
  border: primary ? 0 : `1px solid ${C.border}`,
  background: primary ? C.accent : C.raised,
  color: primary ? C.bg : C.text,
  fontFamily: C.sans,
  fontSize: 13,
  fontWeight: primary ? 600 : 400,
  borderRadius: 0,
  cursor: "pointer",
});

export function EngineSetup({ info }: { info: EngineInfo }) {
  const [lines, setLines] = useState<string[]>(info.log_tail);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const best = useRef(0);
  const logRef = useRef<HTMLPreElement>(null);

  // Live uv output. A new setup (retry) starts with an empty log_tail on the Rust side.
  useEffect(() => {
    let alive = true;
    let off: (() => void) | null = null;
    onSetupLine((line) => alive && setLines((l) => (l.length >= MAX_LINES ? [...l.slice(-MAX_LINES + 1), line] : [...l, line]))).then(
      (u) => (alive ? (off = u) : u()),
    );
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  // State events carry the full tail (also engine stderr while starting / on error) — prefer it when longer.
  useEffect(() => {
    setLines((l) => (info.log_tail.length >= l.length || info.state === "error" ? info.log_tail : l));
    if (info.state !== "setup") setBusy(false);
  }, [info]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  const progress = useMemo(() => estimateProgress(lines), [lines]);
  // Never move backwards (a restart resets it).
  if (info.state === "setup" && progress.pct !== null) best.current = Math.max(best.current, progress.pct);
  if (info.state !== "setup" && info.state !== "starting") best.current = 0;

  const isError = info.state === "error";
  const isSetup = info.state === "setup";
  const pct = isSetup && progress.pct !== null ? best.current : null;

  const title = isError ? "Не вдалося запустити engine" : isSetup ? "Перший запуск: готуємо engine" : "Запускаємо engine…";
  const lead = isError
    ? info.error ?? "Невідома помилка."
    : isSetup
      ? "Holos Studio завантажує Python і бібліотеки для розпізнавання мови на відеокарті (близько 2,5 ГБ). Це відбувається один раз — далі програма стартує за кілька секунд."
      : "Кілька секунд…";

  const retry = async () => {
    setBusy(true);
    setLines([]);
    best.current = 0;
    try {
      await restartEngine();
    } catch {
      setBusy(false);
    }
  };

  const copyLog = async () => {
    try {
      await navigator.clipboard.writeText([info.error ?? "", ...lines].join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div
      role="main"
      aria-busy={!isError}
      style={{
        position: "fixed",
        inset: 0,
        background: C.bg,
        color: C.text,
        fontFamily: C.sans,
        fontSize: 13,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        zIndex: 1000,
      }}
    >
      <style>{`
        @keyframes holos-indeterminate { from { transform: translateX(-100%); } to { transform: translateX(350%); } }
        @media (prefers-reduced-motion: reduce) { .holos-ind { animation-duration: 6s !important; } }
      `}</style>
      <section
        style={{
          width: "min(720px, 100%)",
          background: C.panel,
          border: `1px solid ${C.border}`,
          borderRadius: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 18px",
            borderBottom: `1px solid ${C.border}`,
            background: C.bar,
            fontWeight: 600,
          }}
        >
          <Logo />
          Holos Studio
          <span style={{ marginLeft: "auto", fontFamily: C.mono, fontSize: 11, color: C.muted }}>engine · {info.state}</span>
        </header>

        <div style={{ padding: "22px 18px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600, color: isError ? C.errorText : C.text }}>{title}</h1>
          <p style={{ margin: 0, color: C.text2, lineHeight: 1.5, maxWidth: 620, whiteSpace: "pre-wrap" }}>{lead}</p>

          {!isError && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", fontFamily: C.mono, fontSize: 12, color: C.text2 }}>
                <span>{isSetup ? progress.stage : "Запуск"}</span>
                {isSetup && progress.detail && <span style={{ marginLeft: 12, color: C.muted }}>{progress.detail}</span>}
                <span style={{ marginLeft: "auto", color: C.text }}>{pct !== null ? `${pct}%` : ""}</span>
              </div>
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct ?? undefined}
                aria-label={isSetup ? progress.stage : "Запуск engine"}
                style={{ height: 6, background: C.raised, position: "relative", overflow: "hidden" }}
              >
                {pct !== null ? (
                  <i style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${pct}%`, background: C.accent, transition: "width .4s" }} />
                ) : (
                  <i
                    className="holos-ind"
                    style={{
                      position: "absolute",
                      left: 0,
                      top: 0,
                      bottom: 0,
                      width: "30%",
                      background: C.accent,
                      animation: "holos-indeterminate 1.4s linear infinite",
                    }}
                  />
                )}
              </div>
            </div>
          )}

          {isError && (
            <div style={{ display: "flex", gap: 8 }}>
              <button type="button" style={btn(true)} onClick={retry} disabled={busy}>
                {busy ? "Запускаємо…" : "Спробувати ще раз"}
              </button>
              <button type="button" style={btn(false)} onClick={copyLog}>
                {copied ? "Скопійовано" : "Скопіювати журнал"}
              </button>
            </div>
          )}

          {(lines.length > 0 || isError) && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: C.muted, textTransform: "uppercase", letterSpacing: 0.8 }}>Журнал</span>
              <pre
                ref={logRef}
                aria-live="polite"
                style={{
                  margin: 0,
                  height: SHOWN_LINES * 17 + 16,
                  overflow: "auto",
                  padding: 8,
                  background: C.bg,
                  border: `1px solid ${isError ? "#6E2222" : C.border}`,
                  fontFamily: C.mono,
                  fontSize: 11.5,
                  lineHeight: "17px",
                  color: C.text2,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                }}
              >
                {lines.length ? lines.join("\n") : "—"}
              </pre>
            </div>
          )}

          {isSetup && (
            <p style={{ margin: 0, fontSize: 12, color: C.muted }}>
              Не закривайте вікно. Якщо закриєте — підготовка продовжиться з того ж місця під час наступного запуску.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
