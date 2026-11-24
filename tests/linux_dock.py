#!/usr/bin/env python3
"""Check dock grouping for a packaged Editor in a private headless GNOME session.

Run on Fedora 44 with GNOME Shell, Xwayland, dbus-daemon, gio, zenity, and the Editor
runtime dependencies installed. No installation of Editor is needed.

    python3 tests/linux_dock.py /path/to/Editor-V1.0.3.tar.gz
"""
import argparse
import os
from pathlib import Path
import resource
import signal
import subprocess
import tarfile
import tempfile

APP_ID = 'app.editor.TextEditor'


def smoke_test(package, root):
    with tarfile.open(package) as release:
        release.extractall(root, filter='data')
    prefix, = root.glob('Editor-*/usr')
    document = root / 'dock-regression.txt'
    document.write_text('A file opened through the packaged desktop entry.')
    second = root / 'second-workspace.txt'
    second.write_text('A file for the second workspace.')
    env = {
        'LANG': 'C.UTF-8', 'PATH': f'{prefix}/bin:/usr/bin',
        'XDG_SESSION_TYPE': 'wayland', 'XDG_CURRENT_DESKTOP': 'GNOME',
        'GSETTINGS_BACKEND': 'memory', 'LIBGL_ALWAYS_SOFTWARE': '1',
        'XDG_DATA_DIRS': f'{prefix}/share:/usr/share',
        'DOCK_DOCUMENT': str(document), 'DOCK_SECOND': str(second), 'DOCK_EDITOR_BINARY': str(prefix / 'bin/editor-text'),
        'DOCK_DESKTOP': str(prefix / f'share/applications/{APP_ID}.desktop'),
        'DBUS_SYSTEM_BUS_ADDRESS': f'unix:path={root}/no-host-system-bus',
    }
    for key in ('XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'XDG_STATE_HOME', 'TMPDIR'):
        path = root / key.lower()
        path.mkdir(mode=0o700)
        env[key] = str(path)

    # GNOME uses both buses during startup. Point its system-bus requests at
    # the isolated session bus as well, so it cannot contact the host desktop.
    command = [
        'dbus-run-session', '--', 'sh', '-c',
        'export DBUS_SYSTEM_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS"; exec "$@"', 'private-session',
        'gnome-shell', '--wayland', '--headless', '--virtual-monitor', '1024x768',
        '--wayland-display', 'editor-test-wayland', '--automation-script',
        str(Path(__file__).resolve().with_suffix('.js')),
    ]
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    log = root / 'session.log'
    with log.open('wb') as stream:
        session = subprocess.Popen(command, env=env, cwd=root, start_new_session=True,
                                   stdout=stream, stderr=subprocess.STDOUT)
        try:
            status = session.wait(timeout=95)
        finally:
            try:
                os.killpg(session.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            session.wait(timeout=5)
    lines = log.read_text(errors='replace').splitlines()
    checks = [line for line in lines if line.startswith(('PASS ', 'FAIL '))]
    for line in checks:
        print(line)
    if status or 'PASS launch from pinned favorite' not in checks:
        raise RuntimeError('GNOME dock test failed.\n' + '\n'.join(lines[-20:]))
    if not any('xdg_toplevel' in line and f'.set_app_id("{APP_ID}")' in line for line in lines):
        raise RuntimeError('The Wayland compositor did not receive the packaged desktop ID')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package', type=Path)
    with tempfile.TemporaryDirectory(prefix='editor-dock-test-') as directory:
        smoke_test(parser.parse_args().package, Path(directory))
