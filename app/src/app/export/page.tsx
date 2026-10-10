"use client";

import { useEffect, useState } from "react";
import { currentProject } from "@/lib/engine";

export default function ExportPage() {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => setPath(currentProject.get()), []);
  return (
    <div className="main" style={{ padding: 20, flexDirection: "column", gap: 12 }}>
      <h2 className="section-title">Експорт</h2>
      <div className="panel" style={{ border: "1px solid var(--border)", padding: 16, maxWidth: 720, lineHeight: 1.6 }}>
        Екран експорту (формати, пресети гучності, розділи, метадані) — один з наступних кроків.
        Поки що рендер запускається з терміналу:
        <pre className="mono" style={{ margin: "10px 0 0", padding: 10, background: "var(--lane)", border: "1px solid var(--border)", whiteSpace: "pre-wrap" }}>
          {`uv run holos render "${path ?? "episode.holos"}" -o renders`}
        </pre>
      </div>
    </div>
  );
}
