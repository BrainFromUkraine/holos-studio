"use client";

// Export screen → Thumbnail: the picture added to the project, cropped to the chosen size, with the episode badge.
// The engine renders the real image (Pillow); while the badge is dragged or tuned, the bare picture is shown with the
// badge drawn here in the same typeface and geometry, and the engine's render replaces it when the change is saved.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { basename, isDesktop, pickFile } from "@/lib/desktop";
import { engine, type Badge, type ThumbnailSettings, type ThumbnailState } from "@/lib/engine";
import { t, useLang } from "@/lib/i18n";

const FONT_FAMILY = "HolosBadge";
const PREVIEW_MAX_W = 960;           // same as the engine's preview size
let fontLoad: Promise<void> | null = null;

function loadFont(): Promise<void> {
  if (!fontLoad) {
    fontLoad = (async () => {
      try {
        const f = new FontFace(FONT_FAMILY, `url(${engine.thumbnailFontUrl()})`);
        await f.load();
        document.fonts.add(f);
      } catch {
        fontLoad = null;                 // try again next time (engine restarted, token changed)
      }
    })();
  }
  return fontLoad ?? Promise.resolve();
}

type Geo = { cx: number; cy: number; w: number; h: number; pw: number; ph: number; scale: number; iw: number; ih: number };

/** Where the badge lands in a preview of the given settings — the engine's formula (cover, cropped evenly). */
function geometry(s: ThumbnailSettings, iw: number, ih: number): Geo {
  const k = s.width > PREVIEW_MAX_W ? PREVIEW_MAX_W / s.width : 1;
  const pw = Math.max(16, Math.round(s.width * k));
  const ph = Math.max(16, Math.round(s.height * k));
  const scale = Math.max(pw / iw, ph / ih);
  const left = (iw * scale - pw) / 2;
  const top = (ih * scale - ph) / 2;
  const sh = ih * scale;
  return { cx: s.badge.x * iw * scale - left, cy: s.badge.y * ih * scale - top, w: s.badge.width * sh, h: s.badge.height * sh, pw, ph, scale, iw, ih };
}

function badgeText(s: ThumbnailSettings): string {
  return s.badge.text.includes("{n}") ? s.badge.text.replaceAll("{n}", s.episode == null ? "?" : String(s.episode)) : s.badge.text;
}

const sizeName = (w: number, h: number) =>
  ({ "1280x720": "HD", "1920x1080": "Full HD", "2560x1440": "2K", "3840x2160": "4K", "1080x1080": t("square") } as Record<string, string>)[`${w}x${h}`];

export function ThumbnailEditor({ path, disabled, onState, episodeHint }: {
  path: string;
  disabled: boolean;
  onState?: (s: ThumbnailState) => void;
  /** The video template's episode number: when the user changes it there, the thumbnail follows. */
  episodeHint?: number | null;
}) {
  useLang();
  const [st, setSt] = useState<ThumbnailState | null>(null);
  const [local, setLocal] = useState<ThumbnailSettings | null>(null);   // edited, maybe not saved yet
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [fontReady, setFontReady] = useState(false);
  const [custom, setCustom] = useState(false);
  const timer = useRef<number | null>(null);
  const pending = useRef<Parameters<typeof engine.setThumbnail>[1]>({});
  const box = useRef<HTMLDivElement | null>(null);
  const measure = useRef<CanvasRenderingContext2D | null>(null);
  const localRef = useRef<ThumbnailSettings | null>(null);
  localRef.current = local;

  const apply = useCallback((r: ThumbnailState) => {
    setSt(r);
    setLocal(r.settings);
    setErr(r.error);
    onState?.(r);
  }, [onState]);

  useEffect(() => {
    engine.thumbnail(path).then((r) => {
      apply(r);
      setCustom(!r.presets.some((p) => p.width === r.settings.width && p.height === r.settings.height));
    }).catch((e) => setErr(String(e.message ?? e)));
    loadFont().then(() => setFontReady(document.fonts.check(`16px ${FONT_FAMILY}`)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const flush = useCallback(async () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    const changes = pending.current;
    pending.current = {};
    if (!Object.keys(changes).length) return;
    setBusy(true);
    try {
      apply(await engine.setThumbnail(path, changes));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(Object.keys(pending.current).length > 0);
    }
  }, [apply, path]);

  /** Change settings locally at once and save them shortly after (sliders, typing). */
  const change = useCallback((c: Partial<Omit<ThumbnailSettings, "badge">> & { badge?: Partial<Badge> }, now = false) => {
    setLocal((l) => (l ? { ...l, ...c, badge: { ...l.badge, ...(c.badge ?? {}) } } : l));
    const { badge, ...rest } = c;
    pending.current = { ...pending.current, ...rest, ...(badge ? { badge: { ...(pending.current.badge ?? {}), ...badge } } : {}) };
    setBusy(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, now ? 0 : 450);
  }, [flush]);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const lastHint = useRef(episodeHint);
  useEffect(() => {
    if (episodeHint === lastHint.current) return;
    lastHint.current = episodeHint;
    if (typeof episodeHint === "number" && localRef.current && localRef.current.episode !== episodeHint) change({ episode: episodeHint });
  }, [episodeHint, change]);

  const pv = st?.preview ?? null;
  const geo = useMemo(() => (local && pv ? geometry(local, pv.placement.image_w, pv.placement.image_h) : null), [local, pv]);
  // the engine's picture fits the current settings only when nothing but the badge differs
  const sameFrame = !!(pv && local && geo && geo.pw === pv.width && geo.ph === pv.height && local.image === st?.settings.image);
  const badgeLive = sameFrame && (drag || busy);

  // horizontal squeeze of the text, like the engine: min(squeeze, fits into text_width of the badge)
  const squeeze = useMemo(() => {
    if (!local || !geo || typeof document === "undefined") return local?.badge.squeeze ?? 1;
    if (!measure.current) measure.current = document.createElement("canvas").getContext("2d");
    const ctx = measure.current;
    if (!ctx) return local.badge.squeeze;
    ctx.font = `${local.badge.font * geo.h}px ${FONT_FAMILY}, "Arial Black", sans-serif`;
    const w = ctx.measureText(badgeText(local)).width || 1;
    return Math.min(local.badge.squeeze, (local.badge.text_width * geo.w) / w);
  }, [local, geo, fontReady]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ---- dragging the badge ---------------------------------------------------------------------
  const dragFrom = useRef<{ x: number; y: number; bx: number; by: number; k: number } | null>(null);
  const onDown = (e: React.PointerEvent) => {
    if (disabled || !local || !geo || !box.current || !local.badge.enabled) return;
    const r = box.current.getBoundingClientRect();
    dragFrom.current = { x: e.clientX, y: e.clientY, bx: local.badge.x, by: local.badge.y, k: r.width / geo.pw };
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag(true);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = dragFrom.current;
    if (!d || !geo) return;
    const dx = (e.clientX - d.x) / d.k / (geo.scale * geo.iw);
    const dy = (e.clientY - d.y) / d.k / (geo.scale * geo.ih);
    const clamp = (v: number) => Math.round(Math.min(1.5, Math.max(-0.5, v)) * 10000) / 10000;
    setLocal((l) => (l ? { ...l, badge: { ...l.badge, x: clamp(d.bx + dx), y: clamp(d.by + dy) } } : l));
  };
  const onUp = () => {
    if (!dragFrom.current) return;
    dragFrom.current = null;
    setDrag(false);
    const l = localRef.current;
    if (l) change({ badge: { x: l.badge.x, y: l.badge.y } }, true);
  };
  const nudge = (e: React.KeyboardEvent) => {
    if (!local) return;
    const step = e.shiftKey ? 0.01 : 0.002;
    const m: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const v = m[e.key];
    if (!v) return;
    e.preventDefault();
    change({ badge: { x: +(local.badge.x + v[0]).toFixed(4), y: +(local.badge.y + v[1]).toFixed(4) } });
  };

  const choosePicture = async () => {
    const f = await pickFile(["png", "jpg", "jpeg", "webp"], local?.image ?? undefined);
    if (f) change({ image: f }, true);
  };

  if (!st || !local) {
    return <div className="muted" style={{ fontSize: 12 }}>{err ?? t("Loading…")}</div>;
  }
  const b = local.badge;
  const preset = custom ? "custom" : `${local.width}x${local.height}`;
  const needsNumber = b.enabled && b.text.includes("{n}") && local.episode == null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        {/* preview */}
        <div style={{ flex: "1 1 420px", minWidth: 280 }}>
          <div ref={box} style={{ position: "relative", background: "#000", border: "1px solid var(--border)", aspectRatio: `${local.width} / ${local.height}`, maxHeight: "46vh", overflow: "hidden", userSelect: "none", touchAction: "none" }}>
            {pv ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={engine.cacheUrl(badgeLive ? pv.base : pv.image)} alt={t("Thumbnail preview")} draggable={false}
                  style={{ display: "block", width: "100%", height: "100%", objectFit: "fill", opacity: sameFrame ? 1 : 0.45 }} />
                {geo && sameFrame && b.enabled && (
                  <svg viewBox={`0 0 ${geo.pw} ${geo.ph}`} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} aria-hidden="true">
                    <g transform={`translate(${geo.cx} ${geo.cy}) rotate(${b.angle})`}>
                      {badgeLive && (() => {
                        const hw = geo.w / 2, hh = geo.h / 2, c = Math.min(b.chamfer, 0.5) * geo.h;
                        const pts = [[-hw + c, -hh], [hw - c, -hh], [hw, -hh + c], [hw, hh - c], [hw - c, hh], [-hw + c, hh], [-hw, hh - c], [-hw, -hh + c]];
                        return (
                          <>
                            <polygon points={pts.map((p) => p.join(",")).join(" ")} fill={b.fill} />
                            <text x={0} y={b.baseline * geo.h} textAnchor="middle" fill={b.ink} transform={`scale(${squeeze} 1)`}
                              style={{ font: `${b.font * geo.h}px ${FONT_FAMILY}, "Arial Black", sans-serif` }}>{badgeText(local)}</text>
                          </>
                        );
                      })()}
                      {/* the handle: drag to move, arrows to nudge (Shift = bigger steps) */}
                      <rect x={-geo.w / 2 - 3} y={-geo.h / 2 - 3} width={geo.w + 6} height={geo.h + 6} fill="transparent"
                        stroke={drag ? "var(--core)" : "rgba(255,255,255,0.55)"} strokeDasharray="6 4" strokeWidth={1.5}
                        vectorEffect="non-scaling-stroke" tabIndex={disabled ? -1 : 0} role="slider" aria-label={t("Badge position (drag, or use the arrow keys)")}
                        aria-valuetext={`x ${Math.round(b.x * 100)}%, y ${Math.round(b.y * 100)}%`}
                        style={{ cursor: disabled ? "default" : drag ? "grabbing" : "grab", pointerEvents: "all", outline: "none" }}
                        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={nudge} />
                    </g>
                  </svg>
                )}
                {!sameFrame && <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--bright)" }}>{t("Rendering…")}</div>}
              </>
            ) : (
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 20, textAlign: "center" }}>
                <span className="muted" style={{ maxWidth: 380, lineHeight: 1.5 }}>{t("Add a picture: it is copied into the project and cropped to the size you choose.")}</span>
                {isDesktop() && <button className="btn" disabled={disabled} onClick={choosePicture}>{t("Add picture…")}</button>}
              </div>
            )}
          </div>
          <div className="muted" style={{ fontSize: 11.5, marginTop: 6, display: "flex", gap: 10, flexWrap: "wrap" }}>
            <span className="mono">{local.width} × {local.height} · {local.format.toUpperCase()}</span>
            <span>{b.enabled ? t("drag the badge to move it · arrow keys nudge it") : t("no badge")}</span>
            {busy && <span>{t("saving…")}</span>}
          </div>
        </div>

        {/* settings */}
        <div style={{ flex: "0 1 300px", minWidth: 240, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="field"><span>{t("Picture")}</span>
            <span style={{ display: "flex" }}>
              <input className="input mono" style={{ flex: "1 1 auto", minWidth: 0, fontSize: 11, borderRight: isDesktop() ? 0 : undefined }} readOnly
                value={local.image ? basename(local.image) : ""} placeholder={t("not added")} title={local.image ?? ""} />
              {isDesktop() && <button className="btn" style={{ height: 34 }} disabled={disabled} onClick={choosePicture}>{local.image ? t("Change…") : t("Add…")}</button>}
            </span>
          </div>

          <label className="field"><span>{t("Size")}</span>
            <select className="select" value={preset} disabled={disabled} onChange={(e) => {
              if (e.target.value === "custom") return setCustom(true);
              setCustom(false);
              const [w, h] = e.target.value.split("x").map(Number);
              change({ width: w, height: h }, true);
            }}>
              {st.presets.map((p) => <option key={`${p.width}x${p.height}`} value={`${p.width}x${p.height}`}>{p.width} × {p.height}{sizeName(p.width, p.height) ? ` — ${sizeName(p.width, p.height)}` : ""}</option>)}
              <option value="custom">{t("Custom…")}</option>
            </select>
          </label>
          {custom && (
            <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <NumberBox label={t("Width, px")} value={local.width} min={16} max={8192} disabled={disabled} onCommit={(v) => change({ width: v }, true)} />
              <span className="muted">×</span>
              <NumberBox label={t("Height, px")} value={local.height} min={16} max={8192} disabled={disabled} onCommit={(v) => change({ height: v }, true)} />
            </span>
          )}

          <div className="field"><span>{t("Format")}</span>
            <div role="radiogroup" aria-label={t("Format")} className="seg">
              {(["jpg", "png"] as const).map((f) => (
                <button key={f} role="radio" aria-checked={local.format === f} disabled={disabled} onClick={() => change({ format: f }, true)}>{f.toUpperCase()}</button>
              ))}
            </div>
            <span className="muted" style={{ fontSize: 11 }}>{t("YouTube accepts thumbnails up to 2 MB — JPG always fits.")}</span>
          </div>

          <label className="field"><span>{t("Episode number")}{needsNumber && <span style={{ color: "var(--question)" }}> *</span>}</span>
            <input className="input mono" type="number" min={0} value={local.episode ?? ""} disabled={disabled} style={{ width: 120 }}
              onChange={(e) => change({ episode: e.target.value === "" ? null : parseInt(e.target.value, 10) })} />
          </label>

          <label className="check"><input type="checkbox" checked={b.enabled} disabled={disabled} onChange={(e) => change({ badge: { enabled: e.target.checked } }, true)} />{t("Badge with the episode number")}</label>
          {b.enabled && (
            <>
              <label className="field"><span>{t("Badge text · {n} = episode number")}</span>
                <input className="input" value={b.text} disabled={disabled} onChange={(e) => change({ badge: { text: e.target.value } })} />
              </label>
              <span style={{ display: "flex", gap: 10 }}>
                <Color label={t("Badge colour")} value={b.fill} disabled={disabled} onChange={(v) => change({ badge: { fill: v } })} />
                <Color label={t("Text colour")} value={b.ink} disabled={disabled} onChange={(v) => change({ badge: { ink: v } })} />
              </span>
              <Slider label={t("Size")} value={b.height} min={0.03} max={0.4} step={0.001} disabled={disabled}
                show={(v) => `${Math.round(v * 100)}%`}
                onChange={(v) => change({ badge: { height: v, width: +(b.width * (v / b.height)).toFixed(4) } })} />
              <Slider label={t("Width")} value={b.width} min={0.05} max={2} step={0.001} disabled={disabled}
                show={(v) => `${Math.round((v / b.height) * 10) / 10}:1`} onChange={(v) => change({ badge: { width: v } })} />
              <Slider label={t("Tilt")} value={b.angle} min={-45} max={45} step={0.5} disabled={disabled}
                show={(v) => `${v > 0 ? "+" : ""}${v}°`} onChange={(v) => change({ badge: { angle: v } })} />
            </>
          )}
        </div>
      </div>
      {err && <div className="banner error" role="alert" style={{ fontSize: 12 }}>{translateError(err)}</div>}
    </div>
  );
}

function translateError(e: string): string {
  if (e.includes("add a picture")) return t("Add a picture for the thumbnail first.");
  if (e.includes("episode number is needed")) return t("Enter the episode number — the badge text uses {n}.");
  return e;
}

function NumberBox({ label, value, min, max, disabled, onCommit }: { label: string; value: number; min: number; max: number; disabled: boolean; onCommit: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const commit = () => {
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n >= min && n <= max && n !== value) onCommit(n);
    else setV(String(value));
  };
  return <input className="input mono" aria-label={label} title={label} type="number" min={min} max={max} value={v} disabled={disabled} style={{ width: 90 }}
    onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />;
}

function Slider({ label, value, min, max, step, disabled, show, onChange }: { label: string; value: number; min: number; max: number; step: number; disabled: boolean; show: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <div className="field"><span>{label}</span>
      <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <input type="range" aria-label={label} min={min} max={max} step={step} value={value} disabled={disabled} style={{ flex: "1 1 auto" }}
          onChange={(e) => onChange(parseFloat(e.target.value))} />
        <span className="mono" style={{ width: 52, textAlign: "right", fontSize: 12, color: "var(--bright)" }}>{show(value)}</span>
      </span>
    </div>
  );
}

function Color({ label, value, disabled, onChange }: { label: string; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <label className="field" style={{ flex: "1 1 0", minWidth: 0 }}><span>{label}</span>
      <span style={{ display: "flex", minWidth: 0 }}>
        <input type="color" aria-label={label} value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff"} disabled={disabled}
          onChange={(e) => onChange(e.target.value)} style={{ width: 34, height: 34, padding: 0, border: "1px solid var(--border)", borderRight: 0, background: "var(--raised)", borderRadius: 0 }} />
        <input className="input mono" value={text} disabled={disabled} style={{ flex: "1 1 auto", minWidth: 0, width: 0, fontSize: 11.5 }} aria-label={`${label} (hex)`}
          onChange={(e) => { setText(e.target.value); if (/^#[0-9a-f]{6}$/i.test(e.target.value)) onChange(e.target.value); }}
          onBlur={() => setText(value)} />
      </span>
    </label>
  );
}
