#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod clipboard;
mod files;
mod geometry;
mod recovery;

use files::{Document, Files, Result, Tracked, atomic_data, err};
use geometry::Geometry;
use recovery::Recovery;
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
    sync::{
        Mutex, MutexGuard,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct Backend {
    files: Mutex<Files>,
    paths: Mutex<Vec<String>>,
    storage: Mutex<()>,
    geometry: Mutex<Geometry>,
    shown: AtomicBool,
    exiting: AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| "The previous operation was interrupted. Restart Editor.".into())
}

fn config(app: &AppHandle) -> Result<PathBuf> {
    app.path().app_config_dir().map_err(err)
}
fn recovery_dir(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(err)?
        .join("recovery"))
}

fn read_json<T: serde::de::DeserializeOwned>(p: &Path) -> Result<Option<T>> {
    let mut buf = Vec::new();
    match fs::File::open(p) {
        Ok(f) => {
            f.take(65537).read_to_end(&mut buf).map_err(err)?;
        }
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(err(e)),
    }
    if buf.len() > 65536 {
        return Err("Settings file exceeds its size limit.".into());
    }
    serde_json::from_slice(&buf).map(Some).map_err(err)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(err)?
}

#[tauri::command]
async fn load_settings(app: AppHandle) -> Result<Value> {
    blocking(move || {
        Ok(read_json(&config(&app)?.join("settings.json"))?
            .unwrap_or_else(|| serde_json::json!({})))
    })
    .await
}

#[tauri::command]
async fn save_settings(app: AppHandle, settings: Value) -> Result<()> {
    blocking(move || {
        let bytes = serde_json::to_vec(&settings).map_err(err)?;
        if !settings.is_object() || bytes.len() > 65536 {
            return Err("Invalid settings.".into());
        }
        let b = app.state::<Backend>();
        let _guard = lock(&b.storage)?;
        atomic_data(&config(&app)?.join("settings.json"), &bytes)
    })
    .await
}

fn queue(app: &AppHandle, cwd: &Path, args: impl Iterator<Item = PathBuf>) {
    let b = app.state::<Backend>();
    if let (Ok(mut f), Ok(mut paths)) = (b.files.lock(), b.paths.lock()) {
        for arg in args.filter(|p| p.as_os_str() != "--") {
            let p = cwd.join(arg);
            // Return inaccessible paths as well so the interface can report a failure.
            paths.push(
                f.grant(&p)
                    .unwrap_or_else(|_| p.to_string_lossy().into_owned()),
            );
        }
    }
}

#[tauri::command]
fn take_paths(app: AppHandle) -> Result<Vec<String>> {
    Ok(std::mem::take(&mut *lock(&app.state::<Backend>().paths)?))
}

#[tauri::command]
async fn choose_open(app: AppHandle, window: WebviewWindow) -> Result<Vec<String>> {
    let dlg = app.dialog().file().set_parent(&window).set_title("Open");
    blocking(move || {
        let picked = dlg.blocking_pick_files().unwrap_or_default();
        let b = app.state::<Backend>();
        let mut files = lock(&b.files)?;
        picked
            .into_iter()
            .map(|p| files.grant(&p.into_path().map_err(err)?))
            .collect()
    })
    .await
}

#[derive(Serialize)]
struct Target {
    path: String,
    version: Option<String>,
}

#[tauri::command]
async fn choose_save(
    app: AppHandle,
    window: WebviewWindow,
    name: String,
) -> Result<Option<Target>> {
    let name = Path::new(&name)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    let dlg = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_file_name(name)
        .set_title("Save As");
    blocking(move || {
        let Some(p) = dlg.blocking_save_file() else {
            return Ok(None);
        };
        let b = app.state::<Backend>();
        let mut files = lock(&b.files)?;
        let path = files.grant(&p.into_path().map_err(err)?)?;
        let version = files.version(Path::new(&path), false)?;
        Ok(Some(Target { path, version }))
    })
    .await
}

#[tauri::command]
async fn read_file(app: AppHandle, path: String, legacy: Option<bool>) -> Result<Document> {
    blocking(move || {
        lock(&app.state::<Backend>().files)?.read(Path::new(&path), legacy.unwrap_or(false))
    })
    .await
}

#[tauri::command]
async fn write_file(
    app: AppHandle,
    path: String,
    text: String,
    encoding: String,
    eol: String,
    version: Option<String>,
) -> Result<String> {
    blocking(move || {
        lock(&app.state::<Backend>().files)?.write(
            Path::new(&path),
            &text,
            &encoding,
            &eol,
            version.as_deref(),
        )
    })
    .await
}

#[tauri::command]
async fn disk_version(app: AppHandle, path: String) -> Result<Option<String>> {
    blocking(move || lock(&app.state::<Backend>().files)?.version(Path::new(&path), false)).await
}

#[tauri::command]
async fn changed_files(app: AppHandle, files: Vec<Tracked>) -> Result<Vec<String>> {
    blocking(move || {
        let b = app.state::<Backend>();
        let mut f = lock(&b.files)?;
        // An unreadable replacement still requires the editor to suspend autosave.
        Ok(files
            .into_iter()
            .filter_map(|d| {
                let version = f.version(Path::new(&d.path), true);
                (version.as_ref() != Ok(&d.version)).then_some(d.path)
            })
            .collect())
    })
    .await
}

#[tauri::command]
async fn forget_path(app: AppHandle, path: String) -> Result<()> {
    blocking(move || {
        lock(&app.state::<Backend>().files)?.forget(Path::new(&path));
        Ok(())
    })
    .await
}

#[tauri::command]
async fn list_recovery(app: AppHandle) -> Result<Vec<Recovery>> {
    blocking(move || {
        let b = app.state::<Backend>();
        let _guard = lock(&b.storage)?;
        let dir=recovery_dir(&app)?;
        let (entries,damaged)=recovery::list(&dir)?;
        if damaged>0 {
            let _=app.emit("recovery-warning",format!("Could not read {damaged} recovery record(s). The original bytes were kept in {} with a .damaged suffix.",dir.display()));
        }
        Ok(entries)
    })
    .await
}

#[tauri::command]
async fn put_recovery(app: AppHandle, entry: Recovery) -> Result<()> {
    blocking(move || {
        let b = app.state::<Backend>();
        let _guard = lock(&b.storage)?;
        recovery::put(&recovery_dir(&app)?, &entry)
    })
    .await
}

#[tauri::command]
async fn drop_recovery(app: AppHandle, id: String) -> Result<()> {
    blocking(move || {
        let b = app.state::<Backend>();
        let _guard = lock(&b.storage)?;
        recovery::delete(&recovery_dir(&app)?, &id)
    })
    .await
}

#[tauri::command]
fn set_title(window: WebviewWindow, title: String) -> Result<()> {
    window.set_title(&title).map_err(err)
}

#[tauri::command]
fn apply_theme(window: WebviewWindow, theme: String) -> Result<()> {
    let choice = match theme.as_str() {
        "system" => None,
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => return Err("Unknown theme.".into()),
    };
    // GTK exposes some theme settings only at the application level.
    window.app_handle().set_theme(choice);
    let dark = choice.or_else(|| window.theme().ok()) == Some(tauri::Theme::Dark);
    let icon = if dark {
        tauri::include_image!("icons/128x128-white.png")
    } else {
        tauri::include_image!("icons/128x128.png")
    };
    window.set_icon(icon).map_err(err)
}

#[tauri::command]
fn reveal_window(window: WebviewWindow) -> Result<()> {
    window.show().map_err(err)?;
    window
        .state::<Backend>()
        .shown
        .store(true, Ordering::Release);
    window.set_focus().map_err(err)
}

#[tauri::command]
fn finish_exit(window: WebviewWindow) -> Result<()> {
    let b = window.state::<Backend>();
    let mut g = lock(&b.geometry)?;
    geometry::capture(&window, &mut g);
    atomic_data(
        &config(window.app_handle())?.join("window.json"),
        &serde_json::to_vec(&*g).map_err(err)?,
    )?;
    b.exiting.store(true, Ordering::Release);
    window.app_handle().exit(0);
    Ok(())
}

fn main() {
    let mut context = tauri::generate_context!();
    // GDK also uses the program name for WM_CLASS and for Wayland compositors
    // that expose xdg-shell without the GTK application-ID protocol.
    #[cfg(target_os = "linux")]
    gtk::glib::set_prgname(Some(context.config().identifier.as_str()));
    if context.config().identifier == "app.editor.TextEditor.Portable" {
        use sha2::{Digest, Sha256};
        // Keep the portable launcher identity stable, while file-open requests
        // belong to the specific copy that owns this Data folder.
        #[cfg(target_os = "linux")]
        {
            context.config_mut().app.enable_gtk_app_id = false;
        }
        let exe = tauri::process::current_binary(&tauri::Env::default())
            .and_then(fs::canonicalize)
            .expect("Could not locate the portable Editor executable");
        let dir = exe.parent().expect("Editor needs an application directory");
        let hash = Sha256::digest(dir.as_os_str().as_encoded_bytes());
        context.config_mut().identifier.push_str(&format!(".p{}", hex::encode(&hash[..16])));
    }
    tauri::Builder::default()
        .manage(Backend::default())
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // Never run file inspection from the DBus or Windows message loop.
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                queue(
                    &app,
                    Path::new(&cwd),
                    argv.into_iter().skip(1).map(PathBuf::from),
                );
                let _ = app.emit("paths-available", ());
                if let Some(w) = app.get_webview_window("main")
                    && app.state::<Backend>().shown.load(Ordering::Acquire)
                {
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            });
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle();
            fs::create_dir_all(config(handle)?)?;
            fs::create_dir_all(recovery_dir(handle)?)?;
            let win = app.get_webview_window("main").ok_or("No editor window.")?;
            if let Ok(Some(g)) = read_json::<Geometry>(&config(handle)?.join("window.json")) {
                *lock(&app.state::<Backend>().geometry)? = g;
                let _ = geometry::restore(&win, g);
            } else {
                let _ = win.center();
            }
            queue(
                handle,
                &std::env::current_dir()?,
                std::env::args_os().skip(1).map(PathBuf::from),
            );
            Ok(())
        })
        .on_window_event(|win, event| {
            let b = win.state::<Backend>();
            match event {
                WindowEvent::CloseRequested { api, .. }
                    if !b.exiting.load(Ordering::Acquire) && b.shown.load(Ordering::Acquire) =>
                {
                    api.prevent_close();
                    let _ = win.emit("close-requested", ());
                }
                WindowEvent::Moved(_) | WindowEvent::Resized(_)
                    if b.shown.load(Ordering::Acquire) =>
                {
                    if let Some(w) = win.get_webview_window("main")
                        && let Ok(mut g) = b.geometry.try_lock()
                    {
                        geometry::capture(&w, &mut g);
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            take_paths,
            choose_open,
            choose_save,
            read_file,
            write_file,
            disk_version,
            changed_files,
            forget_path,
            list_recovery,
            put_recovery,
            drop_recovery,
            set_title,
            apply_theme,
            reveal_window,
            finish_exit,
            clipboard::read_clipboard,
            clipboard::write_clipboard
        ])
        .run(context)
        .expect("Editor could not start");
}
