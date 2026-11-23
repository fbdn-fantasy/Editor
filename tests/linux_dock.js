// GNOME Shell automation module, launched by linux_dock.py in a private session.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Favorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

const appId = 'app.editor.TextEditor';
const desktopId = appId + '.desktop';

function requireMatch(ok, message) {
    if (!ok) throw new Error(message);
}

async function waitFor(read, description) {
    for (let i = 0; i < 100; i++) {
        const value = read();
        if (value) return value;
        await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));
    }
    throw new Error('Timed out waiting for ' + description);
}

function editorWindows() {
    return global.get_window_actors().map(actor => actor.meta_window)
        .filter(window => window.get_title()?.endsWith(' — Editor'));
}

function checkWindow(window, favorite) {
    const tracked = Shell.WindowTracker.get_default().get_window_app(window);
    requireMatch(tracked === favorite && !tracked.is_window_backed() && favorite.get_n_windows() === 1,
        'GNOME associated the window with ' + tracked?.get_id() + ' instead of the single pinned Editor');
    requireMatch(tracked.get_app_info().get_icon()?.to_string() === appId, 'Incorrect application icon');
}

async function launchBinary(backend, favorite) {
    const launcher = new Gio.SubprocessLauncher({flags: Gio.SubprocessFlags.NONE});
    launcher.setenv('GDK_BACKEND', backend, true);
    if (backend === 'wayland') launcher.setenv('WAYLAND_DEBUG', 'client', true);
    const child = launcher.spawnv([GLib.getenv('DOCK_EDITOR_BINARY')]);
    const pid = Number(child.get_identifier());
    try {
        const window = await waitFor(() => editorWindows().find(w => w.get_pid() === pid), backend + ' Editor');
        const native = window.get_client_type() === Meta.WindowClientType.WAYLAND;
        requireMatch(native === (backend === 'wayland'), 'Unexpected display backend');
        checkWindow(window, favorite);
        if (!native) {
            const expectedClass = favorite.get_app_info().get_startup_wm_class();
            requireMatch(window.get_wm_class() === expectedClass, 'Incorrect X11 WM_CLASS ' + window.get_wm_class());
        }
        const document = GLib.getenv('DOCK_DOCUMENT');
        const opener = launcher.spawnv(['gio', 'launch', GLib.getenv('DOCK_DESKTOP'), document]);
        await opener.wait_check_async(null);
        await waitFor(() => window.get_title()?.startsWith(GLib.path_get_basename(document)), 'document in original window');
        checkWindow(window, favorite);
        window.delete(global.get_current_time());
        await waitFor(() => !editorWindows().some(w => w.get_pid() === pid), 'Editor to close');
        print('PASS ' + backend + ' pinned window, icon and second-launch document');
    } finally {
        if (child.get_identifier() !== null) child.force_exit();
        await child.wait_check_async(null).catch(() => {});
    }
}

export async function run() {
    try {
        global.settings.set_strv('favorite-apps', [desktopId]);
        const favorite = Favorites.getAppFavorites().getFavoriteMap()[desktopId];
        requireMatch(favorite?.get_app_info()?.get_filename() === GLib.getenv('DOCK_DESKTOP'),
            'Private favorite did not resolve to packaged desktop file');
        for (const backend of ['wayland', 'x11']) await launchBinary(backend, favorite);
        favorite.activate();
        const window = await waitFor(() => editorWindows()[0], 'window opened from favorite');
        checkWindow(window, favorite);
        window.delete(global.get_current_time());
        await waitFor(() => editorWindows().length === 0, 'favorite window to close');
        print('PASS launch from pinned favorite');
    } catch (error) {
        print('FAIL ' + error.message);
    }
}
