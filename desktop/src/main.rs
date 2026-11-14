#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod server;

use std::sync::Mutex;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

#[derive(Default)]
struct ServerState(Mutex<server::Server>);

fn fail(app: &tauri::AppHandle, message: String) {
    eprintln!("{message}");
    let handle = app.clone();
    app.dialog()
        .message(message)
        .title("AgentGlim")
        .kind(MessageDialogKind::Error)
        .show(move |_| handle.exit(1));
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ServerState::default())
        .setup(|app| {
            #[cfg(unix)]
            {
                use signal_hook::{
                    consts::{SIGINT, SIGTERM},
                    iterator::Signals,
                };
                let mut signals = Signals::new([SIGINT, SIGTERM])?;
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    if signals.forever().next().is_some() {
                        handle.exit(0);
                    }
                });
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let result = (|| -> Result<(), String> {
                    let resources = handle.path().resource_dir().map_err(|e| e.to_string())?;
                    handle
                        .state::<ServerState>()
                        .0
                        .lock()
                        .unwrap()
                        .start(&resources)?;
                    WebviewWindowBuilder::new(
                        &handle,
                        "main",
                        WebviewUrl::External(server::URL.parse().unwrap()),
                    )
                    .title("AgentGlim")
                    .inner_size(1440.0, 960.0)
                    .min_inner_size(800.0, 600.0)
                    .on_navigation(|url| {
                        url.scheme() == "http"
                            && url.host_str() == Some("127.0.0.1")
                            && url.port() == Some(18990)
                    })
                    .build()
                    .map_err(|e| e.to_string())?;
                    Ok(())
                })();
                if let Err(message) = result {
                    handle.state::<ServerState>().0.lock().unwrap().stop();
                    fail(&handle, message);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Could not initialize AgentGlim");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            handle.state::<ServerState>().0.lock().unwrap().stop();
        }
    });
}
