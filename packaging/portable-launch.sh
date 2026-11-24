#!/bin/sh
set -eu
image="$(dirname "$(readlink -f "$0")")/Editor.AppImage"
if [ -c /dev/fuse ] && [ -r /dev/fuse ] && [ -w /dev/fuse ]; then
    exec "$image" "$@"
fi
exec "$image" --appimage-extract-and-run "$@"
