#!/bin/sh
# Package transactions run as root. Ask the logged-in user's service manager
# to run setup with that session's XDG paths; autostart covers future logins.
set -u
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
helper=$(dirname "$0")/desktop-setup
uids() {
    printf '%s\n' "${PKEXEC_UID:-}" "${SUDO_UID:-}"
    command -v loginctl >/dev/null 2>&1 || return 0
    loginctl list-sessions --no-legend --no-pager 2>/dev/null | awk '{print $1}' |
    while read -r session; do
        case "$(loginctl show-session "$session" -p Type --value 2>/dev/null)" in
            x11|wayland) loginctl show-session "$session" -p User --value 2>/dev/null ;;
        esac
    done
}
uids | sort -u | while read -r uid; do
    case "$uid" in ''|0|*[!0-9]*) continue ;; esac
    entry=$(getent passwd "$uid") || continue
    user=$(printf '%s\n' "$entry" | cut -d: -f1)
    home=$(printf '%s\n' "$entry" | cut -d: -f6)
    [ -d "$home" ] || continue
    runtime="/run/user/$uid"
    if [ -S "$runtime/bus" ]; then
        runuser -u "$user" -- env -i HOME="$home" PATH="$PATH" XDG_RUNTIME_DIR="$runtime" \
            DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime/bus" systemd-run --user --collect --wait --quiet "$helper" && continue
    fi
    runuser -u "$user" -- env -i HOME="$home" PATH="$PATH" "$helper" || :
done
