use crate::files::{Result, err};
use tauri::WebviewWindow;

#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn read_clipboard(window: WebviewWindow) -> Result<String> {
    let (send, recv) = tauri::async_runtime::channel(1);
    window
        .run_on_main_thread(move || {
            if let Some(c) = gtk::gdk::Display::default().and_then(|d| gtk::Clipboard::default(&d))
            {
                c.request_text(move |_, s| {
                    let _ = send.try_send(Ok(s.unwrap_or("").into()));
                });
            } else {
                let _ = send.try_send(Err("Clipboard unavailable.".into()));
            }
        })
        .map_err(err)?;
    let mut recv = recv;
    recv.recv().await.ok_or("Clipboard unavailable.")?
}

#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn write_clipboard(window: WebviewWindow, text: String) -> Result<()> {
    let (send, mut recv) = tauri::async_runtime::channel(1);
    window
        .run_on_main_thread(move || {
            let r = gtk::gdk::Display::default()
                .and_then(|d| gtk::Clipboard::default(&d))
                .map(|c| {
                    c.set_text(&text);
                    c.store();
                })
                .ok_or_else(|| "Clipboard unavailable.".into());
            let _ = send.try_send(r);
        })
        .map_err(err)?;
    recv.recv().await.ok_or("Clipboard unavailable.")?
}

#[cfg(windows)]
mod win {
    use super::*;
    use windows_sys::Win32::{
        Foundation::{GlobalFree, HWND},
        System::{
            DataExchange::{
                CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable,
                OpenClipboard, SetClipboardData,
            },
            Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock},
        },
    };
    const UNICODE_TEXT: u32 = 13;
    struct Clipboard;
    impl Clipboard {
        fn open(hwnd: HWND) -> Result<Self> {
            if unsafe { OpenClipboard(hwnd) } == 0 {
                return Err(err(std::io::Error::last_os_error()));
            }
            Ok(Self)
        }
    }
    impl Drop for Clipboard {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }
    #[tauri::command]
    pub fn read_clipboard(window: WebviewWindow) -> Result<String> {
        let _guard = Clipboard::open(window.hwnd().map_err(err)?.0)?;
        unsafe {
            if IsClipboardFormatAvailable(UNICODE_TEXT) == 0 {
                return Ok(String::new());
            }
            let h = GetClipboardData(UNICODE_TEXT);
            if h.is_null() {
                return Err("Could not read the clipboard.".into());
            }
            let n = GlobalSize(h) / 2;
            if n > crate::files::LIMIT {
                return Err("Clipboard text exceeds the editing limit.".into());
            }
            let p = GlobalLock(h) as *const u16;
            if p.is_null() {
                return Err("Could not access clipboard text.".into());
            }
            let units = std::slice::from_raw_parts(p, n);
            let result =
                String::from_utf16(&units[..units.iter().position(|u| *u == 0).unwrap_or(n)])
                    .map_err(err);
            GlobalUnlock(h);
            result
        }
    }
    #[tauri::command]
    pub fn write_clipboard(window: WebviewWindow, text: String) -> Result<()> {
        let data: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
        let _guard = Clipboard::open(window.hwnd().map_err(err)?.0)?;
        unsafe {
            let h = GlobalAlloc(GMEM_MOVEABLE, data.len() * 2);
            if h.is_null() {
                return Err("Could not allocate clipboard text.".into());
            }
            let p = GlobalLock(h) as *mut u16;
            if p.is_null() {
                GlobalFree(h);
                return Err("Could not access clipboard memory.".into());
            }
            std::ptr::copy_nonoverlapping(data.as_ptr(), p, data.len());
            GlobalUnlock(h);
            if EmptyClipboard() == 0 || SetClipboardData(UNICODE_TEXT, h).is_null() {
                GlobalFree(h);
                return Err("Could not set the clipboard.".into());
            }
        }
        Ok(())
    }
}
#[cfg(windows)]
pub use win::*;
