const COMMANDS: &[&str] = &["pick_folder", "resolve_folder_bookmark"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .ios_path("ios")
        .build();
}
