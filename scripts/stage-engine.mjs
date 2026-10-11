#!/usr/bin/env node
// Copy the engine source into app/src-tauri/resources/engine so the installer can ship it.
// Only what `uv sync` needs: pyproject.toml, uv.lock, README.md, LICENSE and src/** — no .venv, tests or caches.
//
//   node scripts/stage-engine.mjs

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const engine = join(root, "engine");
const out = join(root, "app", "src-tauri", "resources", "engine");

const SKIP_DIRS = new Set(["__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".venv", "venv", "tests"]);
const SKIP_EXT = [".pyc", ".pyo"];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const f of ["pyproject.toml", "uv.lock", "README.md"]) {
  cpSync(join(engine, f), join(out, f));
}
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));

let files = 0;
cpSync(join(engine, "src"), join(out, "src"), {
  recursive: true,
  filter: (src) => {
    const name = basename(src);
    if (statSync(src).isDirectory()) return !SKIP_DIRS.has(name) && !name.endsWith(".egg-info");
    if (SKIP_EXT.some((e) => name.endsWith(e))) return false;
    files++;
    return true;
  },
});

if (!existsSync(join(out, "src", "holos", "__init__.py"))) {
  console.error("stage-engine: src/holos/__init__.py missing after copy");
  process.exit(1);
}
console.log(`stage-engine: ${files + 4} files → ${out}`);
