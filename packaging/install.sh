#!/bin/sh
set -eu
case "${1:-}" in
  --user) prefix="$HOME/.local"; share="${XDG_DATA_HOME:-$prefix/share}" ;;
  "") prefix=/usr/local; share="$prefix/share" ;;
  *) echo "Usage: sh install.sh [--user]" >&2; exit 2 ;;
esac
cd "$(dirname "$0")"
bindir="$prefix/libexec/editor"
install -d "$bindir"
stage=$(mktemp "$bindir/.editor.XXXXXXXX")
desktop_stage=''
trap 'rm -f -- "$stage" "$desktop_stage"' EXIT
install -m755 usr/libexec/editor/editor "$stage"
for helper in desktop-setup setup-active-desktops; do
  install -m755 "usr/libexec/editor/$helper" "$bindir/$helper"
done
install -Dm644 usr/share/editor/install-format "$share/editor/install-format"
for name in LICENSE NOTICE THIRD-PARTY-NOTICES.txt; do
  install -Dm644 "usr/share/doc/editor/$name" "$share/doc/editor/$name"
done
for icon in usr/share/icons/hicolor/*/apps/*.png; do
  install -Dm644 "$icon" "$share/${icon#usr/share/}"
done
install -d "$share/applications"
desktop_stage=$(mktemp "$share/applications/.editor-desktop.XXXXXXXX")
# Desktop Entry Exec has two escaping layers inside double quotes.
binary=$(printf '%s\n' "$bindir/editor" | sed 's/\\/\\\\\\\\/g; s/["`$]/\\\\&/g; s/%/%%/g')
while IFS= read -r line; do
  case "$line" in
    Exec=/usr/libexec/editor/editor*) printf 'Exec="%s"%s\n' "$binary" "${line#Exec=/usr/libexec/editor/editor}" ;;
    *) printf '%s\n' "$line" ;;
  esac
done < usr/share/applications/app.editor.TextEditor.desktop > "$desktop_stage"
chmod 644 "$desktop_stage"
mv -fT "$stage" "$bindir/editor"
mv -fT "$desktop_stage" "$share/applications/app.editor.TextEditor.desktop"
# Keep existing command-line shortcuts working after a TAR upgrade.
if [ "$(cat "$share/editor-text/install-format" 2>/dev/null)" = tar ]; then
  if [ -f "$prefix/bin/editor-text" ]; then
    ln -sfn "$bindir/editor" "$prefix/bin/editor-text"
  fi
  rm -f "$share/editor-text/install-format"
  for name in LICENSE NOTICE THIRD-PARTY-NOTICES.txt copyright; do
    rm -f "$share/doc/editor-text/$name"
  done
  rmdir "$share/editor-text" "$share/doc/editor-text" 2>/dev/null || :
fi
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$share/applications"
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1 && [ -f "$share/icons/hicolor/index.theme" ]; then
  gtk-update-icon-cache -q -t "$share/icons/hicolor"
fi
if [ "${1:-}" = --user ]; then
  "$bindir/desktop-setup"
else
  install -d /etc/xdg/autostart
  sed 's|Exec=/usr/libexec/|Exec=/usr/local/libexec/|' etc/xdg/autostart/app.editor.TextEditor-setup.desktop > /etc/xdg/autostart/app.editor.TextEditor-local-setup.desktop
  chmod 644 /etc/xdg/autostart/app.editor.TextEditor-local-setup.desktop
  "$bindir/setup-active-desktops"
fi
printf 'Installed %s\n' "$bindir/editor"
