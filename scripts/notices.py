"""Collect license and copyright files for the locked Linux/Windows build."""
from collections import defaultdict
import json
import os
from pathlib import Path
import re
import subprocess
import tomllib

root = Path(__file__).resolve().parents[1]
registry = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo")) / "registry/src"
groups = defaultdict(list)


def collect(label, folder, spdx):
    paths = []
    for path in sorted(folder.iterdir()):
        if re.match(r"^(licen[cs]e|copying|copyright|notice)([._-]|$)",path.name,re.I):
            paths.extend([path] if path.is_file() else sorted(p for p in path.rglob("*") if p.is_file()))
    documents = [p.read_text(errors="replace").strip() for p in paths]
    groups[(spdx, "\n\n".join(documents))].append(label)


packages = set()
for target in ["x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"]:
    tree = subprocess.check_output(["cargo","tree","--locked","--target",target,"--edges","normal","--format","{p}","--prefix","none"],
                                   cwd=root/"src-tauri",text=True)
    packages.update((n,v) for n,v in re.findall(r"^([\w-]+) v([^\s]+)",tree,re.M) if n != "editor")
for name, version in sorted(packages):
    directory = next(registry.glob(f"*/{name}-{version}"))
    package = tomllib.loads((directory/"Cargo.toml").read_text())["package"]
    collect(f"{name} {version} (Rust)", directory, package.get("license","See accompanying license"))
lock = json.loads((root/"package-lock.json").read_text())
for path, package in lock["packages"].items():
    if not path or package.get("dev"):
        continue
    directory = root/path
    if directory.is_dir():
        meta = json.loads((directory/"package.json").read_text())
        collect(f"{meta['name']} {meta['version']} (npm)",directory,meta.get("license","See accompanying license"))

content = ["Third-party software notices for Editor 1.0.1",
           "The following notices accompany the bundled libraries. Libraries with identical license files are grouped together."]
for (spdx, body), labels in sorted(groups.items(),key=lambda row: sorted(row[1])[0]):
    content.append("\n".join(sorted(labels)) + "\nLicense: " + spdx + "\n\n" + body)
(root/"THIRD-PARTY-NOTICES.txt").write_text("\n\n".join(content) + "\n")
