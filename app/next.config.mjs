/** Static export: Tauri serves the files from ./out — no Node server at runtime. */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  devIndicators: false,
  reactStrictMode: true,
};

export default nextConfig;
