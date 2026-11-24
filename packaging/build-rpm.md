# Build the Fedora RPM

Install Node.js 22.12 or newer, npm, a stable Rust toolchain (tested with Rust 1.100), Python 3, GCC, binutils, pkg-config and the GTK 3, WebKitGTK 4.1 and OpenSSL development headers. On Fedora, install gcc, gcc-c++, pkgconf-pkg-config, gtk3-devel, webkit2gtk4.1-devel, openssl-devel and rpm-build. On Debian, install build-essential, pkg-config, libgtk-3-dev, libwebkit2gtk-4.1-dev and libssl-dev. Use a glibc-based x86-64 build environment.

The build environment determines the minimum glibc version. Use an older compatible build environment for a lower glibc requirement. For Fedora packaging, the packaging host also needs rpmbuild. Python 3 and binutils ar are sufficient to assemble the DEB and TAR from the compiled executable.

Build the application from the extracted project directory.

```sh
npm ci
npm run check
npm test
npm run build
cargo build --manifest-path src-tauri/Cargo.toml --release --locked --features custom-protocol
python3 scripts/package_linux.py rpm src-tauri/target/release/editor ./release
```

The result is written under release/Linux/RPM/. If CARGO_TARGET_DIR is set, supply the appropriate release/editor path. Packaging does not change system defaults. The executable is installed as editor-text to coexist with the system's editor command.

Install using dnf install ./release/Linux/RPM/*.rpm. The package declares its runtime libraries and installs an XDG desktop entry and icon resources.
