Editor Portable for x86-64 Linux

Extract the entire ZIP to a writable folder. Open Editor.AppImage or run
./Editor.sh from a terminal. Editor.sh also works on systems without FUSE.
To open a file from the terminal, pass its path to Editor.sh.

Settings, recovery records and the webview profile travel in the Data folder
beside Editor.AppImage. Close Editor before moving the folder or unplugging
the drive. Keep Data when upgrading.

For an application-menu entry, a dock icon, and an Open With option for
plain text and empty documents, run
sh register-launcher.sh in the extracted folder, then pin Editor Portable.
Run the script again if you move the folder. To remove the shortcut, run
sh register-launcher.sh --remove.

Use an x86-64 Linux desktop with X11 or Wayland. With system GTK 3 and
WebKitGTK 4.1, Editor requires glibc 2.34 or later. The bundled fallback
runtime requires glibc 2.36 or later and uses the desktop's graphics drivers
and fonts.
