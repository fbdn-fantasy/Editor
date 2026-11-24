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
        test "$(dpkg-deb -f "$file" Package)" = editor-text
        test "$(dpkg-deb -f "$file" Architecture)" = amd64
        test "$(dpkg-deb -f "$file" Version)" = "$4"
        apt-get -y --no-remove install "$work/$file" ;;
    rpm)
        test "$(rpm -qp --queryformat '%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}' "$file")" = "editor-text-$4-1.x86_64"
        dnf -y install "$work/$file" ;;
    tar-user|tar-system)
        tar --extract --gzip --no-same-owner --no-same-permissions --file "$file"
        # The verified archive provides the same installer used by a fresh TAR installation.
        if [ "$1" = tar-user ]; then
            /bin/sh "Editor-V$4/install.sh" --user
        else
            /bin/sh "Editor-V$4/install.sh"
        fi ;;
esac
