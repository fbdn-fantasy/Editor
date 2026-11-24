#!/bin/sh
set -eu
case "${1:-}" in
  --user) prefix="$HOME/.local"; share="${XDG_DATA_HOME:-$prefix/share}" ;;
  "") prefix=/usr/local; share="$prefix/share" ;;
  *) echo "Usage: sh install.sh [--user]" >&2; exit 2 ;;
esac
cd "$(dirname "$0")"
install -d "$prefix/bin"
stage=$(mktemp "$prefix/bin/.editor-text.XXXXXXXX")
trap 'rm -f "$stage"' EXIT
install -m755 usr/bin/editor-text "$stage"
install -Dm644 usr/share/editor-text/install-format "$share/editor-text/install-format"
for name in LICENSE NOTICE; do
  install -Dm644 "usr/share/doc/editor-text/$name" "$share/doc/editor-text/$name"
done
# Earlier TAR installations exposed the application license under this name.
if [ -f "$share/doc/editor-text/copyright" ]; then
  install -m644 usr/share/doc/editor-text/LICENSE "$share/doc/editor-text/copyright"
fi
install -Dm644 usr/share/doc/editor-text/THIRD-PARTY-NOTICES.txt "$share/doc/editor-text/THIRD-PARTY-NOTICES.txt"
for icon in usr/share/icons/hicolor/*/apps/*.png; do
  install -Dm644 "$icon" "$share/${icon#usr/share/}"
done
install -d "$share/applications"
# Desktop Entry Exec has two escaping layers inside double quotes.
binary=$(printf '%s\n' "$prefix/bin/editor-text" | sed 's/\\/\\\\\\\\/g; s/["`$]/\\\\&/g; s/%/%%/g')
while IFS= read -r line; do
  case "$line" in
    Exec=editor-text*) printf 'Exec="%s"%s\n' "$binary" "${line#Exec=editor-text}" ;;
    *) printf '%s\n' "$line" ;;
  esac
done < usr/share/applications/app.editor.TextEditor.desktop > "$share/applications/app.editor.TextEditor.desktop"
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$share/applications"
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1 && [ -f "$share/icons/hicolor/index.theme" ]; then
  gtk-update-icon-cache -q -t "$share/icons/hicolor"
fi
mv -fT "$stage" "$prefix/bin/editor-text"
printf 'Installed %s\n' "$prefix/bin/editor-text"
