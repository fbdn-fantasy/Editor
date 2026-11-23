#!/bin/sh
set -eu
root=$(dirname "$(readlink -f "$0")")
apps="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
shortcut="$apps/app.editor.TextEditor.Portable.desktop"
case "${1:-}" in
    --remove) rm -f -- "$shortcut"; exit 0 ;;
    "") ;;
    *) echo "Usage: sh register-launcher.sh [--remove]" >&2; exit 2 ;;
esac
case "$root" in
    *'
'*) echo "Move the folder to a path without a line break before registering." >&2; exit 1 ;;
esac
mkdir -p -- "$apps"
temp=$(mktemp "$apps/.editor-portable-XXXXXXXX")
trap 'rm -f -- "$temp"' EXIT
# Desktop Exec uses both key-file and command-line escaping.
exec_path=$(printf '%s\n' "$root/Editor.sh" | sed 's/\\/\\\\\\\\/g; s/["`$]/\\\\&/g; s/%/%%/g')
icon_path=$(printf '%s\n' "$root/Editor.png" | sed 's/\\/\\\\/g')
cat > "$temp" <<EOF
[Desktop Entry]
Type=Application
Name=Editor Portable
Exec="$exec_path" %F
Icon=$icon_path
Terminal=false
StartupNotify=true
StartupWMClass=App.editor.TextEditor.Portable
Categories=Utility;TextEditor;
EOF
chmod 644 "$temp"
mv -f -- "$temp" "$shortcut"
printf 'Registered %s\n' "$shortcut"
