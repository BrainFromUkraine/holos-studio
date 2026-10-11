"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { EngineBanner, useEngine } from "@/components/Shell";
import { currentProject, engine, type Automation } from "@/lib/engine";
import { fmtEp } from "@/lib/resultmap";

const KINDS: [string, string][] = [
  ["repeat", "Повтори в одному файлі"],
  ["retake", "Дублі між файлами"],
  ["filler", "Еее, ммм"],
  ["fragment", "Обірвані слова"],
  ["unclear", "Нерозбірливе"],
];

const VOICE: [string, string, string][] = [
  ["highpass", "Зріз низу", "75 Гц"],
  ["declick", "Цифрові клацання", "de-click"],
  ["eq", "Еквалайзер голосу", "−2 dB 350 Гц · +2 dB 3.2 кГц"],
  ["deess", "Де-есер", "до −8 dB"],
  ["compressor", "Компресор", "голос"],
];

const PRESETS: [number, string][] = [[-16, "Подкаст"], [-14, "YouTube"], [-23, "Мовлення"]];

export default function AutomationPage() {
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
        const t = await engine.setAutomation(path, changes);
        setA(t.automation);
        setLen((l) => ({ ...l, now: t.length }));
        setStats({ pauses: t.edits.filter((e) => e.type === "pause" && e.status === "accepted").length, breaths: t.edits.filter((e) => e.type === "gain").length });
        setMsg("Застосовано");
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    }, immediate ? 50 : 600);
  };

  const saveDefaults = async () => {
    if (!a) return;
    try {
      await engine.saveAutomationDefaults(a);
      setMsg("Збережено як стандарт для нових проєктів");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const radio = (on: boolean) => (on ? "true" : "false");

  return (
    <div style={{ padding: "22px 24px", display: "flex", flexDirection: "column", gap: 18, maxWidth: 1360 }}>
      <EngineBanner />
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Автоматика{scope === "defaults" ? " · стандарт для нових проєктів" : ""}</h1>
        {scope === "project" && len.now !== null && (
          <span className="mono muted">тривалість {fmtEp(len.before)} → <span style={{ color: "var(--bright)" }}>{fmtEp(len.now)}</span></span>
        )}
        <span style={{ marginLeft: "auto" }}>
          {scope === "project" ? <Link href="/edit/" style={{ color: "var(--core)" }}>← До редактора</Link> : <Link href="/new/" style={{ color: "var(--core)" }}>← До нового проєкту</Link>}
        </span>
      </div>
      <p className="muted" style={{ margin: 0, lineHeight: 1.6, maxWidth: 820 }}>
        Що програма робить сама, щойно ви імпортували записи.{scope === "project" ? " Зміна тут одразу перераховує епізод — у редакторі можна підправити кожен окремий випадок; ваші ручні правки не перезаписуються." : ""}
      </p>
      {err && <div className="banner error" role="alert">{err}</div>}
      {!a ? <div className="muted">Завантажую…</div> : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 14 }}>
          <section className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }} aria-labelledby="p-h">
            <label className="check"><input type="checkbox" checked={a.pauses} onChange={(e) => change({ pauses: e.target.checked })} /><span id="p-h" style={{ fontSize: 15, fontWeight: 600 }}>Паузи</span>
              {scope === "project" && <span className="mono muted" style={{ marginLeft: "auto", fontSize: 11 }}>скорочено {stats.pauses}</span>}</label>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", lineHeight: 2, opacity: a.pauses ? 1 : 0.5 }}>
              Довші за
              <input className="input mono" type="number" step={0.1} min={0.4} max={5} aria-label="Поріг паузи, с" value={a.pause_max} disabled={!a.pauses}
                onChange={(e) => change({ pause_max: Number(e.target.value) }, false)} style={{ width: 64, textAlign: "center" }} />
              с скорочувати до
              <input className="input mono" type="number" step={0.1} min={0.2} max={3} aria-label="Довжина після скорочення, с" value={a.pause_target} disabled={!a.pauses}
                onChange={(e) => change({ pause_target: Number(e.target.value) }, false)} style={{ width: 64, textAlign: "center" }} />
              с
            </div>
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>Ріже посередині тиші, з кросфейдом — ритм мови лишається природним.</div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }} className="muted">Кросфейд на стиках
              <input type="range" min={10} max={150} step={5} value={a.crossfade_ms} onChange={(e) => change({ crossfade_ms: Number(e.target.value) }, false)} style={{ flex: "1 1 auto" }} />
              <span className="mono" style={{ color: "var(--text)", width: 50, textAlign: "right" }}>{a.crossfade_ms} мс</span></label>
          </section>

          <section className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }} aria-labelledby="c-h">
            <label className="check"><input type="checkbox" checked={a.clicks !== "off"} onChange={(e) => change({ clicks: e.target.checked ? "normal" : "off" })} /><span id="c-h" style={{ fontSize: 15, fontWeight: 600 }}>Клацання слини й губ</span></label>
            <div role="radiogroup" aria-label="Чутливість" className="seg" style={{ opacity: a.clicks === "off" ? 0.5 : 1 }}>
              {([["light", "Легко"], ["normal", "Звичайно"], ["strong", "Сильно"]] as [Automation["clicks"], string][]).map(([v, l]) => (
                <button key={v} role="radio" aria-checked={radio(a.clicks === v)} disabled={a.clicks === "off"} onClick={() => change({ clicks: v })}>{l}</button>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>Знаходить короткі поодинокі клацання й замальовує лише їхні високі частоти — нічого не вирізається, тривалість не змінюється.</div>
          </section>

          <section className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }} aria-labelledby="b-h">
            <label className="check"><input type="checkbox" checked={a.breaths !== "off"} onChange={(e) => change({ breaths: e.target.checked ? "duck" : "off" })} /><span id="b-h" style={{ fontSize: 15, fontWeight: 600 }}>Вдихи</span>
              {scope === "project" && <span className="mono muted" style={{ marginLeft: "auto", fontSize: 11 }}>{stats.breaths} у випуску</span>}</label>
            <div role="radiogroup" aria-label="Що робити з вдихами" className="seg" style={{ opacity: a.breaths === "off" ? 0.5 : 1 }}>
              <button role="radio" aria-checked={radio(a.breaths === "duck")} disabled={a.breaths === "off"} onClick={() => change({ breaths: "duck" })}>Приглушити</button>
              <button role="radio" aria-checked={radio(a.breaths === "cut")} disabled={a.breaths === "off"} onClick={() => change({ breaths: "cut" })}>Прибрати</button>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, opacity: a.breaths === "duck" ? 1 : 0.5 }} className="muted">На
              <input type="range" min={-30} max={-3} value={a.breath_db} disabled={a.breaths !== "duck"} onChange={(e) => change({ breath_db: Number(e.target.value) }, false)} style={{ flex: "1 1 auto" }} />
              <span className="mono" style={{ color: "var(--text)", width: 52, textAlign: "right" }}>{a.breath_db} dB</span></label>
            <div className="muted" style={{ fontSize: 12 }}>«Прибрати» — до рівня тону кімнати, без діри в звуці.</div>
          </section>

          <section className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }} aria-labelledby="r-h">
            <span id="r-h" style={{ fontSize: 15, fontWeight: 600 }}>Повтори, дублі, обірвані фрази</span>
            {KINDS.map(([k, l]) => (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ flex: "1 1 auto" }}>{l}</span>
                <div role="radiogroup" aria-label={l} className="seg" style={{ flex: "0 0 190px" }}>
                  <button role="radio" aria-checked={radio(a.kinds[k] === "cut")} onClick={() => change({ kinds: { [k]: "cut" } })}>Різати</button>
                  <button role="radio" aria-checked={radio(a.kinds[k] !== "cut")} onClick={() => change({ kinds: { [k]: "keep" } })}>Не чіпати</button>
                </div>
              </div>
            ))}
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>Кожен різ видно в редакторі як стик — його можна прослухати й відновити.</div>
          </section>

          <section className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }} aria-labelledby="l-h">
            <span id="l-h" style={{ fontSize: 15, fontWeight: 600 }}>Гучність</span>
            <div role="radiogroup" aria-label="Пресет гучності" className="seg">
              {PRESETS.map(([v, l]) => (
                <button key={v} role="radio" aria-checked={radio(a.target_lufs === v)} style={{ minHeight: 50 }} onClick={() => change({ target_lufs: v })}>
                  {l}<br /><span className="mono" style={{ fontSize: 11, color: "var(--text2)" }}>{v} LUFS</span>
                </button>
              ))}
            </div>
            <div className="mono" style={{ fontSize: 12, color: "var(--text2)" }}>стеля true peak −2 dBTP</div>
            <label className="check"><input type="checkbox" checked={a.level_match} onChange={(e) => change({ level_match: e.target.checked })} />Вирівняти рівень між файлами</label>
            <label className="check"><input type="checkbox" checked={a.fill_dropouts} onChange={(e) => change({ fill_dropouts: e.target.checked })} />Заповнювати провали фону тоном кімнати</label>
          </section>

          <section className="card" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }} aria-labelledby="v-h">
            <span id="v-h" style={{ fontSize: 15, fontWeight: 600 }}>Обробка голосу</span>
            {VOICE.map(([k, l, v]) => (
              <label key={k} className="check" style={{ padding: "3px 0" }}>
                <input type="checkbox" checked={a.voice[k] !== false} onChange={(e) => change({ voice: { [k]: e.target.checked } })} />
                <span style={{ flex: "1 1 auto" }}>{l}</span><span className="mono muted" style={{ fontSize: 11 }}>{v}</span>
              </label>
            ))}
            <div className="check" style={{ padding: "3px 0", cursor: "default" }}><input type="checkbox" checked disabled readOnly /><span style={{ flex: "1 1 auto" }}>Лімітер</span><span className="mono muted" style={{ fontSize: 11 }}>−2 dBTP</span></div>
          </section>
        </div>
      )}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        {scope === "project" && path ? (
          <>
            <Link href="/edit/" className="btn primary" style={{ height: 44, display: "flex", alignItems: "center", padding: "0 22px", textDecoration: "none" }}>Готово — до редактора</Link>
            <button className="btn" style={{ height: 44 }} onClick={saveDefaults} disabled={!a}>Зберегти як стандарт для нових</button>
          </>
        ) : (
          <button className="btn primary" style={{ height: 44, padding: "0 22px" }} onClick={saveDefaults} disabled={!a}>Зберегти стандарт</button>
        )}
        {msg && <span style={{ color: "var(--core)" }} role="status">{msg}</span>}
      </div>
    </div>
  );
}
