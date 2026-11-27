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
| Windows 11 | EXE installer |
| Fedora | RPM |
| Debian / Ubuntu | DEB |
| Linux | TAR.GZ |

Visit the [Releases](https://github.com/fbdn-fantasy/Editor/releases) section to download the latest version.

## Empty files

Use **File → New**, then **Save** to create a zero-byte file with any name.

- In Windows Explorer, choose **New → Empty Document**, name the file and double-click it. The new `.editordoc` file opens in Editor. For an existing extensionless file, use **Open with Editor** in the context menu (under **Show more options** on Windows 11).
- On Fedora, choose **New Document → Empty Document**, then double-click the extensionless file. Editor adds the blank template and sets the empty-file association at first desktop setup. You can change that association later in your file manager. Debian 12 may classify a zero-byte file as plain text. Use **Open With → Editor** there if you have a different plain-text default.

## Updating from V1.0.3

Choose **Help → Check for Updates** in the installed app. On Windows, close all Editor windows when prompted so Setup can run. TAR installations keep their current install scope. On Fedora and Debian, reopen Editor after the first update, choose **Finish update** and authorize the package manager to replace `editor-text` with `editor`. This second step uses a verified copy included in the first download. Choose **Later** to keep editing and finish through the Help menu when ready. To upgrade directly, install the new `editor` RPM or DEB with the system package manager.

V1.0.3 portable copies use manual upgrades. To move to the installed edition, install the new package and open your documents in Editor.

### Publishing update assets

Create a GitHub release with **V1.0.4** as both its tag and title. Attach the eight installation and update assets below, plus the four matching source ZIPs, and publish it as the **Latest** stable release. The updater reads GitHub Release assets and verifies their SHA-256 digests. A source push alone does not publish an update.

| Platform | New installations and updates from V1.0.4 | Updates from V1.0.3 |
|---|---|---|
| Windows | `editor-1.0.4-Setup.exe` | `Editor-V1.0.4-Setup.exe` |
| Fedora | `editor-1.0.4-1.x86_64.rpm` | `editor-text-1.0.4-1.x86_64.rpm` |
| Debian / Ubuntu | `editor-1.0.4.deb` | `Editor-V1.0.4.deb` |
| Linux TAR | `editor-1.0.4.tar.gz` | `Editor-V1.0.4.tar.gz` |

Build the canonical RPM and DEB first. Run each `scripts/package_linux.py` build command again with `--legacy-update` to create the two transition packages. Each carries a complete Editor installation and its matching canonical package. The two Windows assets are identical, as are the two TAR assets.

V1.0.3 only checks the **latest** stable release. For later releases that still support direct updates from V1.0.3, generate and attach both sets of assets with the new release version. V1.0.4 and newer select the lowercase canonical filenames.

## License

Editor is free and open-source software released under the [GNU Affero General Public License v3.0 only](LICENSE).