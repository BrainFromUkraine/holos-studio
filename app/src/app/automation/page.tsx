"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { EngineBanner, useEngine } from "@/components/Shell";
import { currentProject, engine, type Automation } from "@/lib/engine";
import { fmtEp } from "@/lib/resultmap";
import { t, useLang } from "@/lib/i18n";

// labels are built at render time so they follow the interface language
const kinds = (): [string, string][] => [
  ["repeat", t("Repeats within a file")],
  ["retake", t("Retakes across files")],
  ["filler", t("Fillers (um, uh)")],
  ["fragment", t("Fragments")],
  ["unclear", t("Unclear speech")],
];

const voice = (): [string, string, string][] => [
  ["highpass", t("Low cut"), t("75 Hz")],
  ["declick", t("Digital clicks"), "de-click"],
  ["eq", t("Voice EQ"), t("−2 dB at 350 Hz · +2 dB at 3.2 kHz")],
  ["deess", t("De-esser"), t("up to −8 dB")],
  ["compressor", t("Compressor"), t("voice")],
];

const presets = (): [number, string][] => [[-16, t("Podcast")], [-14, "YouTube"], [-23, t("Broadcast")]];

export default function AutomationPage() {
  useLang();
  const { health } = useEngine();
  const [scope, setScope] = useState<"project" | "defaults">("project");
  const [path, setPath] = useState<string | null>(null);
  const [a, setA] = useState<Automation | null>(null);
  const [len, setLen] = useState<{ before: number | null; now: number | null }>({ before: null, now: null });
  const [stats, setStats] = useState<{ pauses: number; breaths: number }>({ pauses: 0, breaths: 0 });
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<Partial<Automation>>({});

  useEffect(() => {
    const sc = new URLSearchParams(window.location.search).get("scope") === "defaults" ? "defaults" : "project";
    setScope(sc);
    const p = currentProject.get();
    setPath(p);
    if (!health) return;
    if (sc === "defaults" || !p) {
      engine.automationDefaults().then(setA).catch((e) => setErr(String(e.message ?? e)));
    } else {
      engine.timeline(p).then((t) => {
        setA(t.automation);
        setLen({ before: t.length, now: t.length });
        setStats({ pauses: t.edits.filter((e) => e.type === "pause" && e.status === "accepted").length, breaths: t.edits.filter((e) => e.type === "gain").length });
      }).catch((e) => setErr(String(e.message ?? e)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(health)]);

  const change = (patch: Partial<Automation>, immediate = true) => {
    if (!a) return;
    const next = { ...a, ...patch, kinds: { ...a.kinds, ...(patch.kinds ?? {}) }, voice: { ...a.voice, ...(patch.voice ?? {}) } };
    setA(next);
    setMsg(null);
    if (scope === "defaults" || !path) return;
    pending.current = { ...pending.current, ...patch, kinds: { ...(pending.current.kinds ?? {}), ...(patch.kinds ?? {}) }, voice: { ...(pending.current.voice ?? {}), ...(patch.voice ?? {}) } };
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      const changes = pending.current;
      pending.current = {};
      try {
        const tl = await engine.setAutomation(path, changes);
        setA(tl.automation);
        setLen((l) => ({ ...l, now: tl.length }));
        setStats({ pauses: tl.edits.filter((e) => e.type === "pause" && e.status === "accepted").length, breaths: tl.edits.filter((e) => e.type === "gain").length });
        setMsg("Applied"); // English key, translated when shown
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    }, immediate ? 50 : 600);
  };

  const saveDefaults = async () => {
    if (!a) return;
    try {
      await engine.saveAutomationDefaults(a);
      setMsg("Saved as the default for new projects"); // English key, translated when shown
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const radio = (on: boolean) => (on ? "true" : "false");

  return (
    <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 18, maxWidth: 1360 }}>
      <EngineBanner />
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>{t("Automation")}{scope === "defaults" ? ` · ${t("default for new projects")}` : ""}</h1>
        {scope === "project" && len.now !== null && (
          <span className="mono muted">{t("duration")} {fmtEp(len.before)} → <span style={{ color: "var(--bright)" }}>{fmtEp(len.now)}</span></span>
        )}
        <span style={{ marginLeft: "auto" }}>
          {scope === "project" ? <Link href="/edit/" style={{ color: "var(--core)" }}>← {t("Back to the editor")}</Link> : <Link href="/new/" style={{ color: "var(--core)" }}>← {t("Back to the new project")}</Link>}
        </span>
      </div>
      <p className="muted" style={{ margin: 0, lineHeight: 1.6, maxWidth: 820 }}>
        {t("What the app does by itself as soon as you import recordings.")}{scope === "project" ? ` ${t("Changes here recalculate the episode straight away — you can still adjust each case in the editor, and your manual edits are never overwritten.")}` : ""}
      </p>
      {err && <div className="banner error" role="alert">{err}</div>}
      {!a ? <div className="muted">{t("Loading…")}</div> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 14 }}>
          <section className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }} aria-labelledby="p-h">
            <label className="check"><input type="checkbox" checked={a.pauses} onChange={(e) => change({ pauses: e.target.checked })} /><span id="p-h" style={{ fontSize: 15, fontWeight: 600 }}>{t("Pauses")}</span>
              {scope === "project" && <span className="mono muted" style={{ marginLeft: "auto", fontSize: 11 }}>{t("{n} shortened", { n: stats.pauses })}</span>}</label>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", lineHeight: 2, opacity: a.pauses ? 1 : 0.5 }}>
              {t("Longer than")}
              <input className="input mono" type="number" step={0.1} min={0.4} max={5} aria-label={t("Pause threshold, s")} value={a.pause_max} disabled={!a.pauses}
                onChange={(e) => change({ pause_max: Number(e.target.value) }, false)} style={{ width: 64, textAlign: "center" }} />
              {t("s, shorten to")}
              <input className="input mono" type="number" step={0.1} min={0.2} max={3} aria-label={t("Length after shortening, s")} value={a.pause_target} disabled={!a.pauses}
                onChange={(e) => change({ pause_target: Number(e.target.value) }, false)} style={{ width: 64, textAlign: "center" }} />
              {t("s")}
            </div>
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>{t("Cuts in the middle of the silence with a crossfade, so the rhythm of speech stays natural.")}</div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }} className="muted">{t("Crossfade at splices")}
              <input type="range" min={10} max={150} step={5} value={a.crossfade_ms} onChange={(e) => change({ crossfade_ms: Number(e.target.value) }, false)} style={{ flex: "1 1 auto" }} />
              <span className="mono" style={{ color: "var(--text)", width: 50, textAlign: "right" }}>{t("{n} ms", { n: a.crossfade_ms })}</span></label>
          </section>

          <section className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }} aria-labelledby="c-h">
            <label className="check"><input type="checkbox" checked={a.clicks !== "off"} onChange={(e) => change({ clicks: e.target.checked ? "normal" : "off" })} /><span id="c-h" style={{ fontSize: 15, fontWeight: 600 }}>{t("Mouth clicks")}</span></label>
            <div role="radiogroup" aria-label={t("Sensitivity")} className="seg" style={{ opacity: a.clicks === "off" ? 0.5 : 1 }}>
              {([["light", t("Light")], ["normal", t("Normal")], ["strong", t("Strong")]] as [Automation["clicks"], string][]).map(([v, l]) => (
                <button key={v} role="radio" aria-checked={radio(a.clicks === v)} disabled={a.clicks === "off"} onClick={() => change({ clicks: v })}>{l}</button>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>{t("Finds short isolated clicks and paints over only their high frequencies — nothing is cut and the duration doesn’t change.")}</div>
          </section>

          <section className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }} aria-labelledby="b-h">
            <label className="check"><input type="checkbox" checked={a.breaths !== "off"} onChange={(e) => change({ breaths: e.target.checked ? "duck" : "off" })} /><span id="b-h" style={{ fontSize: 15, fontWeight: 600 }}>{t("Breaths")}</span>
              {scope === "project" && <span className="mono muted" style={{ marginLeft: "auto", fontSize: 11 }}>{t("{n} in this episode", { n: stats.breaths })}</span>}</label>
            <div role="radiogroup" aria-label={t("What to do with breaths")} className="seg" style={{ opacity: a.breaths === "off" ? 0.5 : 1 }}>
              <button role="radio" aria-checked={radio(a.breaths === "duck")} disabled={a.breaths === "off"} onClick={() => change({ breaths: "duck" })}>{t("Reduce")}</button>
              <button role="radio" aria-checked={radio(a.breaths === "cut")} disabled={a.breaths === "off"} onClick={() => change({ breaths: "cut" })}>{t("Remove")}</button>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, opacity: a.breaths === "duck" ? 1 : 0.5 }} className="muted">{t("By")}
              <input type="range" min={-30} max={-3} value={a.breath_db} disabled={a.breaths !== "duck"} onChange={(e) => change({ breath_db: Number(e.target.value) }, false)} style={{ flex: "1 1 auto" }} />
              <span className="mono" style={{ color: "var(--text)", width: 52, textAlign: "right" }}>{a.breath_db} dB</span></label>
            <div className="muted" style={{ fontSize: 12 }}>{t("“Remove” brings them down to room tone, with no hole in the sound.")}</div>
          </section>

          <section className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }} aria-labelledby="r-h">
            <span id="r-h" style={{ fontSize: 15, fontWeight: 600 }}>{t("Repeats, retakes, fragments")}</span>
            {kinds().map(([k, l]) => (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ flex: "1 1 auto" }}>{l}</span>
                <div role="radiogroup" aria-label={l} className="seg" style={{ flex: "0 0 190px" }}>
                  <button role="radio" aria-checked={radio(a.kinds[k] === "cut")} onClick={() => change({ kinds: { [k]: "cut" } })}>{t("Cut")}</button>
                  <button role="radio" aria-checked={radio(a.kinds[k] !== "cut")} onClick={() => change({ kinds: { [k]: "keep" } })}>{t("Keep")}</button>
                </div>
              </div>
            ))}
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>{t("Each cut shows up in the editor as a splice — you can listen to it and restore it.")}</div>
          </section>

          <section className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }} aria-labelledby="l-h">
            <span id="l-h" style={{ fontSize: 15, fontWeight: 600 }}>{t("Loudness")}</span>
            <div role="radiogroup" aria-label={t("Loudness preset")} className="seg">
              {presets().map(([v, l]) => (
                <button key={v} role="radio" aria-checked={radio(a.target_lufs === v)} style={{ minHeight: 50 }} onClick={() => change({ target_lufs: v })}>
                  {l}<br /><span className="mono" style={{ fontSize: 11, color: "var(--text2)" }}>{v} LUFS</span>
                </button>
              ))}
            </div>
            <div className="mono" style={{ fontSize: 12, color: "var(--text2)" }}>{t("true peak ceiling −2 dBTP")}</div>
            <label className="check"><input type="checkbox" checked={a.level_match} onChange={(e) => change({ level_match: e.target.checked })} />{t("Match levels across files")}</label>
            <label className="check"><input type="checkbox" checked={a.fill_dropouts} onChange={(e) => change({ fill_dropouts: e.target.checked })} />{t("Fill drop-outs with room tone")}</label>
          </section>

          <section className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }} aria-labelledby="v-h">
            <span id="v-h" style={{ fontSize: 15, fontWeight: 600 }}>{t("Voice processing")}</span>
            {voice().map(([k, l, v]) => (
              <label key={k} className="check" style={{ padding: "3px 0" }}>
                <input type="checkbox" checked={a.voice[k] !== false} onChange={(e) => change({ voice: { [k]: e.target.checked } })} />
                <span style={{ flex: "1 1 auto" }}>{l}</span><span className="mono muted" style={{ fontSize: 11 }}>{v}</span>
              </label>
            ))}
            <div className="check" style={{ padding: "3px 0", cursor: "default" }}><input type="checkbox" checked disabled readOnly /><span style={{ flex: "1 1 auto" }}>{t("Limiter")}</span><span className="mono muted" style={{ fontSize: 11 }}>−2 dBTP</span></div>
          </section>
        </div>
      )}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {scope === "project" && path ? (
          <>
            <Link href="/edit/" className="btn primary" style={{ height: 44, display: "flex", alignItems: "center", padding: "0 22px", textDecoration: "none" }}>{t("Done — back to the editor")}</Link>
            <button className="btn" style={{ height: 44 }} onClick={saveDefaults} disabled={!a}>{t("Save as default for new projects")}</button>
          </>
        ) : (
          <button className="btn primary" style={{ height: 44, padding: "0 22px" }} onClick={saveDefaults} disabled={!a}>{t("Save defaults")}</button>
        )}
        {msg && <span style={{ color: "var(--core)" }} role="status">{t(msg)}</span>}
      </div>
    </div>
  );
}
