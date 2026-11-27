// GNOME Shell automation module, launched by linux_dock.py in a private session.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
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

function checkWindow(window, favorite, count = 1) {
    const tracked = Shell.WindowTracker.get_default().get_window_app(window);
    requireMatch(tracked === favorite && !tracked.is_window_backed() && favorite.get_n_windows() === count,
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
        // A file manager normally owns focus when it asks the editor to open a file.
        Main.overview.hide();
        const helper = launcher.spawnv(['zenity', '--info', '--title=Workspace test', '--text=Test file chooser']);
        try {
            const chooser = await waitFor(() => global.get_window_actors().map(a => a.meta_window)
                .find(w => w.get_pid() === Number(helper.get_identifier())), 'file chooser on same desktop');
            chooser.activate(global.get_current_time());
            await waitFor(() => chooser.has_focus(), 'focus outside Editor');
            const opener = launcher.spawnv(['gio', 'open', document]);
            await opener.wait_check_async(null);
            await waitFor(() => window.get_title()?.startsWith(GLib.path_get_basename(document)), 'document in original window');
            checkWindow(window, favorite);
            requireMatch(window.maximized_horizontally && window.maximized_vertically, 'First launch did not maximize');
            const manager = global.workspace_manager;
            const first = manager.get_active_workspace();
            const second = manager.get_workspace_by_index(first.index() + 1) ??
                manager.append_new_workspace(false, global.get_current_time());
            chooser.activate(global.get_current_time());
            await waitFor(() => chooser.has_focus(), 'file chooser before workspace switch');
            second.activate(global.get_current_time());
            await waitFor(() => manager.get_active_workspace() === second, 'second desktop activation');
            const nextFile = GLib.getenv('DOCK_SECOND');
            await launcher.spawnv(['gio', 'launch', GLib.getenv('DOCK_DESKTOP'), nextFile]).wait_check_async(null);
            const other = await waitFor(() => editorWindows().find(w => w !== window &&
                w.get_title()?.startsWith(GLib.path_get_basename(nextFile))), 'second window on new desktop');
            requireMatch(other.get_workspace() === second && window.get_workspace() === first, 'Unexpected workspace placement');
            checkWindow(other, favorite, 2);
            requireMatch(window.get_title()?.startsWith(GLib.path_get_basename(document)), 'File was also sent to first desktop');
            await launcher.spawnv([GLib.getenv('DOCK_EDITOR_BINARY')]).wait_check_async(null);
            await waitFor(() => other.get_title()?.startsWith('Untitled'), 'new document in second window');
            requireMatch(editorWindows().length === 2, 'A third window appeared on the same desktop');
            first.activate_with_focus(chooser, global.get_current_time());
            await waitFor(() => manager.get_active_workspace() === first, 'first desktop activation');
            await waitFor(() => chooser.has_focus(), 'file chooser still focused after returning');
            favorite.get_app_info().launch_action('new-window', null);
            await waitFor(() => window.get_title()?.startsWith('Untitled'), 'launcher action in first window');
            requireMatch(other.get_title()?.startsWith('Untitled') && editorWindows().length === 2, 'Other desktop changed');
            window.delete(global.get_current_time());
            await waitFor(() => !editorWindows().includes(window), 'first window to close');
            requireMatch(editorWindows().includes(other), 'Closing one window closed the other desktop');
            second.activate(global.get_current_time());
            other.delete(global.get_current_time());
            await waitFor(() => !editorWindows().some(w => w.get_pid() === pid), 'Editor to close');
            print('PASS ' + backend + ' cross-desktop creation, same-desktop file and blank tabs, independent close');
            print('PASS ' + backend + ' pinned window, icon and second-launch document');
        } finally {
            if (helper.get_identifier() !== null) helper.force_exit();
            await helper.wait_check_async(null).catch(() => {});
        }
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
        const file = Gio.File.new_for_path(GLib.getenv('DOCK_DOCUMENT'));
        const info = file.query_info('standard::content-type', Gio.FileQueryInfoFlags.NONE, null);
        const mime = info.get_content_type();
        requireMatch(Gio.AppInfo.get_recommended_for_type(mime).some(app => app.get_id() === desktopId),
            'Editor is missing from Open With for ' + mime);
        requireMatch(Gio.AppInfo.get_default_for_type(mime, false)?.get_id() === desktopId,
            'Installed Editor is not the default for ' + mime);
        print('PASS Editor is the default and appears in Open With for a zero-byte extensionless file (' + mime + ')');
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
