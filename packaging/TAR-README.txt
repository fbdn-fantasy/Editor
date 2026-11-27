Editor 1.0.4 for x86-64 Linux

Install GTK 3 and WebKitGTK 4.1 through the distribution's package manager.
On Fedora the packages are gtk3 and webkit2gtk4.1. On Debian and Ubuntu,
install libwebkit2gtk-4.1-0 (this also installs GTK 3).

Desktop setup needs gio, xdg-user-dirs, desktop-file-utils and flock.
Updates need curl and tar. Updating a system-wide installation also needs pkexec
from polkit and a desktop authentication agent.

From the extracted directory, run "sh install.sh --user" for your account.
For a system-wide installation in /usr/local, run "sudo sh install.sh".
Launch Editor in the application menu, or pass file paths to the executable
printed by the installer.
Desktop setup adds an Empty Document template to the configured Templates
folder and selects Editor for empty files. You can change this preference
later in Open With.

To remove a user installation, delete ~/.local/libexec/editor and the
Editor files under applications, editor, doc/editor, and icons/hicolor in
XDG_DATA_HOME (normally ~/.local/share). For a system installation, the
corresponding files are in /usr/local/libexec and /usr/local/share. Remove /etc/xdg/autostart/app.editor.TextEditor-local-setup.desktop
when uninstalling a system TAR. After a TAR
upgrade from 1.0.3, you can also remove the bin/editor-text compatibility link.
