#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod clipboard;
mod desktops;
mod files;
mod geometry;
#[cfg(target_os = "linux")]
mod linux_instance;
mod recovery;
mod updates;

use files::{Document, Files, Result, Tracked, atomic_data, err};
use geometry::Geometry;
use recovery::Recovery;
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
struct Session {
    files: Mutex<Files>,
    launches: Mutex<Vec<Vec<String>>>,
    desktop: Mutex<desktops::Desktop>,
    geometry: Mutex<Geometry>,
    shown: AtomicBool,
    exiting: AtomicBool,
    last_focus: AtomicU64,
}

#[derive(Default)]
struct Backend {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    sequence: AtomicU64,
    storage: Mutex<()>,
    writes: Mutex<()>,
    startup_recovery: Mutex<Option<Result<(Vec<Recovery>, usize)>>>,
}

fn session(window: &WebviewWindow) -> Result<Arc<Session>> {
    lock(&window.state::<Backend>().sessions)?
        .get(window.label())
        .cloned()
        .ok_or_else(|| "The editor window has closed.".into())
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

fn queue(session: &Session, cwd: &Path, args: impl Iterator<Item = PathBuf>) -> Result<bool> {
    let mut pending = lock(&session.launches)?;
    if session.exiting.load(Ordering::Acquire) {
        return Ok(false);
    }
    let mut files = lock(&session.files)?;
    let batch = args
        .filter(|p| p.as_os_str() != "--")
        .map(|arg| {
            let path = cwd.join(arg);
            // Preserve inaccessible paths so the user sees the open error in this window.
            files
                .grant(&path)
                .unwrap_or_else(|_| path.to_string_lossy().into_owned())
        })
        .collect();
    pending.push(batch);
    Ok(true)
}

#[tauri::command]
fn take_launches(window: WebviewWindow) -> Result<Vec<Vec<String>>> {
    Ok(std::mem::take(&mut *lock(&session(&window)?.launches)?))
}

fn destination(app: &AppHandle) -> Result<(desktops::Desktop, Option<WebviewWindow>)> {
    let (reply, decision) = mpsc::sync_channel(1);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let active = desktops::current();
        let chosen = handle
            .webview_windows()
            .into_values()
            .filter_map(|window| {
                let state = session(&window).ok()?;
                if state.exiting.load(Ordering::Acquire) {
                    return None;
                }
                let desktop = *state.desktop.lock().ok()?;
                desktops::contains(
                    &window,
                    desktop,
                    active,
                    state.shown.load(Ordering::Acquire),
                )
                .then(|| (state.last_focus.load(Ordering::Relaxed), window))
            })
            .max_by_key(|(stamp, _)| *stamp)
            .map(|(_, window)| window);
        let _ = reply.send((active, chosen));
    })
    .map_err(err)?;
    decision.recv().map_err(err)
}

fn route(app: &AppHandle, cwd: &Path, args: Vec<String>) -> Result<()> {
    let (desktop, target) = destination(app)?;
    let paths = || args.iter().skip(1).map(PathBuf::from);
    if let Some(window) = target
        && let Ok(state) = session(&window)
        && queue(&state, cwd, paths())?
    {
        app.emit_to(window.label(), "paths-available", ())
            .map_err(err)?;
        if state.shown.load(Ordering::Acquire) {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        return Ok(());
    }
    let backend = app.state::<Backend>();
    let label = format!(
        "editor-{}",
        backend.sequence.fetch_add(1, Ordering::Relaxed)
    );
    let state = Arc::new(Session::default());
    *lock(&state.desktop)? = desktop;
    queue(&state, cwd, paths())?;
    lock(&backend.sessions)?.insert(label.clone(), state);
    let mut config = app.config().app.windows[0].clone();
    config.label = label.clone();
    if let Err(error) =
        tauri::WebviewWindowBuilder::from_config(app, &config).and_then(|builder| builder.build())
    {
        lock(&backend.sessions)?.remove(&label);
        return Err(err(error));
    }
    Ok(())
}

#[tauri::command]
async fn choose_open(app: AppHandle, window: WebviewWindow) -> Result<Vec<String>> {
    let dlg = app.dialog().file().set_parent(&window).set_title("Open");
    blocking(move || {
        let picked = dlg.blocking_pick_files().unwrap_or_default();
        let b = session(&window)?;
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
    // A default extension in the native dialog would change extensionless names.
    let dlg = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_file_name(name)
        .set_title("Save As (file extension optional)");
    blocking(move || {
        let Some(p) = dlg.blocking_save_file() else {
            return Ok(None);
        };
        let b = session(&window)?;
        let mut files = lock(&b.files)?;
        let path = files.grant(&p.into_path().map_err(err)?)?;
        let version = files.version(Path::new(&path), false)?;
        Ok(Some(Target { path, version }))
    })
    .await
}

#[tauri::command]
async fn read_file(window: WebviewWindow, path: String, legacy: Option<bool>) -> Result<Document> {
    blocking(move || {
        lock(&session(&window)?.files)?.read(Path::new(&path), legacy.unwrap_or(false))
    })
    .await
}

#[tauri::command]
async fn write_file(
    window: WebviewWindow,
    path: String,
    text: String,
    encoding: String,
    eol: String,
    version: Option<String>,
    source: Option<String>,
) -> Result<String> {
    blocking(move || {
        let backend = window.state::<Backend>();
        let _guard = lock(&backend.writes)?;
        lock(&session(&window)?.files)?.write(
            Path::new(&path),
            &text,
            &encoding,
            &eol,
            version.as_deref(),
            source.as_deref().map(Path::new),
        )
    })
    .await
}

#[tauri::command]
async fn disk_version(window: WebviewWindow, path: String) -> Result<Option<String>> {
    blocking(move || lock(&session(&window)?.files)?.version(Path::new(&path), false)).await
}

#[tauri::command]
async fn changed_files(window: WebviewWindow, files: Vec<Tracked>) -> Result<Vec<String>> {
    blocking(move || {
        let b = session(&window)?;
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
async fn forget_path(window: WebviewWindow, path: String) -> Result<()> {
    blocking(move || {
        lock(&session(&window)?.files)?.forget(Path::new(&path));
        Ok(())
    })
    .await
}

#[tauri::command]
async fn list_recovery(app: AppHandle, window: WebviewWindow) -> Result<Vec<Recovery>> {
    // Journals from this run can belong to a live window on another desktop.
    // Only the first window offers the previous process's recovery records.
    if window.label() != "main" {
        return Ok(Vec::new());
    }
    blocking(move || {
        let b = app.state::<Backend>();
        let _guard = lock(&b.storage)?;
        let (entries, damaged) = lock(&b.startup_recovery)?.take().transpose()?.unwrap_or_default();
        if damaged > 0 {
            let notice = format!("Could not read {damaged} recovery record(s). The recovery folder contains the original files with a .damaged suffix.");
            let _ = app.emit_to(window.label(), "recovery-warning", notice);
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
    let state = session(&window)?;
    if let Ok(Some(saved)) =
        read_json::<Geometry>(&config(window.app_handle())?.join("window.json"))
    {
        *lock(&state.geometry)? = saved;
        let _ = geometry::restore(&window, saved);
    } else {
        let _ = window.maximize();
    }
    window.show().map_err(err)?;
    state.shown.store(true, Ordering::Release);
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
fn finish_exit(window: WebviewWindow) -> Result<()> {
    let state = session(&window)?;
    let mut saved = *lock(&state.geometry)?;
    geometry::capture(&window, &mut saved);
    atomic_data(
        &config(window.app_handle())?.join("window.json"),
        &serde_json::to_vec(&saved).map_err(err)?,
    )?;
    {
        let pending = lock(&state.launches)?;
        if !pending.is_empty() {
            return Err("A new document was requested while this window was closing. Review it before closing.".into());
        }
        state.exiting.store(true, Ordering::Release);
    }
    // Destroy only the initiating window. Tauri exits after the final window.
    window.destroy().map_err(|error| {
        state.exiting.store(false, Ordering::Release);
        err(error)
    })
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
        context
            .config_mut()
            .identifier
            .push_str(&format!(".p{}", hex::encode(&hash[..16])));
    }
    let (launches, pending) = mpsc::channel();
    #[cfg(target_os = "linux")]
    let _instance = match linux_instance::acquire(&context.config().identifier, launches)
        .expect("Could not route the Editor launch")
    {
        linux_instance::Instance::Forwarded => return,
        linux_instance::Instance::Primary(connection) => connection,
    };
    let builder = tauri::Builder::default().manage(Backend::default());
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(move |_app, argv, cwd| {
        let _ = launches.send((argv, cwd));
    }));
    builder
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle();
            #[cfg(windows)]
            updates::clear_applied(handle);
            fs::create_dir_all(config(handle)?)?;
            fs::create_dir_all(recovery_dir(handle)?)?;
            // Snapshot orphaned journals before any new window can write one.
            *lock(&app.state::<Backend>().startup_recovery)? =
                Some(recovery::list(&recovery_dir(handle)?));
            let first = Arc::new(Session::default());
            *lock(&first.desktop)? = desktops::current();
            queue(
                &first,
                &std::env::current_dir()?,
                std::env::args_os().skip(1).map(PathBuf::from),
            )?;
            lock(&app.state::<Backend>().sessions)?.insert("main".into(), first);
            let handle = handle.clone();
            std::thread::spawn(move || {
                for (args, cwd) in pending {
                    if let Err(error) = route(&handle, Path::new(&cwd), args) {
                        handle
                            .dialog()
                            .message(error)
                            .title("Could not open Editor")
                            .show(|_| {});
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|win, event| {
            let backend = win.state::<Backend>();
            if let WindowEvent::Destroyed = event {
                if let Ok(mut sessions) = backend.sessions.lock() {
                    sessions.remove(win.label());
                }
                return;
            }
            let Some(state) = backend
                .sessions
                .lock()
                .ok()
                .and_then(|s| s.get(win.label()).cloned())
            else {
                return;
            };
            match event {
                WindowEvent::CloseRequested { api, .. }
                    if !state.exiting.load(Ordering::Acquire)
                        && state.shown.load(Ordering::Acquire) =>
                {
                    api.prevent_close();
                    let _ = win.emit_to(win.label(), "close-requested", ());
                }
                WindowEvent::Focused(true) => {
                    if let Ok(mut desktop) = state.desktop.lock() {
                        *desktop = desktops::current();
                    }
                    state.last_focus.store(
                        backend.sequence.fetch_add(1, Ordering::Relaxed),
                        Ordering::Relaxed,
                    );
                }
                WindowEvent::Moved(_) | WindowEvent::Resized(_)
                    if state.shown.load(Ordering::Acquire) =>
                {
                    if let Some(w) = win.get_webview_window(win.label())
                        && let Ok(mut g) = state.geometry.try_lock()
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
            take_launches,
            updates::update_editor,
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
        .build(context)
        .expect("Editor could not start")
        .run(|_handle, _event| {
            #[cfg(windows)]
            if matches!(_event, tauri::RunEvent::Exit) {
                updates::on_exit(_handle);
            }
        });
}
