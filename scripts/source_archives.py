"""Create distribution source archives, each with its own build guide."""
import argparse
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PROJECT = "Editor-1.0.1"
PACKAGES = {
    "RPM": ("Linux/RPM", "packaging/build-rpm.md"),
    "DEB": ("Linux/DEB", "packaging/build-deb.md"),
    "TAR": ("Linux/TAR", "packaging/build-tar.md"),
    "Windows": ("Windows", "packaging/build-windows.md"),
}

def sources():
    for name in ["LICENSE", "THIRD-PARTY-NOTICES.txt", "README.md", "package.json", "package-lock.json",
                 "tsconfig.json", "svelte.config.js", "vite.config.ts", "index.html",
                 "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/build.rs", "src-tauri/tauri.conf.json"]:
        yield ROOT/name
    for name in ["assets", "src", "scripts", "tests", "packaging", "src-tauri/src",
                 "src-tauri/icons", "src-tauri/capabilities"]:
        for item in sorted((ROOT/name).rglob("*")):
            if item.is_file() and not item.is_symlink() and not any(part.startswith(".") or part == "__pycache__" for part in item.relative_to(ROOT).parts) and item.suffix != ".pyc":
                yield item

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--linux-only", action="store_true", help="create the RPM, DEB and TAR sources")
    args = parser.parse_args()
    output = args.output.resolve()
    for target, (folder, instructions) in PACKAGES.items():
        if args.linux_only and target == "Windows":
            continue
        dest = output / folder
        dest.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=dest, suffix=".tmp", delete=False) as tmp:
            path = Path(tmp.name)
        try:
            with ZipFile(path, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
                for file in sources():
                    archive.write(file, f"{PROJECT}/{file.relative_to(ROOT)}")
                archive.write(ROOT/instructions, f"{PROJECT}/BUILD.md")
            with ZipFile(path) as archive:
                if archive.testzip():
                    raise ValueError("Source archive integrity check failed")
            path.chmod(0o644)
            path.replace(dest/f"{PROJECT}-{target}-Source.zip")
        finally:
            path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
