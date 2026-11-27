#!/bin/sh
# Runs as the desktop user. One successful setup per profile lets a later
# Open With choice or template removal survive upgrades and future logins.
set -eu
state="${XDG_STATE_HOME:-$HOME/.local/state}/app.editor.TextEditor"
mkdir -p "$state"
exec 9>"$state/desktop-setup.lock"
flock 9
[ ! -f "$state/empty-documents-v1" ] || exit 0

config="${XDG_CONFIG_HOME:-$HOME/.config}"
dirs="$config/user-dirs.dirs"
templates="$HOME"
if [ -f "$dirs" ]; then
    # Some xdg-user-dir scripts do not quote XDG_CONFIG_HOME. A relative path
    # in a subshell also works for a profile with spaces in its directory name.
    templates=$(cd "$config" && XDG_CONFIG_HOME=. xdg-user-dir TEMPLATES)
fi
# Missing XDG configuration is different from deliberately setting Templates
# to HOME, the standard way to disable this directory.
if [ "$templates" = "$HOME" ] && ! grep -qs '^[[:space:]]*XDG_TEMPLATES_DIR=' "$dirs"; then
    templates="$HOME/Templates"
    xdg-user-dirs-update --set TEMPLATES "$templates"
fi
if [ -n "$templates" ] && [ "$templates" != "$HOME" ] && [ "$templates" != "$HOME/" ]; then
    mkdir -p "$templates"
    template="$templates/Empty Document"
    # Preserve a custom template with the same name.
    if [ -e "$template" ] && { [ ! -f "$template" ] || [ -s "$template" ]; }; then
        template="$templates/Empty Document (Editor)"
    fi
    if [ ! -e "$template" ] && [ ! -L "$template" ]; then
        ( set -C; : > "$template" )
    fi
fi
for type in application/x-zerosize inode/x-empty; do
    gio mime "$type" app.editor.TextEditor.desktop >/dev/null
done
touch "$state/empty-documents-v1"
