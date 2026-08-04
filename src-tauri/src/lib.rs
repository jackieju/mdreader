use serde::Serialize;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, RunEvent};

#[derive(Default)]
pub struct PendingOpen(pub Mutex<Vec<PathBuf>>);

#[derive(Clone, Serialize)]
struct MdLoaded {
    path: String,
    content: String,
}

#[tauri::command]
fn read_md(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    std::fs::read_to_string(&p).map_err(|e| format!("failed to read {}: {}", path, e))
}

#[tauri::command]
fn drain_pending(state: tauri::State<'_, PendingOpen>) -> Vec<String> {
    let Ok(mut q) = state.0.lock() else {
        return Vec::new();
    };
    q.drain(..).map(|p| p.to_string_lossy().to_string()).collect()
}

#[cfg(desktop)]
#[tauri::command]
fn export_annotations(src_path: String, filename: String, content: String) -> Result<String, String> {
    let src = PathBuf::from(&src_path);
    let dir = src
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let out = dir.join(&filename);
    std::fs::write(&out, content.as_bytes())
        .map_err(|e| format!("failed to write {}: {}", out.display(), e))?;
    Ok(out.to_string_lossy().to_string())
}

// Mobile: the source path is security-scoped and its directory is not writable,
// so write into the app document directory (always writable) and return that
// path for the frontend to surface to the user.
#[cfg(mobile)]
#[tauri::command]
fn export_annotations(
    app: AppHandle,
    _src_path: String,
    filename: String,
    content: String,
) -> Result<String, String> {
    let dir = app
        .path()
        .document_dir()
        .map_err(|e| format!("no document dir: {}", e))?;
    let out = dir.join(&filename);
    std::fs::write(&out, content.as_bytes())
        .map_err(|e| format!("failed to write {}: {}", out.display(), e))?;
    Ok(out.to_string_lossy().to_string())
}

#[cfg(mobile)]
#[tauri::command]
fn open_md_dialog(app: AppHandle) {
    use tauri_plugin_dialog::DialogExt;
    let app_handle = app.clone();
    app.dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown", "mdown", "mkd", "txt"])
        .pick_file(move |file_path| {
            let Some(fp) = file_path else { return };
            emit_fp(&app_handle, fp);
        });
}

#[cfg(mobile)]
fn emit_fp(app: &AppHandle, fp: tauri_plugin_dialog::FilePath) {
    let path_string = fp.to_string();
    match read_file_path(&fp) {
        Ok(content) => {
            let _ = app.emit(
                "md-loaded",
                MdLoaded {
                    path: path_string,
                    content,
                },
            );
        }
        Err(e) => {
            let _ = app.emit("md-error", format!("failed to read {}: {}", path_string, e));
        }
    }
}

#[cfg(mobile)]
fn read_file_path(fp: &tauri_plugin_dialog::FilePath) -> Result<String, String> {
    match fp.clone().into_path() {
        Ok(pb) => std::fs::read_to_string(&pb).map_err(|e| e.to_string()),
        Err(_) => std::fs::read_to_string(fp.to_string()).map_err(|e| e.to_string()),
    }
}

fn emit_path(app: &AppHandle, path: &Path) {
    let path_string = path.to_string_lossy().to_string();
    match std::fs::read_to_string(path) {
        Ok(content) => {
            let _ = app.emit(
                "md-loaded",
                MdLoaded {
                    path: path_string,
                    content,
                },
            );
        }
        Err(e) => {
            let _ = app.emit("md-error", format!("failed to read {}: {}", path_string, e));
        }
    }
}

#[cfg(desktop)]
fn open_file_dialog(app: &AppHandle) {
    use tauri_plugin_dialog::DialogExt;
    let app_handle = app.clone();
    app.dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown", "mdown", "mkd", "txt"])
        .pick_file(move |file_path| {
            let Some(fp) = file_path else { return };
            let path_buf = PathBuf::from(fp.to_string());
            emit_path(&app_handle, &path_buf);
        });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(desktop)]
    let argv_paths: Vec<PathBuf> = std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .collect();
    #[cfg(not(desktop))]
    let argv_paths: Vec<PathBuf> = Vec::new();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(PendingOpen(Mutex::new(argv_paths)));

    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        read_md,
        drain_pending,
        open_md_dialog,
        export_annotations
    ]);
    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        read_md,
        drain_pending,
        export_annotations
    ]);

    #[cfg(desktop)]
    let builder = builder.setup(|app| {
        setup_desktop_menu(app)?;
        Ok(())
    });

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building MD Reader");

    app.run(|app_handle, event| {
        if let RunEvent::Opened { urls } = event {
            for url in urls {
                let path_opt = if url.scheme() == "file" {
                    url.to_file_path().ok()
                } else {
                    None
                };
                let Some(path) = path_opt else { continue };
                if app_handle.get_webview_window("main").is_some() {
                    emit_path(app_handle, &path);
                } else if let Some(state) = app_handle.try_state::<PendingOpen>() {
                    if let Ok(mut q) = state.0.lock() {
                        q.push(path);
                    }
                }
            }
        }
    });
}

#[cfg(desktop)]
fn setup_desktop_menu(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let open_item = MenuItemBuilder::with_id("open", "Open…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let close_item = MenuItemBuilder::with_id("close_window", "Close Window")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&open_item)
        .separator()
        .item(&close_item)
        .build()?;

    let app_menu = SubmenuBuilder::new(app, "MD Reader")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &window_menu])
        .build()?;

    app.set_menu(menu)?;

    app.on_menu_event(move |app_handle, event| match event.id().as_ref() {
        "open" => open_file_dialog(app_handle),
        "close_window" => {
            if let Some(win) = app_handle.get_webview_window("main") {
                let _ = win.close();
            }
        }
        _ => {}
    });

    Ok(())
}
