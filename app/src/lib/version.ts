// App version (from package.json at build time, kept in sync by scripts/bump-version.mjs).

export const APP_VERSION: string = process.env.NEXT_PUBLIC_APP_VERSION ?? "";

/** "0.2.0-beta.1" → "0.2.0 Beta 1", "0.3.0-rc.2" → "0.3.0 RC 2", "0.2.0" → "0.2.0". */
export function displayVersion(v: string): string {
  const m = /^(\d+\.\d+\.\d+)(?:-([a-z]+)\.?(\d+)?)?$/i.exec(v);
  if (!m || !m[2]) return v;
  const label = ({ alpha: "Alpha", beta: "Beta", rc: "RC" } as Record<string, string>)[m[2].toLowerCase()] ?? m[2];
  return `${m[1]} ${label}${m[3] ? ` ${m[3]}` : ""}`;
}

/** "beta" for 0.2.0-beta.1, null for a stable version. */
export function channel(v: string): string | null {
  const m = /-([a-z]+)/i.exec(v);
  return m ? m[1].toLowerCase() : null;
}
