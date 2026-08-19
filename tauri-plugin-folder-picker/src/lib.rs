use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginApi, TauriPlugin},
    AppHandle, Manager, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_folder_picker);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("folder picking is only available on iOS")]
    Unsupported,
    #[error("{0}")]
    Runtime(String),
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FolderResult {
    pub path: String,
    pub bookmark: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolveArgs {
    pub bookmark: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolveResult {
    pub path: String,
}

#[cfg(target_os = "ios")]
pub struct FolderPicker<R: Runtime>(tauri::plugin::PluginHandle<R>);

// PhantomData<fn() -> R> keeps R without borrowing its auto-traits, so the
// desktop stub stays Send + Sync and can be app.manage()'d like the iOS handle.
#[cfg(not(target_os = "ios"))]
pub struct FolderPicker<R: Runtime>(std::marker::PhantomData<fn() -> R>);

impl<R: Runtime> FolderPicker<R> {
    fn clone_handle(&self) -> FolderPicker<R> {
        #[cfg(target_os = "ios")]
        {
            FolderPicker(self.0.clone())
        }
        #[cfg(not(target_os = "ios"))]
        {
            FolderPicker(std::marker::PhantomData)
        }
    }

    #[cfg(target_os = "ios")]
    pub fn pick_folder(&self) -> Result<FolderResult> {
        self.0
            .run_mobile_plugin::<FolderResult>("pickFolder", ())
            .map_err(|e| Error::Runtime(e.to_string()))
    }

    #[cfg(target_os = "ios")]
    pub fn resolve_folder_bookmark(&self, bookmark: String) -> Result<ResolveResult> {
        self.0
            .run_mobile_plugin::<ResolveResult>("resolveFolderBookmark", ResolveArgs { bookmark })
            .map_err(|e| Error::Runtime(e.to_string()))
    }

    #[cfg(not(target_os = "ios"))]
    pub fn pick_folder(&self) -> Result<FolderResult> {
        Err(Error::Unsupported)
    }

    #[cfg(not(target_os = "ios"))]
    pub fn resolve_folder_bookmark(&self, _bookmark: String) -> Result<ResolveResult> {
        Err(Error::Unsupported)
    }
}

// The native picker blocks on user interaction, so run it via spawn_blocking to
// keep the async command runtime free while the folder sheet is open (mirrors
// the dialog plugin's std::thread::spawn pattern).
#[tauri::command]
async fn pick_folder<R: Runtime>(app: AppHandle<R>) -> Result<FolderResult> {
    let picker = app.state::<FolderPicker<R>>().inner().clone_handle();
    tauri::async_runtime::spawn_blocking(move || picker.pick_folder())
        .await
        .map_err(|e| Error::Runtime(e.to_string()))?
}

#[tauri::command]
async fn resolve_folder_bookmark<R: Runtime>(
    app: AppHandle<R>,
    bookmark: String,
) -> Result<ResolveResult> {
    let picker = app.state::<FolderPicker<R>>().inner().clone_handle();
    tauri::async_runtime::spawn_blocking(move || picker.resolve_folder_bookmark(bookmark))
        .await
        .map_err(|e| Error::Runtime(e.to_string()))?
}

fn init_plugin<R: Runtime>(_app: &AppHandle<R>, _api: PluginApi<R, ()>) -> Result<FolderPicker<R>> {
    #[cfg(target_os = "ios")]
    {
        let handle = _api
            .register_ios_plugin(init_plugin_folder_picker)
            .map_err(|e| Error::Runtime(e.to_string()))?;
        Ok(FolderPicker(handle))
    }
    #[cfg(not(target_os = "ios"))]
    {
        Ok(FolderPicker(std::marker::PhantomData))
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("folder-picker")
        .invoke_handler(tauri::generate_handler![
            pick_folder,
            resolve_folder_bookmark
        ])
        .setup(|app, api| {
            let picker = init_plugin(app, api)?;
            app.manage(picker);
            Ok(())
        })
        .build()
}
