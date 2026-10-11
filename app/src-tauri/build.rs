fn main() {
    // Bundled resources (see tauri.conf.json → bundle.resources). CI stages them before `tauri build`
    // (scripts/stage-engine.mjs + uv/ffmpeg downloads); for `tauri dev` and `cargo check` empty folders are enough.
    for dir in ["resources/engine", "resources/bin"] {
        let _ = std::fs::create_dir_all(dir);
    }
    tauri_build::build()
}
