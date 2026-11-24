//! Determine whether an Editor window belongs to the active virtual desktop.
//! Only a window confirmed on this desktop may receive an external launch.
use tauri::WebviewWindow;

#[cfg(target_os = "linux")]
pub use linux::{Desktop, contains, current};

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use gtk::prelude::*;
    use std::{
        cell::OnceCell,
        ffi::CStr,
        os::raw::{c_uchar, c_ulong},
        ptr,
        time::{Duration, Instant},
    };
    use x11::xlib;

    #[derive(Clone, Copy, Default, PartialEq, Eq)]
    pub enum Desktop {
        #[default]
        Unknown,
        BeforeFirstSwitch,
        Number(u32),
    }

    struct WorkspaceDisplay {
        connection: *mut xlib::Display,
        initial: OnceCell<Desktop>,
    }

    impl WorkspaceDisplay {
        fn open() -> Option<Self> {
            std::env::var_os("DISPLAY")?;
            let display = unsafe { xlib::XOpenDisplay(ptr::null()) };
            (!display.is_null()).then(|| Self {
                connection: display,
                initial: OnceCell::new(),
            })
        }

        fn cardinal(&self, window: xlib::Window, name: &CStr) -> Option<u32> {
            unsafe {
                let atom = xlib::XInternAtom(self.connection, name.as_ptr(), 1);
                if atom == 0 {
                    return None;
                }
                let (mut kind, mut format, mut count, mut remaining) = (0, 0, 0, 0);
                let mut bytes: *mut c_uchar = ptr::null_mut();
                let status = xlib::XGetWindowProperty(
                    self.connection,
                    window,
                    atom,
                    0,
                    1,
                    0,
                    xlib::XA_CARDINAL,
                    &mut kind,
                    &mut format,
                    &mut count,
                    &mut remaining,
                    &mut bytes,
                );
                let result = (status == 0
                    && kind == xlib::XA_CARDINAL
                    && format == 32
                    && count == 1
                    && !bytes.is_null())
                .then(|| *bytes.cast::<c_ulong>() as u32);
                if !bytes.is_null() {
                    xlib::XFree(bytes.cast());
                }
                result
            }
        }

        fn initial_desktop(&self, root: xlib::Window) -> Desktop {
            // Mutter does not always publish its current index until the first
            // switch. Ask it to place an invisible, non-activating splash and
            // read the workspace it assigns. This also works if Editor is
            // first opened on a workspace other than zero.
            let d = self.connection;
            unsafe {
                let win = xlib::XCreateSimpleWindow(d, root, 0, 0, 1, 1, 0, 0, 0);
                let atom = |name: &CStr| xlib::XInternAtom(d, name.as_ptr(), 0);
                let property = |name: &CStr, kind, values: &[c_ulong]| {
                    xlib::XChangeProperty(
                        d,
                        win,
                        atom(name),
                        kind,
                        32,
                        xlib::PropModeReplace,
                        values.as_ptr().cast(),
                        values.len() as i32,
                    );
                };
                property(
                    c"_NET_WM_WINDOW_TYPE",
                    xlib::XA_ATOM,
                    &[atom(c"_NET_WM_WINDOW_TYPE_SPLASH")],
                );
                property(
                    c"_NET_WM_STATE",
                    xlib::XA_ATOM,
                    &[
                        atom(c"_NET_WM_STATE_SKIP_TASKBAR"),
                        atom(c"_NET_WM_STATE_SKIP_PAGER"),
                    ],
                );
                property(c"_NET_WM_WINDOW_OPACITY", xlib::XA_CARDINAL, &[0]);
                property(c"_NET_WM_USER_TIME", xlib::XA_CARDINAL, &[0]);
                let mut hints: xlib::XWMHints = std::mem::zeroed();
                hints.flags = xlib::InputHint;
                xlib::XSetWMHints(d, win, &mut hints);
                xlib::XMapWindow(d, win);
                xlib::XFlush(d);
                let until = Instant::now() + Duration::from_millis(300);
                let desktop = loop {
                    if let Some(n) = self
                        .cardinal(win, c"_NET_WM_DESKTOP")
                        .filter(|n| *n != u32::MAX)
                    {
                        break Desktop::Number(n);
                    }
                    if Instant::now() >= until {
                        break Desktop::BeforeFirstSwitch;
                    }
                    std::thread::sleep(Duration::from_millis(5));
                };
                xlib::XDestroyWindow(d, win);
                xlib::XFlush(d);
                desktop
            }
        }
    }

    impl Drop for WorkspaceDisplay {
        fn drop(&mut self) {
            unsafe {
                xlib::XCloseDisplay(self.connection);
            }
        }
    }

    // Keep the connection for the lifetime of the UI thread so an on-demand
    // XWayland server keeps publishing workspace switches between launches.
    thread_local! { static DISPLAY: Option<WorkspaceDisplay> = WorkspaceDisplay::open(); }

    pub fn current() -> Desktop {
        DISPLAY.with(|display| {
            let Some(display) = display else {
                return Desktop::Unknown;
            };
            let root = unsafe { xlib::XDefaultRootWindow(display.connection) };
            if let Some(n) = display.cardinal(root, c"_NET_CURRENT_DESKTOP") {
                Desktop::Number(n)
            } else if display
                .cardinal(root, c"_NET_NUMBER_OF_DESKTOPS")
                .is_some_and(|n| n > 0)
            {
                *display
                    .initial
                    .get_or_init(|| display.initial_desktop(root))
            } else {
                Desktop::Unknown
            }
        })
    }

    pub fn contains(window: &WebviewWindow, saved: Desktop, active: Desktop, shown: bool) -> bool {
        if let Ok(gtk_window) = window.gtk_window()
            && let Some(surface) = gtk_window.window()
            && let Ok(x11) = surface.downcast::<gdkx11::X11Window>()
        {
            if shown {
                // X11 exposes the live assignment, including windows made sticky.
                let assigned = x11.desktop();
                return match active {
                    Desktop::Number(n) => assigned == n || assigned == u32::MAX,
                    Desktop::BeforeFirstSwitch => saved == active || assigned == u32::MAX,
                    Desktop::Unknown => true, // An X server without a workspace manager.
                };
            }
        }
        if active != Desktop::Unknown {
            return saved == active;
        }
        // Compositors that hide workspace identity still permit reuse of the
        // focused window. Avoid activating an unverified off-desktop window.
        window.is_focused().unwrap_or(false)
    }
}

#[cfg(windows)]
pub type Desktop = ();
#[cfg(windows)]
pub fn current() -> Desktop {}
#[cfg(windows)]
pub fn contains(window: &WebviewWindow, _: Desktop, _: Desktop, _: bool) -> bool {
    use windows::Win32::{
        System::Com::{CLSCTX_INPROC_SERVER, CLSCTX_LOCAL_SERVER, CoCreateInstance},
        UI::Shell::{IVirtualDesktopManager, VirtualDesktopManager},
    };
    // The UI thread already has a COM apartment initialized for WebView2.
    let Ok(hwnd) = window.hwnd() else {
        return false;
    };
    let result = unsafe {
        let manager: windows::core::Result<IVirtualDesktopManager> = CoCreateInstance(
            &VirtualDesktopManager,
            None,
            CLSCTX_INPROC_SERVER | CLSCTX_LOCAL_SERVER,
        );
        manager.and_then(|m| m.IsWindowOnCurrentVirtualDesktop(hwnd))
    };
    result
        .map(|v| v.as_bool())
        .unwrap_or_else(|_| window.is_focused().unwrap_or(false))
}
