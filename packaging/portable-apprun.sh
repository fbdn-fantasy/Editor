#!/usr/bin/env bash
set -eu
appdir=${APPDIR:-$(dirname "$(readlink -f "$0")")}
binary="$appdir/usr/bin/editor"

# A distro's WebKit matches its graphics stack and uses that distro's updates.
# The clean executable has no RPATH pointing at the bundled libraries.
if LC_ALL=C ldd "$binary" | grep -q 'not found'; then
    # linuxdeploy relocates WebKit's helper paths relative to AppDir/usr.
    # Resolve file arguments before changing the working directory.
    files=()
    for file in "$@"; do
        case "$file" in
            --|/*) files+=("$file") ;;
            *) files+=("$PWD/$file") ;;
        esac
    done
    export APPDIR="$appdir"
    export XDG_DATA_DIRS="${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
    source "$appdir/apprun-hooks/linuxdeploy-plugin-gtk.sh"
    export LD_LIBRARY_PATH="$appdir/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    cd "$appdir/usr"
    exec "$binary" "${files[@]}"
fi
exec "$binary" "$@"
