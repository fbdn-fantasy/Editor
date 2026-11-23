"""Package the compiled Tauri application without changing desktop defaults."""
import argparse
import hashlib
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = "1.0.1"
APP_ID = "app.editor.TextEditor"


def install(source, dest, mode=0o644):
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, dest)
    dest.chmod(mode)


def add_tree(archive, root, prefix=""):
    for path in sorted(root.rglob("*")):
        name = f"{prefix}{path.relative_to(root).as_posix()}"
        info = archive.gettarinfo(str(path), arcname=name)
        info.uid = info.gid = 0
        info.uname = info.gname = "root"
        if path.is_file():
            with path.open("rb") as stream:
                archive.addfile(info, stream)
        else:
            archive.addfile(info)


def tar_gz(root, output, prefix=""):
    with tarfile.open(output, "w:gz", compresslevel=9, format=tarfile.USTAR_FORMAT) as archive:
        add_tree(archive, root, prefix)


def build_deb(payload, temp, output, binary):
    symbols = subprocess.check_output(["readelf", "--version-info", binary], text=True)
    versions = re.findall(r"Name: GLIBC_(\d+)\.(\d+)(?:\.(\d+))?\b", symbols)
    minimum = max((int(a), int(b), int(c or 0)) for a,b,c in versions)
    libc = ".".join(map(str, minimum if minimum[2] else minimum[:2]))
    control = temp / "control"
    control.mkdir()
    size = sum(p.stat().st_size for p in payload.rglob("*") if p.is_file())
    (control / "control").write_text(f"""Package: editor-text
Version: {VERSION}
Section: editors
Priority: optional
Architecture: amd64
Maintainer: Editor <editor@localhost>
Installed-Size: {(size + 1023) // 1024}
Depends: libc6 (>= {libc}), libgcc-s1, libgtk-3-0 | libgtk-3-0t64, libwebkit2gtk-4.1-0 (>= 2.40), libjavascriptcoregtk-4.1-0, libsoup-3.0-0, libcairo2, libgdk-pixbuf-2.0-0, libglib2.0-0 | libglib2.0-0t64, libdbus-1-3
Description: Desktop text and source-code editor
 Edits plain text and code using local language detection and highlighting.
""")
    hashes = [f"{hashlib.md5(p.read_bytes()).hexdigest()}  {p.relative_to(payload)}"
              for p in sorted(payload.rglob("*")) if p.is_file()]
    (control / "md5sums").write_text("\n".join(hashes) + "\n")
    (temp / "debian-binary").write_bytes(b"2.0\n")
    tar_gz(control, temp / "control.tar.gz")
    tar_gz(payload, temp / "data.tar.gz")
    name = f"editor_{VERSION}_amd64.deb"
    subprocess.run(["ar", "rcD", name, "debian-binary", "control.tar.gz", "data.tar.gz"],
                   cwd=temp, check=True)
    install(temp / name, output / "Linux/DEB" / name)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("target", choices=["rpm", "deb", "tar"])
    p.add_argument("binary", type=Path)
    p.add_argument("output", type=Path)
    args = p.parse_args()
    binary, output = args.binary.resolve(strict=True), args.output.resolve()
    info = subprocess.check_output(["file", "-Lb", binary], text=True)
    if "ELF 64-bit" not in info or "x86-64" not in info:
        p.error("an x86-64 Linux release executable is required")
    with tempfile.TemporaryDirectory(prefix="editor-linux-") as staging:
        temp = Path(staging)
        payload = temp / "SOURCES/payload"
        install(binary, payload / "usr/bin/editor-text", 0o755)
        install(ROOT / "LICENSE", payload / "usr/share/doc/editor-text/copyright")
        install(ROOT / "THIRD-PARTY-NOTICES.txt", payload / "usr/share/doc/editor-text/THIRD-PARTY-NOTICES.txt")
        desktop = f"{APP_ID}.desktop"
        install(ROOT / "packaging" / desktop, payload / "usr/share/applications" / desktop)
        for size in (16, 24, 32, 48, 64, 96, 128, 256, 512):
            label = f"{size}x{size}"
            install(ROOT / f"src-tauri/icons/{label}.png",
                    payload / f"usr/share/icons/hicolor/{label}/apps/{APP_ID}.png")
        if args.target == "rpm":
            subprocess.run(["rpmbuild", "-bb", "--define", f"_topdir {staging}", "--define", f"_tmppath {staging}",
                            ROOT / "packaging/editor.spec"], check=True)
            rpm, = (temp / "RPMS/x86_64").glob("*.rpm")
            install(rpm, output / f"Linux/RPM/Editor-{VERSION}.x86_64.rpm")
        if args.target == "deb":
            build_deb(payload, temp, output, binary)
        if args.target == "tar":
            install(ROOT / "packaging/install.sh", payload / "install.sh", 0o755)
            install(ROOT / "packaging/TAR-README.txt", payload / "README.txt")
            name = f"Editor-{VERSION}-linux-x64"
            tar_gz(payload, temp / f"{name}.tar.gz", prefix=f"{name}/")
            install(temp / f"{name}.tar.gz", output / f"Linux/TAR/{name}.tar.gz")


if __name__ == "__main__":
    main()
