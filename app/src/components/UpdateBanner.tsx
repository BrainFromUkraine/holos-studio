"use client";

// Slim bar at the top of the window when a new version is on GitHub Releases:
// "Доступна версія X — Оновити" → download progress → install → restart.

import { useEffect, useState } from "react";
import { checkForUpdate, installUpdate, type AvailableUpdate, type UpdateProgress } from "@/lib/updates";

const C = {
  bar: "#0F1A13",
  border: "#1F4A30",
  raised: "#1B1E1B",
  text: "#E5E7E5",
  muted: "#8B8F8B",
  accent: "#3FD17A",
  bg: "#0A0B0A",
  errorText: "#FFA3A3",
  sans: '"IBM Plex Sans", system-ui, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, monospace',
};

type Phase = { kind: "idle" } | { kind: "available" } | { kind: "downloading"; p: UpdateProgress } | { kind: "installing" } | { kind: "error"; message: string };

const mb = (b: number) => `${(b / 1048576).toFixed(1)} МБ`;

export function UpdateBanner() {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let alive = true;
    // Give the window (and a first-run engine setup) a moment before going online.
    const t = setTimeout(() => {
      checkForUpdate().then((u) => {
        if (alive && u) {
          setUpdate(u);
          setPhase({ kind: "available" });
        }
      });
    }, 3000);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, []);

  if (!update || hidden || phase.kind === "idle") return null;

  const start = async () => {
    setPhase({ kind: "downloading", p: { downloaded: 0, total: null } });
    try {
      await installUpdate((p) => {
        if (p.total !== null && p.downloaded >= p.total) setPhase({ kind: "installing" });
        else setPhase({ kind: "downloading", p });
      });
      setPhase({ kind: "installing" });
    } catch (e) {
      setPhase({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const pct = phase.kind === "downloading" && phase.p.total ? Math.min(100, Math.round((phase.p.downloaded / phase.p.total) * 100)) : null;
  const busy = phase.kind === "downloading" || phase.kind === "installing";

  return (
    <div
      role="status"
      style={{
        position: "relative",
        height: 32,
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "0 14px",
        background: C.bar,
        borderBottom: `1px solid ${C.border}`,
        color: C.text,
        fontFamily: C.sans,
        fontSize: 12.5,
        flex: "0 0 auto",
      }}
    >
      <span style={{ width: 7, height: 7, background: C.accent, flex: "0 0 auto" }} aria-hidden="true" />
      {phase.kind === "available" && (
        <>
          <span>
            Доступна версія <b className="mono" style={{ fontFamily: C.mono }}>{update.version}</b>
            <span style={{ color: C.muted }}> · у вас {update.currentVersion}</span>
          </span>
          <button
            type="button"
            onClick={start}
            style={{ height: 24, padding: "0 12px", border: 0, background: C.accent, color: C.bg, fontWeight: 600, fontFamily: C.sans, fontSize: 12, borderRadius: 0, cursor: "pointer" }}
          >
            Оновити
          </button>
          {update.notes && (
            <span style={{ color: C.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }} title={update.notes}>
              {update.notes.split("\n")[0]}
            </span>
          )}
        </>
      )}
      {phase.kind === "downloading" && (
        <span style={{ fontFamily: C.mono }}>
          Завантаження оновлення {update.version}… {pct !== null ? `${pct}%` : mb(phase.p.downloaded)}
          {phase.p.total ? <span style={{ color: C.muted }}> · {mb(phase.p.downloaded)} / {mb(phase.p.total)}</span> : null}
        </span>
      )}
      {phase.kind === "installing" && <span>Встановлення… Holos Studio перезапуститься сама.</span>}
      {phase.kind === "error" && (
        <>
          <span style={{ color: C.errorText, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }} title={phase.message}>
            Не вдалося оновити: {phase.message}
          </span>
          <button
            type="button"
            onClick={start}
            style={{ height: 24, padding: "0 12px", border: `1px solid ${C.border}`, background: C.raised, color: C.text, fontFamily: C.sans, fontSize: 12, borderRadius: 0, cursor: "pointer" }}
          >
            Ще раз
          </button>
        </>
      )}
      {!busy && (
        <button
          type="button"
          aria-label="Пізніше"
          title="Пізніше"
          onClick={() => setHidden(true)}
          style={{ marginLeft: "auto", height: 24, width: 24, border: 0, background: "transparent", color: C.muted, fontSize: 16, lineHeight: 1, cursor: "pointer", borderRadius: 0 }}
        >
          ×
        </button>
      )}
      {phase.kind === "downloading" && (
        <i style={{ position: "absolute", left: 0, bottom: -1, height: 2, width: `${pct ?? 0}%`, background: C.accent, transition: "width .3s" }} />
      )}
    </div>
  );
}
