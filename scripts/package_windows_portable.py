"""Package the Windows x64 executable built with packaging/portable.conf.json."""
import argparse
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("output", type=Path, help="release directory")
    args = parser.parse_args()
    version = json.loads((ROOT / "package.json").read_text())["version"]
    name = f"editor-{version}-Windows-Portable"
    dest = args.output / "Portable/Windows"
    dest.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(dir=dest) as staging:
        output = Path(staging) / f"{name}.zip"
        with ZipFile(output, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
            for source, filename in [
                (args.binary, "Editor.exe"),
                (ROOT / "LICENSE", "LICENSE"),
                (ROOT / "NOTICE", "NOTICE"),
                (ROOT / "THIRD-PARTY-NOTICES.txt", "THIRD-PARTY-NOTICES.txt"),
                (ROOT / "packaging/WINDOWS-PORTABLE-README.txt", "README.txt"),
            ]:
                archive.write(source, f"{name}/{filename}")
        output.replace(dest / output.name)


if __name__ == "__main__":
    main()
