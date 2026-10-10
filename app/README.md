# app

Desktop UI — Tauri v2 + Next.js (static export). Talks to the local engine API (`holos serve`).

```powershell
# terminal 1 — engine
cd engine
uv sync --extra asr --extra gpu
uv run holos serve --dev

# terminal 2 — app
cd app
npm install
npm run tauri dev
```

`npm run dev` runs the UI in a browser at http://localhost:3000 (paste file paths instead of drag & drop).
Design: [../docs/DESIGN.md](../docs/DESIGN.md).
