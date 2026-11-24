Editor 1.0.3 for x86-64 Linux

Install GTK 3 and WebKitGTK 4.1 through the distribution's package manager.
On Fedora the packages are gtk3 and webkit2gtk4.1. On Debian and Ubuntu,
install libwebkit2gtk-4.1-0 (this also installs GTK 3).

Updates need curl and tar. Updating a system-wide installation also needs pkexec
from polkit and a desktop authentication agent.

From the extracted directory, run "sh install.sh --user" for your account.
For a system-wide installation in /usr/local, run "sudo sh install.sh".
Launch Editor in the application menu, or use editor-text followed by paths.
The installer registers Editor with Open With. Select it as the default
in your desktop's file properties if desired.

To remove a user installation, delete ~/.local/bin/editor-text and the
Editor files under applications, editor-text, doc/editor-text, and icons/hicolor in
XDG_DATA_HOME (normally ~/.local/share). For a system installation, the
corresponding files are in /usr/local/bin and /usr/local/share.
