"""Verify Editor release packages and their source archives."""
import argparse
from configparser import ConfigParser
from dataclasses import dataclass
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import zipfile
import zlib

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
VERSION = '1.0.1'
APP = 'app.editor.TextEditor'
ARTIFACTS = {
    'RPM': f'Linux/RPM/Editor-{VERSION}.x86_64.rpm',
    'DEB': f'Linux/DEB/editor_{VERSION}_amd64.deb',
    'TAR': f'Linux/TAR/Editor-{VERSION}-linux-x64.tar.gz',
    'Windows': f'Windows/Editor-{VERSION}-x64-setup.exe',
}
SIZES = (16, 24, 32, 48, 64, 96, 128, 256, 512)
SOURCE = ROOT / 'src-tauri'
LICENCE = (ROOT / 'LICENSE').read_bytes()


class Invalid(Exception):
    """A release artifact violates its expected format or packaging contract."""


def require(condition, message):
    if not condition:
        raise Invalid(message)


def run(*args, data=None):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env={**os.environ, 'LC_ALL': 'C'})
    if result.returncode:
        detail = result.stderr.decode(errors='replace').strip() or f'exit {result.returncode}'
        raise Invalid(f'{args[0]} failed: {detail}')
    return result.stdout


def safe_path(name):
    path = PurePosixPath(name)
    require(not path.is_absolute() and '..' not in path.parts and '\\' not in name
            and not re.match(r'^[A-Za-z]:', name), f'unsafe member name {name!r}')
    return path.as_posix()


def file_manifest(archive):
    files = {}
    for entry in archive.infolist():
        name = safe_path(entry.filename)
        require(not stat.S_ISLNK(entry.external_attr >> 16), f'linked source entry {name}')
        if entry.is_dir():
            continue
        require(name not in files, f'duplicate ZIP entry {name}')
        files[name] = entry
    manifests = [name for name in files if PurePosixPath(name).name == 'package.json']
    require(len(manifests) == 1, 'source must contain exactly one application package.json')
    prefix = manifests[0][:-len('package.json')]
    require(all(name.startswith(prefix) for name in files), 'source ZIP has files outside its project root')
    return {name[len(prefix):]: entry for name, entry in files.items()}


def source_archive(path, platform):
    excluded = {'node_modules', 'target', 'dist', '.git', '.cargo-cache', '.aws', '.ssh', '__pycache__',
                '.env', '.npmrc', '.codex', 'credentials.json', 'id_rsa', 'id_ed25519'}
    sensitive = re.compile(rb'-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|(?:AKIA|ASIA)[A-Z0-9]{16}\b|'
                           rb'\bgh[pousr]_[A-Za-z0-9]{32,}|\bgithub_pat_[A-Za-z0-9_]{50,}|'
                           rb'\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}')
    fixed = ['package.json','package-lock.json','tsconfig.json','vite.config.ts','svelte.config.js','index.html',
             'src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/build.rs','src-tauri/tauri.conf.json',
             'LICENSE','README.md','THIRD-PARTY-NOTICES.txt','assets/editor-original.png','src-tauri/icons/icon.ico']
    trees = ('src','src-tauri/src','src-tauri/capabilities','src-tauri/icons','scripts','packaging','tests')
    required = set(fixed)
    for tree in trees:
        required.update(item.relative_to(ROOT).as_posix() for item in (ROOT/tree).rglob('*')
                        if item.is_file() and '__pycache__' not in item.parts and item.suffix != '.pyc')
    with zipfile.ZipFile(path) as archive:
        require(archive.testzip() is None, 'source ZIP CRC check failed')
        files = file_manifest(archive)
        require(not (required - files.keys()), f'missing source files: {sorted(required - files.keys())}')
        compressed = expected = 0
        for name, entry in files.items():
            member = PurePosixPath(name)
            require(not excluded.intersection(member.parts) and not member.name.startswith('.env.')
                    and member.suffix.lower() not in {'.exe','.dll','.so','.a','.obj','.o','.rpm','.deb','.pem','.key','.pyc','.pdb'},
                    f'unexpected generated or private source entry {name}')
            content = archive.read(entry)
            if name in required:
                require(content == (ROOT / name).read_bytes(), f'source differs from verification checkout: {name}')
            if member.suffix.lower() in {'.png','.ico'}:
                continue
            require(b'\x00' not in content, f'unexpected binary content in source: {name}')
            require(not sensitive.search(content), f'credential-like text in {name}')
            local_root = str(Path.home()).encode()
            if local_root != b'/':
                require(local_root + b'/' not in content, f'local user path in {name}')
            if len(content) >= 4096:
                require(entry.compress_type == zipfile.ZIP_DEFLATED, f'expected DEFLATE for {name}')
                compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
                expected += len(compressor.compress(content) + compressor.flush())
                compressed += entry.compress_size
        # ZIP has no portable level field. Compare the actual compressed text
        # with level-9 DEFLATE and tolerate differences between implementations.
        require(compressed and compressed <= expected * 1.03, 'text payload is not highly compressed')
        require(archive.read(files['BUILD.md']) == (ROOT / f'packaging/build-{platform.lower()}.md').read_bytes(),
                f'build instructions mismatch for {platform}')
        config = json.loads(archive.read(files['src-tauri/tauri.conf.json']))
        require(config['productName'] == 'Editor' and config['version'] == VERSION and config['identifier'] == APP,
                'source identity mismatch')
        require(json.loads(archive.read(files['package-lock.json']))['name'] ==
                json.loads(archive.read(files['package.json']))['name'], 'npm lockfile mismatch')


@dataclass
class Entry:
    content: bytes
    mode: int


def tar_entries(stream, prefix=''):
    files = {}
    with tarfile.open(fileobj=stream, mode='r:*') as archive:
        for entry in archive:
            name = safe_path(entry.name)
            if entry.isdir():
                continue
            require(entry.isfile() and name.startswith(prefix), f'unexpected TAR member {name}')
            name = name[len(prefix):]
            require(name not in files, f'duplicate TAR member {name}')
            files[name] = Entry(archive.extractfile(entry).read(), entry.mode)
    return files


def linux_files(files, temp):
    executable = files['usr/bin/editor-text']
    require(executable.mode & 0o111 == 0o111 and not executable.mode & 0o6000, 'invalid executable permissions')
    binary = temp / 'linux-editor'
    binary.write_bytes(executable.content)
    header = run('readelf','-h',binary).decode()
    require('ELF64' in header and 'Advanced Micro Devices X86-64' in header and
            re.search(r'Type:\s+(?:DYN|EXEC)\b', header), 'Linux program is not a 64-bit x86 ELF executable')
    require('program interpreter' in run('readelf','-l',binary).decode(), 'missing executable program interpreter')
    versions = re.findall(r'Name: GLIBC_(\d+)\.(\d+)(?:\.(\d+))?', run('readelf','-V',binary).decode())
    floor = max(tuple(int(i) for i in version if i) for version in versions)
    desktop = ConfigParser(interpolation=None)
    desktop.read_string(files[f'usr/share/applications/{APP}.desktop'].content.decode())
    group = desktop['Desktop Entry']
    require(group['Name'] == 'Editor' and group['Type'] == 'Application' and group['Icon'] == APP
            and group['Exec'] == 'editor-text %F' and group.getboolean('Terminal') is False
            and group.get('StartupWMClass') == 'App.editor.TextEditor',
            'desktop launcher metadata mismatch')
    require({'text/plain', 'text/markdown','application/json'}.issubset(group['MimeType'].split(';')),
            'desktop MIME registration missing')
    require(files['usr/share/doc/editor-text/copyright'].content == LICENCE, 'Linux license mismatch')
    require(files['usr/share/doc/editor-text/THIRD-PARTY-NOTICES.txt'].content ==
            (ROOT/'THIRD-PARTY-NOTICES.txt').read_bytes(), 'Linux third-party notices mismatch')
    for size in SIZES:
        png = f'{size}x{size}.png'
        icon = files[f'usr/share/icons/hicolor/{size}x{size}/apps/{APP}.png'].content
        require(icon == (SOURCE/'icons'/png).read_bytes(), f'incorrect installed icon at {size}px')
    return floor


def rpm(path, temp):
    run('rpm','--checksig','--nosignature',path)
    name, version, arch, license_id = run('rpm','-qp','--qf','%{NAME}\n%{VERSION}\n%{ARCH}\n%{LICENSE}',path).decode().splitlines()
    require(name == 'Editor' and ' ' not in name and (version,arch,license_id) == (VERSION,'x86_64','Apache-2.0'),
            'RPM metadata mismatch')
    deps = run('rpm','-qpR',path).decode()
    require('webkit2gtk4.1' in deps and 'gtk3' in deps, 'RPM runtime requirements missing')
    # Read each regular entry through cpio's stdout mode; never materialize
    # archive-chosen paths or RPM-generated build-ID links on disk.
    payload = run('rpm2cpio',path)
    names = run('cpio','-it','--quiet',data=payload).decode().splitlines()
    modes = run('rpm','-qp','--qf','[%{FILENAMES}\t%{FILEMODES}\n]',path).decode().splitlines()
    modes = {line.rsplit('\t',1)[0].lstrip('/'):int(line.rsplit('\t',1)[1]) for line in modes}
    files = {}
    for raw in names:
        name = safe_path(raw)
        if stat.S_ISREG(modes.get(name,0)):
            files[name] = Entry(run('cpio','-i','--to-stdout','--quiet',raw,data=payload),modes[name])
    return linux_files(files,temp)


def deb(path, temp):
    names = run('ar','t',path).decode().splitlines()
    require(names == ['debian-binary','control.tar.gz','data.tar.gz'] and
            run('ar','p',path,'debian-binary') == b'2.0\n', 'unexpected Debian ar format')
    meta = tar_entries(io.BytesIO(run('ar','p',path,'control.tar.gz')))
    # Debian dpkg rejects per-file extended PAX headers, even when general tar
    # readers successfully list and extract the same payload.
    payload = run('ar','p',path,'data.tar.gz')
    with tarfile.open(fileobj=io.BytesIO(payload),mode='r:gz') as archive:
        require(all(not entry.pax_headers for entry in archive), 'dpkg-incompatible PAX headers')
    files = tar_entries(io.BytesIO(payload))
    fields = dict(line.split(': ',1) for line in meta['control'].content.decode().splitlines() if ': ' in line and not line.startswith(' '))
    require((fields['Package'],fields['Version'],fields['Architecture']) == ('editor-text',VERSION,'amd64'),
            'DEB control identity mismatch')
    floor = linux_files(files,temp)
    deps = fields['Depends']
    minimum = re.search(r'libc6 \(>= ([\d.]+)\)',deps)
    require(minimum and tuple(map(int,minimum[1].split('.'))) >= floor and
            'libwebkit2gtk-4.1-0' in deps and 'libgtk-3-0' in deps, 'incomplete Debian runtime requirements')
    checks = {name:digest for digest,name in (line.split('  ',1) for line in meta['md5sums'].content.decode().splitlines())}
    require(set(checks) == set(files), 'incomplete Debian file manifest')
    for name, entry in files.items():
        require(hashlib.md5(entry.content).hexdigest() == checks[name], f'Debian content digest mismatch for {name}')
    return floor


def tar_package(path, temp):
    run('gzip','-t',path)
    with path.open('rb') as stream:
        files = tar_entries(stream,f'Editor-{VERSION}-linux-x64/')
    require(files['install.sh'].mode & 0o111 and files['README.txt'].content, 'TAR install mechanism missing')
    return linux_files(files,temp)


def pe_machine(data):
    require(data[:2] == b'MZ' and len(data) >= 64,'invalid DOS header')
    offset = struct.unpack_from('<I',data,60)[0]
    require(data[offset:offset + 4] == b'PE\0\0','invalid PE signature')
    return struct.unpack_from('<H',data,offset + 4)[0],struct.unpack_from('<H',data,offset + 24)[0]


def windows_resources(path):
    group = run('wrestool','-x','--raw','-t','14',path)
    require(len(group) >= 6 and group[:4] == b'\0\0\1\0',f'{path.name} has no Windows icon resource')
    version = run('wrestool','-x','--raw','-t','16',path)
    require('Editor'.encode('utf-16-le') in version and VERSION.encode('utf-16-le') in version,
            f'{path.name} lacks Editor version metadata')


def windows(path, temp):
    require(pe_machine(path.read_bytes())[0] in (0x14c,0x8664),'invalid Windows installer launcher')
    run('7z','t','-tNsis',path)
    listing = run('7z','l','-slt','-tNsis',path).decode()
    require('Type = Nsis' in listing, 'installer did not identify as NSIS')
    names = re.findall(r'^Path = (.+)$',listing,re.M)[1:]
    def content(basename):
        matches = [n for n in names if n.replace('\\','/').split('/')[-1].casefold() == basename.casefold()]
        require(len(matches) == 1, f'expected one {basename} in installer, found {len(matches)}')
        return run('7z','x','-so','-tNsis',path,matches[0])
    app = content('editor.exe')
    require(pe_machine(app) == (0x8664,0x20b),'NSIS payload is not x86-64 PE32+')
    require(content('LICENSE') == LICENCE, 'installer license mismatch')
    require(content('THIRD-PARTY-NOTICES.txt') == (ROOT/'THIRD-PARTY-NOTICES.txt').read_bytes(),
            'installer third-party notices mismatch')
    binary = temp/'windows-editor.exe'
    binary.write_bytes(app)
    windows_resources(path)
    windows_resources(binary)


def portable(path, platform, temp):
    prefix = path.stem + '/'
    with zipfile.ZipFile(path) as archive:
        require(archive.testzip() is None, f'{path.name} CRC check failed')
        names = set()
        for member in archive.infolist():
            name = safe_path(member.filename)
            require(not stat.S_ISLNK(member.external_attr >> 16), f'linked ZIP member {name}')
            if member.is_dir():
                continue
            require(name.startswith(prefix) and name not in names, f'unexpected ZIP member {name}')
            names.add(name)
        expected = {'LICENSE', 'THIRD-PARTY-NOTICES.txt', 'README.txt'}
        if platform == 'windows':
            expected.add('Editor.exe')
        else:
            expected.update({'Editor.AppImage', 'Editor.sh', 'Editor.png', 'register-launcher.sh'})
        require(names == {prefix + name for name in expected}, f'unexpected {platform} portable ZIP contents')
        def content(name):
            return archive.read(prefix + name)
        require(content('LICENSE') == LICENCE and content('THIRD-PARTY-NOTICES.txt') ==
                (ROOT/'THIRD-PARTY-NOTICES.txt').read_bytes(), f'{platform} portable notices mismatch')
        require(content('README.txt') == (ROOT/f'packaging/{platform.upper()}-PORTABLE-README.txt').read_bytes(),
                f'{platform} portable instructions mismatch')
        if platform == 'windows':
            executable = content('Editor.exe')
            require(pe_machine(executable) == (0x8664,0x20b), 'portable Windows program is not x86-64')
            require(b'app.editor.TextEditor.Portable' in executable and b'./Data' in executable,
                    'Windows executable lacks the portable build configuration')
            binary = temp/'windows-portable.exe'
            binary.write_bytes(executable)
            windows_resources(binary)
        else:
            require(content('Editor.png') == (SOURCE/'icons/256x256.png').read_bytes(),
                    'incorrect Linux portable launcher icon')
            for name, source in [('Editor.sh','portable-launch.sh'), ('register-launcher.sh','register-portable.sh')]:
                require(content(name) == (ROOT/'packaging'/source).read_bytes() and
                        archive.getinfo(prefix + name).external_attr >> 16 & 0o111,
                        f'incorrect Linux portable launcher script: {name}')
            entry = archive.getinfo(prefix + 'Editor.AppImage')
            with archive.open(entry) as file:
                header = file.read(20)
            require(header.startswith(b'\x7fELF\x02\x01') and header[8:11] == b'AI\x02' and
                    header[18:20] == b'\x3e\x00' and entry.external_attr >> 16 & 0o111,
                    'portable Linux program is not an executable x86-64 AppImage')


def icon_sources():
    for size in SIZES:
        with Image.open(SOURCE/f'icons/{size}x{size}.png') as dark, Image.open(SOURCE/f'icons/{size}x{size}-white.png') as white:
            require(dark.mode == white.mode == 'RGBA' and dark.size == white.size == (size,size), 'PNG format mismatch')
            alpha = dark.getchannel('A')
            require(alpha.getextrema() == (0,255) and alpha.tobytes() == white.getchannel('A').tobytes(),
                    f'icon transparency or variant shape mismatch at {size}px')
    with Image.open(SOURCE/'icons/icon.ico') as icon:
        require({(16,16),(32,32),(48,48),(256,256)}.issubset(icon.ico.sizes()), 'incomplete Windows ICO sizes')


def verify(root, linux_only=False, with_portable=False):
    require(root.is_dir() and not root.is_symlink(),'release directory missing or linked')
    artifacts = {kind: name for kind, name in ARTIFACTS.items() if not linux_only or kind != 'Windows'}
    expected = {Path(name) for name in artifacts.values()}
    archives = {kind: Path(filename).parent / f'Editor-{VERSION}-{kind}-Source.zip'
                for kind,filename in artifacts.items()}
    expected.update(archives.values())
    portables = {}
    if with_portable:
        platforms = ['linux'] if linux_only else ['linux', 'windows']
        portables = {name: Path(f'portable/Editor-{VERSION}-{name}-x64-portable.zip') for name in platforms}
        expected.update(portables.values())
    expected_dirs = {p for file in expected for p in file.parents if p != Path('.')}
    if linux_only:
        linux = root / 'Linux'
        require(linux.is_dir() and not linux.is_symlink(), 'Linux release directory missing or linked')
        contents = [linux, *linux.rglob('*')]
        if portables:
            contents += [root/'portable', *(root/p for p in portables.values())]
    else:
        contents = list(root.rglob('*'))
    require(all(not p.is_symlink() and (p.is_file() or p.is_dir()) for p in contents),'linked or special release entry')
    files = {p.relative_to(root) for p in contents if p.is_file()}
    dirs = {p.relative_to(root) for p in contents if p.is_dir()}
    require(files == expected and dirs == expected_dirs,
            f'release layout mismatch; missing {sorted(map(str,expected - files))}, unexpected {sorted(map(str,(files - expected) | (dirs - expected_dirs)))}')
    icon_sources()
    with tempfile.TemporaryDirectory(prefix='editor-verify-') as staging:
        temp = Path(staging)
        for kind, name in artifacts.items():
            source_archive(root/archives[kind],kind)
            print(f'PASS {archives[kind]}',flush=True)
            if kind == 'Windows':
                windows(root/name,temp)
                print(f'PASS {name} (NSIS installer, x86-64 application payload)')
            else:
                floor = {'RPM':rpm,'DEB':deb,'TAR':tar_package}[kind](root/name,temp)
                print(f'PASS {name} (x86-64 ELF, glibc {".".join(map(str,floor))} or later)',flush=True)
        for platform, path in portables.items():
            portable(root/path, platform, temp)
            print(f'PASS {path}',flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('release',type=Path,help='path to the release directory')
    parser.add_argument('--linux-only',action='store_true',help='check only the Linux release directory')
    parser.add_argument('--with-portable',action='store_true',help='also verify portable application ZIPs')
    args = parser.parse_args()
    try:
        verify(args.release.resolve(), args.linux_only, args.with_portable)
    except (Invalid, OSError, KeyError, ValueError, struct.error, tarfile.TarError, zipfile.BadZipFile) as error:
        sys.exit(f'FAIL {error}')
