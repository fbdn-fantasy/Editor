"""Package the portable executable and Tauri's Debian 12 x86-64 AppDir as one ZIP."""
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
PACKAGING = ROOT / 'packaging'
APP = 'app.editor.TextEditor.Portable'


def prepare_appdir(appdir, binary):
    # linuxdeploy excludes libgpg-error even though the bundled WebKitGTK
    # depends on it through libgcrypt. Some desktop runtimes omit both.
    shutil.copyfile('/usr/lib/x86_64-linux-gnu/libgpg-error.so.0',
                    appdir / 'usr/lib/libgpg-error.so.0')
    license_dir = appdir / 'usr/share/doc/libgpg-error0'
    license_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile('/usr/share/doc/libgpg-error0/copyright', license_dir / 'copyright')
    # linuxdeploy adds an RPATH to its copy. Restore the original binary so
    # AppRun can choose either a complete host runtime or the bundled one.
    shutil.copyfile(binary, appdir / 'usr/bin/editor')
    shutil.copyfile(PACKAGING / 'portable-apprun.sh', appdir / 'AppRun')
    (appdir / 'AppRun').chmod(0o755)
    entry = appdir / 'usr/share/applications' / f'{APP}.desktop'
    template = (PACKAGING / 'app.editor.TextEditor.desktop').read_text().splitlines()
    fields = {'Name': 'Editor Portable', 'Icon': APP, 'StartupWMClass': 'App.editor.TextEditor.Portable',
              'Exec': 'editor %F'}
    lines = []
    for line in template:
        key = line.partition('=')[0]
        lines.append(f'{key}={fields[key]}' if key in fields else line)
    entry.write_text('\n'.join(lines) + '\n')
    (appdir / 'Editor.desktop').unlink()
    (entry.parent / 'Editor.desktop').unlink()
    (appdir / entry.name).symlink_to(entry.relative_to(appdir))
    icon = appdir / f'{APP}.png'
    shutil.copyfile(ROOT / 'src-tauri/icons/256x256.png', icon)
    (appdir / '.DirIcon').unlink()
    (appdir / '.DirIcon').symlink_to(icon.name)
    for old in (appdir / 'usr/share/icons/hicolor').glob('*/apps/editor.png'):
        old.rename(old.with_name(icon.name))
    (appdir / 'editor.png').unlink(missing_ok=True)
    # Debian package notices can refer to the base system's common license texts.
    shutil.copytree('/usr/share/common-licenses', appdir / 'usr/share/common-licenses', dirs_exist_ok=True)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('appdir', type=Path)
    p.add_argument('binary', type=Path, help='unmodified release binary built with portable.conf.json')
    p.add_argument('runtime', type=Path, help='standalone x86-64 type 2 AppImage runtime')
    p.add_argument('output', type=Path)
    args = p.parse_args()
    version = json.loads((ROOT / 'package.json').read_text())['version']
    name = f'Editor-{version}-linux-x64-portable'
    dest = args.output.resolve() / 'portable'
    dest.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=dest) as directory:
        tmp = Path(directory)
        tree = tmp / 'AppDir'
        shutil.copytree(args.appdir, tree, symlinks=True)
        prepare_appdir(tree, args.binary)
        fs = tmp / 'filesystem.squashfs'
        subprocess.run(['mksquashfs', tree, fs, '-noappend', '-all-root', '-no-xattrs',
                        '-comp', 'zstd', '-processors', '2', '-no-progress'], check=True)
        image = tmp / 'Editor.AppImage'
        with image.open('wb') as out:
            for source in (args.runtime, fs):
                with source.open('rb') as src:
                    shutil.copyfileobj(src, out)
        image.chmod(0o755)
        path = tmp / f'{name}.zip'
        members = {'Editor.AppImage': image, 'Editor.sh': PACKAGING / 'portable-launch.sh',
                   'register-launcher.sh': PACKAGING / 'register-portable.sh',
                   'Editor.png': ROOT / 'src-tauri/icons/256x256.png',
                   'README.txt': PACKAGING / 'LINUX-PORTABLE-README.txt',
                   'LICENSE': ROOT / 'LICENSE', 'NOTICE': ROOT / 'NOTICE', 'THIRD-PARTY-NOTICES.txt': ROOT / 'THIRD-PARTY-NOTICES.txt'}
        with ZipFile(path, 'w', compression=ZIP_DEFLATED, compresslevel=9) as archive:
            for filename, source in members.items():
                archive.write(source, f'{name}/{filename}')
        path.replace(dest / path.name)


if __name__ == '__main__':
    main()
