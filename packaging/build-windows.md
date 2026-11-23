# Build the Windows 11 x64 installer

Install Node.js 22.12 or newer, npm and current stable Rust. The tested cross-build used Fedora 44, Rust 1.100, cargo-xwin, LLVM/Clang, LLD, llvm-rc, NSIS and the x86_64-pc-windows-msvc target. Cargo XWin needs access to its Microsoft SDK cache. Tauri's bundler also requires its matching NSIS helper plug-in. Allow dependency downloads for a fresh development environment.

Run from the extracted project directory.

```sh
rustup target add x86_64-pc-windows-msvc
npm ci
npm run check
npm test
npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis
```

The resulting installer is src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Editor_1.0.1_x64-setup.exe unless CARGO_TARGET_DIR overrides the output location. Distribute it as Editor-1.0.1-x64-setup.exe. The installer uses a per-user installation and registers Open With and default-app capabilities. It installs the WebView2 Evergreen runtime via Microsoft's bootstrapper when the runtime is missing. That prerequisite step requires a network connection. Installed editing works offline.

For the portable ZIP, run the following from the project directory after building the installer. Set the executable path to the output under CARGO_TARGET_DIR if you use a custom target directory.

```sh
npm run tauri build -- --runner cargo-xwin --target x86_64-pc-windows-msvc --no-bundle --config packaging/portable.conf.json
python3 scripts/package_windows_portable.py src-tauri/target/x86_64-pc-windows-msvc/release/editor.exe ./release
```

The portable executable starts directly from the extracted folder. Its build configuration places settings, recovery records and the WebView2 profile in a sibling Data directory. It uses the system WebView2 runtime.

To build on Windows, install Visual Studio C++ Build Tools and the Windows SDK, then use the same npm steps and omit `--runner cargo-xwin`. An unsigned installer can trigger the Windows reputation prompt.
