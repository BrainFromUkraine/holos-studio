// Interface language: English (default) or Ukrainian.
//
// gettext style: the English text IS the key. Write UI text in English and wrap it:
//   t("Export")                       → "Export" / "Експорт"
//   t("Cut {n} s", { n: 2.5 })        → placeholders in {braces}
//   tn("{n} file", "{n} files", n)    → plurals (Ukrainian has three forms: файл / файли / файлів)
// Ukrainian translations live in ./uk/*.ts, one module per area, merged below. A missing translation falls back to
// English (and is reported in the dev console), so nothing ever shows a key instead of text.
//
// Components call useLang() once to re-render when the language changes; t()/tn() are plain functions so they also
// work in helpers (labels, reasons, formatters) and canvas drawing.

import { useSyncExternalStore } from "react";
import { UK } from "./uk";

export type Lang = "en" | "uk";
export const LANGS: { id: Lang; name: string }[] = [
  { id: "en", name: "English" },
  { id: "uk", name: "Українська" },
];

const KEY = "holos.lang";
let current: Lang = "en";
const listeners = new Set<() => void>();

function readStored(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    return v === "uk" ? "uk" : "en";
  } catch {
    return "en";
  }
}
// The stored language is applied after hydration (first subscriber), never at module load: the static HTML is
// English, and the first client render must match it — otherwise React reports a hydration mismatch.
let applied = false;
function applyStored(): void {
  if (applied || typeof window === "undefined") return;
  applied = true;
  const stored = readStored();
  if (stored !== current) queueMicrotask(() => setLang(stored));
}

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(KEY, lang);
  } catch {
    /* private mode: still switches for this session */
  }
  if (typeof document !== "undefined") document.documentElement.lang = lang;
  listeners.forEach((l) => l());
}

/** BCP 47 locale for dates and numbers. */
export function locale(): string {
  return current === "uk" ? "uk-UA" : "en-GB";
}

/** Re-render on language change. Server / first hydration render is English, then the stored language. */
export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      applyStored();
      return () => listeners.delete(cb);
    },
    () => current,
    () => "en",
  );
}

type Vars = Record<string, string | number>;

function fill(s: string, vars?: Vars): string {
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

const missing = new Set<string>();
function lookup(key: string): string | string[] | undefined {
  const v = UK[key];
  if (v === undefined && process.env.NODE_ENV !== "production" && !missing.has(key)) {
    missing.add(key);
    console.warn(`[i18n] no Ukrainian for: ${JSON.stringify(key)}`);
  }
  return v;
}

/** Translate an English UI string. */
export function t(en: string, vars?: Vars): string {
  if (current === "en") return fill(en, vars);
  const v = lookup(en);
  return fill(typeof v === "string" ? v : Array.isArray(v) ? v[0] : en, vars);
}

/** Ukrainian plural form index: 1 файл, 2–4 файли, 5–20 файлів, 21 файл… (fractions use the "few" form). */
function ukForm(n: number): 0 | 1 | 2 {
  if (!Number.isInteger(n)) return 1;
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a >= 11 && a <= 14) return 2;
  if (b === 1) return 0;
  if (b >= 2 && b <= 4) return 1;
  return 2;
}

/** Plural: tn("{n} file", "{n} files", n). The Ukrainian entry for the singular key is [one, few, many]. */
export function tn(one: string, other: string, n: number, vars?: Vars): string {
  const all = { n, ...vars };
  if (current === "en") return fill(n === 1 ? one : other, all);
  const v = lookup(one);
  if (Array.isArray(v)) return fill(v[ukForm(n)] ?? v[v.length - 1], all);
  return fill(typeof v === "string" ? v : n === 1 ? one : other, all);
}
