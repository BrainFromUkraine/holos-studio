#!/usr/bin/env node
// Release text from CHANGELOG.md.
//
//   node scripts/release-notes.mjs 0.2.0-beta.1 title     → "Holos Studio 0.2.0 Beta 1"
//   node scripts/release-notes.mjs 0.2.0-beta.1 release   → GitHub release body (English + Ukrainian + download)
//   node scripts/release-notes.mjs 0.2.0-beta.1 app       → Ukrainian part only (shown in the app's update banner)
//
// Fails when CHANGELOG.md has no section for the version — every release needs its notes.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2]?.replace(/^v/, "");
const format = process.argv[3] ?? "release";

if (!version || !["title", "release", "app"].includes(format)) {
  console.error("usage: node scripts/release-notes.mjs <version> [title|release|app]");
  process.exit(1);
}

/** "0.2.0-beta.1" → "0.2.0 Beta 1", "0.3.0-rc.2" → "0.3.0 RC 2", "0.2.0" → "0.2.0". */
export function displayVersion(v) {
  const m = /^(\d+\.\d+\.\d+)(?:-([a-z]+)\.?(\d+)?)?$/i.exec(v);
  if (!m || !m[2]) return v;
  const label = { alpha: "Alpha", beta: "Beta", rc: "RC" }[m[2].toLowerCase()] ?? m[2];
  return `${m[1]} ${label}${m[3] ? ` ${m[3]}` : ""}`;
}

if (format === "title") {
  console.log(`Holos Studio ${displayVersion(version)}`);
  process.exit(0);
}

const text = readFileSync(join(root, "CHANGELOG.md"), "utf8").replace(/\r\n/g, "\n");
const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const head = new RegExp(`^## \\[${esc}\\][^\\n]*\\n`, "m").exec(text);
if (!head) {
  console.error(`CHANGELOG.md has no "## [${version}]" section — write the release notes first.`);
  process.exit(1);
}
const rest = text.slice(head.index + head[0].length);
const next = rest.search(/^## \[/m);
const section = (next === -1 ? rest : rest.slice(0, next)).trim();

/** The body of a "### <name>" subsection. */
function part(name) {
  const m = new RegExp(`^### ${name}\\s*\\n`, "m").exec(section);
  if (!m) return null;
  const after = section.slice(m.index + m[0].length);
  const end = after.search(/^### /m);
  return (end === -1 ? after : after.slice(0, end)).trim();
}

const en = part("English");
const uk = part("Українською");
if (!en || !uk) {
  console.error(`The ${version} section needs both "### English" and "### Українською".`);
  process.exit(1);
}

if (format === "app") {
  console.log(uk);
} else {
  const intro = section.slice(0, section.search(/^### /m)).trim();
  const out = [
    intro,
    "## Download",
    "Windows 10 / 11: **Holos.Studio_*_x64-setup.exe** below (Assets). Installed copies update themselves.",
    "## English",
    en.replace(/^####/gm, "###"),
    "## Українською",
    uk.replace(/^####/gm, "###"),
    "---",
    "Full history: [CHANGELOG.md](https://github.com/BrainFromUkraine/holos-studio/blob/main/CHANGELOG.md)",
  ].filter(Boolean);
  console.log(out.join("\n\n"));
}
