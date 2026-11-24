"""Collect bundled dependency notices for the locked Linux and Windows build."""
from collections import defaultdict
import json
import os
from pathlib import Path
import re
import subprocess
import tomllib

root = Path(__file__).resolve().parents[1]
registry = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo")) / "registry/src"
supplemental = root / "packaging/licenses"
groups = defaultdict(list)


def crate_folder(name, version):
    return next(registry.glob(f"*/{name}-{version}"))


def collect(label, folder, spdx, fallback=None):
    paths = []
    for path in sorted(folder.iterdir()):
        if re.match(r"^(licen[cs]e|copying|copyright|notice)([._-]|$)", path.name, re.I):
            paths.extend([path] if path.is_file() else sorted(p for p in path.rglob("*") if p.is_file()))
    if paths:
        text = "\n\n".join(p.read_text(errors="replace").strip() for p in paths)
    elif fallback:
        text = fallback.read_text().strip()
    else:
        raise ValueError(f"{label} is missing its license text")
    groups[(spdx, text)].append(label)


packages = set()
for target in ["x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu"]:
    tree = subprocess.check_output(["cargo", "tree", "--locked", "--target", target, "--edges",
                                    "normal", "--format", "{p}", "--prefix", "none"],
                                   cwd=root/"src-tauri", text=True)
    packages.update((n,v) for n,v in re.findall(r"^([\w-]+) v([^\s]+)",tree,re.M) if n != "editor")

# These crate distributions omit the license from the root of their upstream
# workspace. Use the repository license or the identical sibling crate license.
versions = dict(packages)
fallback = {
    "alloc-stdlib": crate_folder("alloc-no-stdlib", versions["alloc-no-stdlib"]) / "LICENSE",
    "selectors": crate_folder("cssparser", versions["cssparser"]) / "LICENSE",
}
for name in ("dlopen2", "dlopen2_derive"):
    fallback[name] = supplemental / "dlopen2.txt"
for name in ("webview2-com", "webview2-com-sys", "webview2-com-macros"):
    fallback[name] = supplemental / "webview2-rs.txt"

for name, version in sorted(packages):
    directory = crate_folder(name, version)
    package = tomllib.loads((directory/"Cargo.toml").read_text())["package"]
    collect(f"{name} {version} (Rust)", directory, package.get("license", "See accompanying license"), fallback.get(name))

lock = json.loads((root/"package-lock.json").read_text())
for path, package in lock["packages"].items():
    if not path or package.get("dev"):
        continue
    directory = root/path
    meta = json.loads((directory/"package.json").read_text())
    # These upstream packages declare MIT and credit their author in package
    # metadata but omit a standalone license file in both source and tarballs.
    missing = supplemental / "rich-harris-mit.txt" if meta["name"] in ("is-reference", "locate-character") else None
    collect(f"{meta['name']} {meta['version']} (npm)", directory, meta["license"], missing)

version = json.loads((root/"package.json").read_text())["version"]
content = [f"Third-party software notices for Editor {version}",
           "The following notices accompany the bundled libraries. Libraries with identical license files are grouped together.",
           "The exact source versions of Rust and JavaScript dependencies are listed in Cargo.lock and package-lock.json. "
           "The corresponding sources are available from https://crates.io and https://www.npmjs.com. "
           "MPL-2.0 covered source files remain available under that license and additionally under AGPL-3.0-only "
           "as part of this combined program, in accordance with MPL-2.0 section 3.3."]
for (spdx, body), labels in sorted(groups.items(), key=lambda row: sorted(row[1])[0]):
    content.append("\n".join(sorted(labels)) + "\nLicense: " + spdx + "\n\n" + body)
for title, filename in [
    ("Microsoft WebView2 SDK 1.0.3800.47 (Windows loader)", "webview2-sdk-license.txt"),
    ("Microsoft WebView2 SDK third-party notices", "webview2-sdk-notice.txt"),
    ("NSIS 3.11 (Windows installer)\nSource: https://sourceforge.net/projects/nsis/files/NSIS%203/3.11/", "nsis.txt"),
    ("Tauri NSIS utilities 0.5.3 (Windows installer)", "nsis-tauri-utils.txt"),
]:
    content.append(title + "\n\n" + (supplemental/filename).read_text().strip())
(root/"THIRD-PARTY-NOTICES.txt").write_text("\n\n".join(content) + "\n")
