import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

/** Static export: Tauri serves the files from ./out — no Node server at runtime. */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  devIndicators: false,
  reactStrictMode: true,
  env: { NEXT_PUBLIC_APP_VERSION: version },
};

export default nextConfig;
