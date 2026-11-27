# Build the Linux portable ZIP

Use the Debian 12 x86-64 build environment from the Linux installer guides.
Install squashfs-tools, curl, file, desktop-file-utils, fakeroot, libfuse2,
bubblewrap, xdg-dbus-proxy and libgpg-error0. The build uses the system GTK 3 and WebKitGTK
4.1 development packages to assemble the fallback runtime.

From the project directory, use a separate Cargo target directory for this
flavor. The portable identifier isolates file opens from the installed edition.
The portable directory override places Editor data next to the AppImage.

```sh
npm ci
export CARGO_TARGET_DIR="$PWD/target-portable"
npm run tauri build -- --no-bundle --config packaging/portable.conf.json
cp "$CARGO_TARGET_DIR/release/editor" "$CARGO_TARGET_DIR/editor-portable"
export LDAI_RUNTIME_FILE="$CARGO_TARGET_DIR/runtime-x86_64"
curl -fL https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64 -o "$LDAI_RUNTIME_FILE"
npm run tauri bundle -- --bundles appimage --config packaging/portable.conf.json --config packaging/appimage-debian.conf.json
python3 scripts/package_linux_portable.py "$CARGO_TARGET_DIR/release/bundle/appimage/Editor.AppDir" "$CARGO_TARGET_DIR/editor-portable" "$LDAI_RUNTIME_FILE" ./release
```

The last step sets the portable desktop entry and icon, adds the launcher and
shortcut helper, and writes the ZIP to release/Portable/Linux. The type 2 runtime
used for 1.0.1 has SHA-256
`617aa77314d57c8b8e4fae9c3f0b35af7b30d5529cb69e98f64f92510ed98a46`.
