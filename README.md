# Editor

Editor is a lightweight text and code editor for Windows and Linux, designed with simplicity in mind. Whether you're writing notes, editing configuration files, working with Markdown, or writing code, Editor provides a clean and straightforward environment without unnecessary clutter.

Simply open the application and start typing.

## Features

- **Tabbed editing** – Open and edit multiple files in a single window, with independent undo and redo history.
- **Empty documents** – Save a blank document with or without a file extension.
- **Automatic language detection** – Recognizes programming languages as you type, even before saving a file.
- **Syntax highlighting** – Makes source code easier to read and navigate.
- **Predictive typing** – Suggests keywords, functions, variables, and existing document words. Accept suggestions using Tab or disable code assistance whenever you prefer.
- **Autosave** – Automatically saves changes to existing files, with configurable saving intervals.
- **Crash recovery** – Recover unsaved work following an unexpected application closure.
- **Find and replace** – Quickly search, replace text, or navigate to a specific line.
- **Editing guides** – Line numbers, indentation guides, bracket matching, and a live character counter.
- **Light and dark modes** – Follow your system theme or choose your own preference.
- **Accessibility** – Adjust interface scaling, text size, line spacing, and contrast.
- **Update button** – Choose Help → Check for Updates to download and install a newer release for your platform when one is available.

All editing features, language detection, and code suggestions work locally without requiring an internet connection.

## Supported languages and files

Editor supports a wide range of text-based formats, including:

- **Text and documentation:** Plain text, Markdown and log files.
- **Web development:** HTML, CSS, SCSS, JavaScript, TypeScript, Svelte and PHP.
- **Programming:** Python, Rust, C, C++, C#, Java, Kotlin, Go, Swift, Dart and Ruby.
- **Configuration and data:** JSON, XML, YAML, TOML, INI, CSV and TSV.
- **Scripting and build files:** Bash, PowerShell, Lua, R, SQL, Dockerfiles and Makefiles.

Other text-based files can also be opened and edited as plain text.

## Downloads

Editor is available for Windows 11 and Linux.

| Platform | Available packages |
|---|---|
| Windows 11 | EXE installer, portable ZIP |
| Fedora | RPM |
| Debian / Ubuntu | DEB |
| Linux | TAR.GZ, portable ZIP |

Visit the [Releases](../../releases) section to download the latest version.

## System requirements

All packages are intended for 64-bit Intel and AMD systems (x86-64).

### Windows 11

- Microsoft Edge WebView2 runtime.
- The installer automatically downloads the runtime if it is missing.
- The portable edition requires WebView2 to already be installed.

### Linux installers

- X11 or Wayland desktop environment.
- glibc 2.34 or later.
- GTK 3.
- WebKitGTK 4.1.

## License

Editor is free and open-source software released under the [GNU Affero General Public License v3.0 only](LICENSE).
