"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { EngineBanner } from "@/components/Shell";
import { currentProject, engine, fmtDuration, fmtTimecode, type Summary } from "@/lib/engine";

const KIND: Record<string, string> = {
  unclear: "Нерозбірливо",
  fragment: "Обірване слово",
  sound: "Звук без слів",
  repeat: "Повтор",
  retake: "Дубль",
  filler: "Паразит",
};

const AUTO_ROWS: { key: string; label: string; color: string }[] = [
  { key: "repeat", label: "Повтори", color: "var(--cut)" },
  { key: "retake", label: "Дублі між файлами", color: "var(--cut)" },
  { key: "filler", label: "Слова-паразити", color: "var(--cut)" },
  { key: "pause", label: "Довгі паузи скорочено", color: "#6a706a" },
  { key: "gain", label: "Вдихи приглушено", color: "var(--breath)" },
  { key: "fill", label: "Провали фону заповнено", color: "var(--dim)" },
];

export default function EditPage() {
  const [path, setPath] = useState<string | null>(null);
  const [s, setS] = useState<Summary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const p = currentProject.get();
    setPath(p);
    if (p) engine.summary(p).then(setS).catch((e) => setErr(String(e.message ?? e)));
  }, []);

  const decide = async (id: string, d: "cut" | "keep") => {
    if (!path) return;
    setBusyId(id);
    try {
      setS(await engine.decide(path, id, d));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const q = s?.questions[0];
      if (!q || (e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "y" || e.key === "Y") decide(q.id, "cut");
      if (e.key === "n" || e.key === "N") decide(q.id, "keep");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!path) {
    return (
      <div className="main" style={{ padding: 20 }}>
        <div className="banner">Проєкт не відкрито. <Link href="/import/">Почніть з імпорту</Link>.</div>
      </div>
    );
  }

  return (
    <div className="main">
      <section style={{ flex: "999 1 560px", minWidth: 0, padding: "18px 20px", display: "flex", flexDirection: "column", gap: 14 }}>
        <EngineBanner />
        {err && <div className="banner error" role="alert">{err}</div>}
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{s?.name ?? "…"}</h1>
          <span className="mono muted">{path}</span>
        </div>
        <div className="panel" style={{ border: "1px solid var(--border)", padding: 16, color: "var(--text2)" }}>
          Таймлайн з доріжками (хвиля, спектр, слова, правки, гучність) — наступний крок. Зараз тут питання до вас і підсумок.
        </div>
        <h2 className="section-title">Питання до вас · {s?.questions.length ?? 0}</h2>
        {s && s.questions.length === 0 && <div className="muted">Питань немає — можна експортувати.</div>}
        {s?.questions.map((q) => (
          <article key={q.id} style={{ border: "1px solid var(--q-border)", background: "var(--q-bg)", padding: 12, display: "flex", flexDirection: "column", gap: 8, maxWidth: 820 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
              <span className="mono" style={{ color: "var(--question)" }}>{fmtTimecode(q.episode_time)} · {KIND[q.kind] ?? q.kind}</span>
              <span className="muted mono">{s.sources.find((x) => x.id === q.source)?.name} · {fmtTimecode(q.start)}</span>
            </div>
            <div style={{ lineHeight: 1.55 }}>
              <span className="muted">…{q.before} </span>
              <mark style={{ background: "#3a2e10", color: "#ffd99a", padding: "0 3px" }}>{q.text}</mark>
              <span className="muted"> {q.after}…</span>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button className="btn cut big" style={{ flex: "1 1 0" }} title="Клавіша Y" disabled={busyId === q.id} onClick={() => decide(q.id, "cut")}>Вирізати</button>
              <button className="btn big" style={{ flex: "1 1 0" }} title="Клавіша N" disabled={busyId === q.id} onClick={() => decide(q.id, "keep")}>Залишити</button>
            </div>
          </article>
        ))}
      </section>

      <aside className="panel" style={{ flex: "0 1 320px", minWidth: 280, borderLeft: "1px solid var(--border)", padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <h2 className="section-title">Зроблено автоматично</h2>
        <table className="table">
          <tbody>
            {AUTO_ROWS.map((r) => (
              <tr key={r.key}>
                <td><span style={{ display: "inline-block", width: 8, height: 8, marginRight: 8, background: r.color }} />{r.label}</td>
                <td className="mono" style={{ textAlign: "right", color: "var(--bright)" }}>{s?.counts[r.key]?.accepted ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mono" style={{ fontSize: 12 }}>Тривалість: {fmtDuration(s?.recorded_s)} → {fmtDuration(s?.edited_s)}</div>
        <Link href="/export/" className="btn primary big" style={{ display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none", marginTop: 8 }}>До експорту</Link>
      </aside>
    </div>
  );
}
