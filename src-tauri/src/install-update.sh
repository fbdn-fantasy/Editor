# Called with a verified release asset. Recheck a private copy in the installing
# user's security context before passing it to the platform package manager.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
work=$(mktemp -d /tmp/editor-update.XXXXXXXXXX)
trap 'rm -rf -- "$work"' EXIT
cd "$work"
case "$1" in
    deb) file=editor.deb ;;
    rpm) file=editor.rpm ;;
    tar-user|tar-system) file=editor.tar.gz ;;
    *) exit 2 ;;
esac
cp -- "$2" "$file"
printf '%s  %s\n' "$3" "$file" | sha256sum --check --status
umask 022
case "$1" in
    deb)
        test "$(dpkg-deb -f "$file" Package)" = editor
        test "$(dpkg-deb -f "$file" Architecture)" = amd64
        test "$(dpkg-deb -f "$file" Version)" = "$4"
        if [ -f /usr/share/editor/legacy-update/editor.deb ]; then
            # The canonical package Conflicts/Replaces the old identity. dpkg
            # performs this one local replacement using installed dependencies.
            dpkg --install "$work/$file"
        else
            apt-get -y --no-remove install "$work/$file"
        fi ;;
    rpm)
        test "$(rpm -qp --queryformat '%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}' "$file")" = "editor-$4-1.x86_64"
        if [ -f /usr/share/editor/legacy-update/editor.rpm ]; then
            # The transition package already has the same runtime dependencies.
            mkdir "$work/empty-repos"
            dnf --setopt="reposdir=$work/empty-repos" -y install "$work/$file"
        else
            dnf -y install "$work/$file"
        fi ;;
    tar-user|tar-system)
        tar --extract --gzip --no-same-owner --no-same-permissions --file "$file"
        # The verified archive provides the same installer used by a fresh TAR installation.
        if [ "$1" = tar-user ]; then
            /bin/sh "Editor-V$4/install.sh" --user
        else
            /bin/sh "Editor-V$4/install.sh"
        fi ;;
esac
