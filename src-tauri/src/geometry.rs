use crate::files::{Result, err};
use serde::{Deserialize, Serialize};
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

#[derive(Clone, Copy, Serialize, Deserialize)]
pub struct Geometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

impl Default for Geometry {
    fn default() -> Self {
        Self {
            x: 0,
            y: 0,
            width: 940,
            height: 660,
            maximized: false,
        }
    }
}

pub fn capture(win: &WebviewWindow, last: &mut Geometry) {
    if win.is_minimized().unwrap_or(false) {
        return;
    }
    let Ok(maximized) = win.is_maximized() else {
        return;
    };
    last.maximized = maximized;
    if maximized {
        return;
    }
    if let Ok(size) = win.inner_size()
        && size.width > 0
        && size.height > 0
    {
        last.width = size.width;
        last.height = size.height;
    }
    // Some Wayland compositors control position, but still expose window size.
    if let Ok(pos) = win.outer_position() {
        last.x = pos.x;
        last.y = pos.y;
    }
}

fn fit(g: Geometry, rect: (i32, i32, u32, u32)) -> Geometry {
    let (x, y, w, h) = rect;
    let width = g.width.clamp(1, w.max(1));
    let height = g.height.clamp(1, h.max(1));
    Geometry {
        x: g.x
            .clamp(x, x.saturating_add(w.saturating_sub(width) as i32)),
        y: g.y
            .clamp(y, y.saturating_add(h.saturating_sub(height) as i32)),
        width,
        height,
        ..g
    }
}

pub fn restore(win: &WebviewWindow, saved: Geometry) -> Result<()> {
    let monitors = win.available_monitors().map_err(err)?;
    let area = monitors.iter().find(|m| {
        let a = m.work_area();
        let (x, y) = (i64::from(saved.x), i64::from(saved.y));
        x >= i64::from(a.position.x)
            && y >= i64::from(a.position.y)
            && x < i64::from(a.position.x) + i64::from(a.size.width)
            && y < i64::from(a.position.y) + i64::from(a.size.height)
    });
    let primary = win.primary_monitor().ok().flatten();
    if let Some(m) = area.or(primary.as_ref()).or_else(|| monitors.first()) {
        let a = m.work_area();
        let mut g = fit(
            saved,
            (a.position.x, a.position.y, a.size.width, a.size.height),
        );
        if area.is_none() {
            g.x = a
                .position
                .x
                .saturating_add((a.size.width.saturating_sub(g.width) / 2) as i32);
            g.y = a
                .position
                .y
                .saturating_add((a.size.height.saturating_sub(g.height) / 2) as i32);
        }
        win.set_size(PhysicalSize::new(g.width, g.height))
            .map_err(err)?;
        let _ = win.set_position(PhysicalPosition::new(g.x, g.y));
    }
    if saved.maximized {
        win.maximize().map_err(err)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn smaller_monitor_fits_oversized_or_offscreen_window() {
        let g = fit(
            Geometry {
                x: -3000,
                y: 1000,
                width: 3000,
                height: 500,
                maximized: false,
            },
            (0, 0, 1200, 800),
        );
        assert_eq!((g.x, g.y, g.width, g.height), (0, 300, 1200, 500));
    }
}
