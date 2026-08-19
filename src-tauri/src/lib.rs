use base64::Engine;
use serde::Serialize;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, RunEvent};

// Max size for a single inlined image. Larger files are left as-is (the
// reference stays relative and simply fails to load, same as before) to keep
// the data URI payload — and webview memory — bounded.
const MAX_INLINE_BYTES: u64 = 5 * 1024 * 1024;

fn mime_for(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "svg" => Some("image/svg+xml"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

// Rewrites `![alt](relative.png)` image references in raw markdown to
// self-contained `data:` URIs by reading the file from disk relative to the
// markdown's own directory. This is the only cross-platform way to render local
// images: the webview resolves relative paths against tauri://localhost (not
// the .md's folder), and under iOS/MAS sandboxing std::fs cannot read a
// sibling path picked via a security-scoped URL. Inlining sidesteps both.
//
// Left untouched (returned verbatim): absolute URLs (http/https), existing
// data: URIs, and paths that fail to read or exceed MAX_INLINE_BYTES.
fn inline_images(markdown: &str, base_dir: &Path) -> String {
    use regex::Regex;
    // ![alt](url "optional title")  — capture alt, url (no spaces/parens), title tail
    let re = Regex::new(r#"(!\[[^\]]*\]\()([^)\s]+)(\s+"[^"]*")?(\))"#).unwrap();
    re.replace_all(markdown, |caps: &regex::Captures| {
        let open = &caps[1];
        let url = &caps[2];
        let title = caps.get(3).map(|m| m.as_str()).unwrap_or("");
        let close = &caps[4];

        let lower = url.to_ascii_lowercase();
        if lower.starts_with("http://")
            || lower.starts_with("https://")
            || lower.starts_with("data:")
        {
            return format!("{}{}{}{}", open, url, title, close);
        }

        let candidate = {
            let p = Path::new(url);
            if p.is_absolute() {
                p.to_path_buf()
            } else {
                base_dir.join(p)
            }
        };

        let ext = candidate
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        let Some(mime) = mime_for(ext) else {
            return format!("{}{}{}{}", open, url, title, close);
        };

        let ok_size = std::fs::metadata(&candidate)
            .map(|m| m.len() <= MAX_INLINE_BYTES)
            .unwrap_or(false);
        if !ok_size {
            return format!("{}{}{}{}", open, url, title, close);
        }

        match std::fs::read(&candidate) {
            Ok(bytes) => {
                let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                format!("{}data:{};base64,{}{}{}", open, mime, b64, title, close)
            }
            Err(_) => format!("{}{}{}{}", open, url, title, close),
        }
    })
    .into_owned()
}

#[cfg(mobile)]
fn parent_dir_of(path: &str) -> PathBuf {
    PathBuf::from(path)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

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
fn read_md_with_assets(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let text = std::fs::read_to_string(&p).map_err(|e| format!("failed to read {}: {}", path, e))?;
    let base = p.parent().map(|d| d.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
    Ok(inline_images(&text, &base))
}

#[derive(Clone, Serialize)]
struct MdEntry {
    name: String,
    path: String,
}

fn is_markdown_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".md")
        || lower.ends_with(".markdown")
        || lower.ends_with(".mdown")
        || lower.ends_with(".mkd")
}

// Scans a directory (one level, non-recursive) for markdown files and returns
// them sorted by name. Used on iOS after the user picks a folder: the security-
// scoped folder URL is readable in place, so we enumerate its *.md files and let
// the frontend present a picker. Cross-platform: desktop can reuse it too.
#[tauri::command]
fn list_markdown_in_dir(dir: String) -> Result<Vec<MdEntry>, String> {
    let base = PathBuf::from(&dir);
    let read = std::fs::read_dir(&base).map_err(|e| format!("failed to read dir {}: {}", dir, e))?;
    let mut entries: Vec<MdEntry> = Vec::new();
    for item in read.flatten() {
        let path = item.path();
        if !path.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if is_markdown_name(&name) {
            entries.push(MdEntry {
                name,
                path: path.to_string_lossy().to_string(),
            });
        }
    }
    entries.sort_by(|a, b| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()));
    Ok(entries)
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
        Ok((content, base_dir)) => {
            let inlined = inline_images(&content, &base_dir);
            let _ = app.emit(
                "md-loaded",
                MdLoaded {
                    path: path_string,
                    content: inlined,
                },
            );
        }
        Err(e) => {
            let _ = app.emit("md-error", format!("failed to read {}: {}", path_string, e));
        }
    }
}

#[cfg(mobile)]
fn read_file_path(fp: &tauri_plugin_dialog::FilePath) -> Result<(String, PathBuf), String> {
    match fp.clone().into_path() {
        Ok(pb) => {
            let base = pb.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
            let content = std::fs::read_to_string(&pb).map_err(|e| e.to_string())?;
            Ok((content, base))
        }
        Err(_) => {
            let s = fp.to_string();
            let base = parent_dir_of(&s);
            let content = std::fs::read_to_string(&s).map_err(|e| e.to_string())?;
            Ok((content, base))
        }
    }
}

fn emit_path(app: &AppHandle, path: &Path) {
    let path_string = path.to_string_lossy().to_string();
    match std::fs::read_to_string(path) {
        Ok(content) => {
            let base = path.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from("."));
            let inlined = inline_images(&content, &base);
            let _ = app.emit(
                "md-loaded",
                MdLoaded {
                    path: path_string,
                    content: inlined,
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
        .plugin(tauri_plugin_folder_picker::init())
        .manage(PendingOpen(Mutex::new(argv_paths)));

    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        read_md,
        read_md_with_assets,
        list_markdown_in_dir,
        drain_pending,
        open_md_dialog,
        export_annotations
    ]);
    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        read_md,
        read_md_with_assets,
        list_markdown_in_dir,
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
