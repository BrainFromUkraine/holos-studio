#!/usr/bin/env node
// Set one version everywhere (app, desktop shell, engine).
//
//   node scripts/bump-version.mjs 0.3.0
//   node scripts/bump-version.mjs 0.3.0-beta.1     (pre-release; Python gets the PEP 440 form 0.3.0b1)
//
// Files: app/package.json (+ package-lock.json), app/src-tauri/tauri.conf.json, app/src-tauri/Cargo.toml
// (+ Cargo.lock), engine/pyproject.toml (+ uv.lock), engine/src/holos/__init__.py.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2]?.replace(/^v/, "");

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: node scripts/bump-version.mjs <X.Y.Z>");
  process.exit(1);
}

/** SemVer → PEP 440 for the Python package: 0.3.0-beta.1 → 0.3.0b1, -alpha.2 → a2, -rc.1 → rc1. */
function pep440(v) {
  const m = /^(\d+\.\d+\.\d+)(?:-(alpha|beta|rc)\.?(\d+))?$/.exec(v);
  if (!m) {
    console.error(`pre-release must be -alpha.N, -beta.N or -rc.N (got ${v})`);
    process.exit(1);
  }
  return m[2] ? `${m[1]}${{ alpha: "a", beta: "b", rc: "rc" }[m[2]]}${m[3]}` : m[1];
}
const pyVersion = pep440(version);

let failed = false;

/** Apply `fn` to a file's text; report and fail if nothing matched. */
function edit(path, fn, { optional = false } = {}) {
  const file = join(root, path);
  if (!existsSync(file)) {
    if (optional) return;
    console.error(`missing: ${path}`);
    failed = true;
    return;
  }
  const before = readFileSync(file, "utf8");
  const after = fn(before);
  if (after === null) {
    console.error(`no version found in ${path}`);
    failed = true;
    return;
  }
  if (after !== before) writeFileSync(file, after);
  console.log(`${after !== before ? "updated " : "unchanged"} ${relative(root, file)}`);
}

/** Replace the first match of `re` (which must capture the old version as group 2 between groups 1 and 3). */
function sub(re, v = version) {
  return (text) => (re.test(text) ? text.replace(re, `$1${v}$3`) : null);
}

function json(path, update) {
  edit(path, (text) => {
    const data = JSON.parse(text);
    update(data);
    return JSON.stringify(data, null, 2) + (text.endsWith("\n") ? "\n" : "");
  });
}

json("app/package.json", (d) => {
  d.version = version;
});
json("app/package-lock.json", (d) => {
  d.version = version;
  if (d.packages?.[""]) d.packages[""].version = version;
});
json("app/src-tauri/tauri.conf.json", (d) => {
  d.version = version;
});
// [package] version — the first `version = "…"` line of the manifest.
edit("app/src-tauri/Cargo.toml", sub(/^(version\s*=\s*")([^"]+)(")/m));
edit("app/src-tauri/Cargo.lock", sub(/(name = "holos-studio"\nversion = ")([^"]+)(")/), { optional: true });
// [project] version
edit("engine/pyproject.toml", sub(/(\[project\][^[]*?\nversion\s*=\s*")([^"]+)(")/, pyVersion));
edit("engine/uv.lock", sub(/(name = "holos-engine"\nversion = ")([^"]+)(")/, pyVersion));
edit("engine/src/holos/__init__.py", sub(/(__version__\s*=\s*")([^"]+)(")/, pyVersion));

if (failed) process.exit(1);
console.log(`\nVersion ${version} (Python ${pyVersion}). Check CHANGELOG.md has a "## [${version}]" section. Next: git commit -am "release: v${version}" && git tag v${version} && git push origin main v${version}`);
