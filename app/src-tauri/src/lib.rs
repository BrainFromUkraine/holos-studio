mod engine;
mod winproc;

use tauri::{Manager, RunEvent, WindowEvent};

use engine::EngineManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Debug builds (`tauri dev`) leave the engine to the developer (`uv run holos serve --dev`).
    let dev = cfg!(debug_assertions);

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init());

    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .manage(EngineManager::new(dev))
        .invoke_handler(tauri::generate_handler![engine::engine_info, engine::engine_restart, engine::mcp_config])
        .setup(|app| {
            app.state::<EngineManager>().start(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Holos Studio")
        .run(|app, event| match event {
            // Never leave the engine (or a half-done `uv sync`) running behind a closed window.
            RunEvent::WindowEvent { event: WindowEvent::Destroyed, .. } | RunEvent::Exit => {
                app.state::<EngineManager>().shutdown();
            }
            _ => {}
        });
}
