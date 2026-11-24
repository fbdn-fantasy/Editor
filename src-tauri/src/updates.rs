//! On-demand updates from the Editor repository's latest public, stable release.
use crate::files::{Result, err};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
};
use tauri::{AppHandle, ipc::Channel};

const LATEST: &str = "https://api.github.com/repos/fbdn-fantasy/Editor/releases/latest";
const DOWNLOADS: &str = "https://github.com/fbdn-fantasy/Editor/releases/download";
const METADATA_LIMIT: u64 = 2 * 1024 * 1024;
const PACKAGE_LIMIT: u64 = 256 * 1024 * 1024;

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    state: String,
    size: u64,
    digest: Option<String>,
    browser_download_url: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
#[cfg_attr(not(test), allow(dead_code))] // A distribution runs on only one platform.
enum Format {
    Windows,
    Deb,
    Rpm,
    TarUser,
    TarSystem,
}

impl Format {
    fn filename(self, version: &str) -> String {
        match self {
            Self::Windows => format!("Editor-V{version}-Setup.exe"),
            Self::Deb => format!("Editor-V{version}.deb"),
            Self::Rpm => format!("editor-text-{version}-1.x86_64.rpm"),
            Self::TarUser | Self::TarSystem => format!("Editor-V{version}.tar.gz"),
        }
    }
}

fn version(tag: &str) -> Result<[u64; 3]> {
    let value = tag.strip_prefix(['v', 'V']).unwrap_or(tag);
    let mut parts = value.split('.');
    let mut numbers = [0; 3];
    for number in &mut numbers {
        let part = parts.next().unwrap_or("");
        if !part.bytes().all(|b| b.is_ascii_digit()) || (part.len() > 1 && part.starts_with('0')) {
            return Err(
                "The release tag must contain a numeric major, minor and patch version.".into(),
            );
        }
        *number = part.parse().map_err(|_| "Invalid release version.")?;
    }
    if parts.next().is_some() {
        return Err("Invalid release version.".into());
    }
    Ok(numbers)
}

fn latest_version(release: &Release, current: &str) -> Result<Option<String>> {
    if release.draft || release.prerelease {
        return Ok(None);
    }
    let numbers = version(&release.tag_name)?;
    Ok((numbers > version(current)?)
        .then(|| format!("{}.{}.{}", numbers[0], numbers[1], numbers[2])))
}

fn package<'a>(
    release: &'a Release,
    format: Format,
    version: &str,
) -> Result<(&'a Asset, &'a str)> {
    let name = format.filename(version);
    let asset = release.assets.iter().find(|a| a.name == name && a.state == "uploaded")
        .ok_or_else(|| format!("The V{version} release is missing {name}. Try again when the package has been published."))?;
    if asset.size == 0
        || asset.size > PACKAGE_LIMIT
        || asset.browser_download_url != format!("{DOWNLOADS}/{}/{}", release.tag_name, name)
    {
        return Err("GitHub returned an invalid package location or size.".into());
    }
    let digest = asset
        .digest
        .as_deref()
        .and_then(|value| value.strip_prefix("sha256:"))
        .filter(|hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("The release package has no valid GitHub SHA-256 digest.")?;
    Ok((asset, digest))
}

#[cfg(target_os = "linux")]
fn installed_format() -> Result<Format> {
    let exe = std::env::current_exe().map_err(err)?;
    if exe.as_os_str().as_encoded_bytes().ends_with(b" (deleted)") {
        return Err("The running Editor executable has already been replaced. Close and reopen Editor to check again.".into());
    }
    // The user's home, .local or bin directory may itself be a symlink.
    let running_at =
        |path: &Path| path == exe || path.canonicalize().is_ok_and(|resolved| resolved == exe);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let data = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute());
    let (share, scope) = if running_at(Path::new("/usr/bin/editor-text")) {
        (PathBuf::from("/usr/share"), None)
    } else if running_at(Path::new("/usr/local/bin/editor-text")) {
        (PathBuf::from("/usr/local/share"), Some(Format::TarSystem))
    } else if let Some(prefix) = home.map(|p| p.join(".local"))
        && running_at(&prefix.join("bin/editor-text"))
    {
        (
            data.unwrap_or_else(|| prefix.join("share")),
            Some(Format::TarUser),
        )
    } else {
        return Err(
            "Automatic installation requires an installed Editor DEB, RPM or TAR package.".into(),
        );
    };
    let marker = fs::read_to_string(share.join("editor-text/install-format"))
        .map_err(|_| "The installed Editor package format could not be identified.")?;
    match (marker.trim(), scope) {
        ("deb", None) => Ok(Format::Deb),
        ("rpm", None) => Ok(Format::Rpm),
        ("tar", Some(format)) => Ok(format),
        _ => Err("The Editor installation has an unexpected package format.".into()),
    }
}

#[cfg(windows)]
fn installed_format() -> Result<Format> {
    Ok(Format::Windows)
}

fn fetch(url: &str, path: &Path, limit: u64, metadata: bool) -> Result<u16> {
    #[cfg(windows)]
    let curl = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or("Windows system directory was unavailable.")?
        .join("System32/curl.exe");
    #[cfg(target_os = "linux")]
    let curl = "/usr/bin/curl";
    let mut command = Command::new(curl);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let accept = if metadata {
        "Accept: application/vnd.github+json"
    } else {
        "Accept: application/octet-stream"
    };
    let timeout = if metadata { "20" } else { "300" };
    let mut destination = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(err)?;
    let mut child = command
        .args([
            "-q",
            "--silent",
            "--location",
            "--max-redirs",
            "5",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--tlsv1.2",
            "--connect-timeout",
            "10",
            "--max-time",
            timeout,
            "--max-filesize",
            &limit.to_string(),
            "--user-agent",
            concat!("Editor/", env!("CARGO_PKG_VERSION")),
            "--header",
            accept,
            "--output",
            "-",
            "--write-out",
            "%{stderr}%{http_code}",
            "--",
            url,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Could not start the system curl HTTPS client.")?;
    // Older curl versions only enforce --max-filesize when the server sends a
    // Content-Length. Bound the actual byte stream before it reaches disk.
    let stdout = child.stdout.take().expect("curl stdout is piped");
    let copied = io::copy(&mut stdout.take(limit + 1), &mut destination);
    if !matches!(copied, Ok(n) if n <= limit) {
        let _ = child.kill();
        let _ = child.wait();
        copied.map_err(err)?;
        return Err("The GitHub response exceeded its size limit.".into());
    }
    let response = child.wait_with_output().map_err(err)?;
    if !response.status.success() {
        return Err("Could not download the update information or package. Check your connection and try again.".into());
    }
    String::from_utf8_lossy(&response.stderr)
        .trim()
        .parse()
        .map_err(|_| "GitHub returned an invalid HTTP status.".into())
}

fn verify(mut file: impl Read, expected_size: u64, digest: &str) -> Result<()> {
    let mut hasher = Sha256::new();
    let size = io::copy(&mut (&mut file).take(expected_size + 1), &mut hasher).map_err(err)?;
    if size != expected_size || !hex::encode(hasher.finalize()).eq_ignore_ascii_case(digest) {
        return Err(
            "The package failed its size or SHA-256 check. Editor did not install it.".into(),
        );
    }
    Ok(())
}

struct Applied {
    message: String,
    #[cfg(windows)]
    installer: PathBuf,
    #[cfg(windows)]
    digest: String,
    #[cfg(windows)]
    size: u64,
}

static UPDATE: Mutex<Option<Applied>> = Mutex::new(None);

#[cfg(target_os = "linux")]
fn install(format: Format, archive: &Path, digest: &str, version: &str) -> Result<Applied> {
    let kind = match format {
        Format::Deb => "deb",
        Format::Rpm => "rpm",
        Format::TarSystem => "tar-system",
        Format::TarUser => "tar-user",
        _ => return Err("Unsupported Linux package.".into()),
    };
    let mut command = if format == Format::TarUser {
        Command::new("/bin/sh")
    } else {
        let mut privileged = Command::new("/usr/bin/pkexec");
        privileged.arg("/bin/sh");
        privileged
    };
    let status = command.args(["-c", include_str!("install-update.sh"), "editor-update", kind])
        .arg(archive).args([digest, version]).stdin(Stdio::null()).status()
        .map_err(|_| "Could not start the package installer. Check that the installation tools and a PolicyKit authentication agent are available.")?;
    if !status.success() {
        if matches!(status.code(), Some(126)) {
            return Err("Update authorization was canceled.".into());
        }
        return Err("The package installer could not complete the update. Check authorization, available disk space and the package manager, then try again.".into());
    }
    Ok(Applied {
        message: format!("Editor V{version} is installed. Close and reopen Editor to use it."),
    })
}

#[cfg(windows)]
fn stage(app: &AppHandle, path: &Path, hash: &str, size: u64, version: &str) -> Result<Applied> {
    use tauri::Manager;
    let cache = app.path().app_cache_dir().map_err(err)?.join("updates");
    fs::create_dir_all(&cache).map_err(err)?;
    let installer = cache.join(Format::Windows.filename(version));
    let mut staged = tempfile::NamedTempFile::new_in(cache).map_err(err)?;
    io::copy(&mut fs::File::open(path).map_err(err)?, &mut staged).map_err(err)?;
    staged.as_file().sync_all().map_err(err)?;
    staged.persist(&installer).map_err(err)?;
    Ok(Applied {
        message: format!(
            "Editor V{version} is ready. Close all Editor windows when you are ready. Setup will install the update automatically."
        ),
        installer,
        digest: hash.to_string(),
        size,
    })
}

#[cfg(windows)]
pub fn clear_applied(app: &AppHandle) {
    use tauri::Manager;
    let Ok(cache) = app.path().app_cache_dir() else {
        return;
    };
    let Ok(entries) = fs::read_dir(cache.join("updates")) else {
        return;
    };
    let Ok(current) = version(env!("CARGO_PKG_VERSION")) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(tag) = name
            .to_str()
            .and_then(|name| name.strip_prefix("Editor-V"))
            .and_then(|name| name.strip_suffix("-Setup.exe"))
        else {
            continue;
        };
        if version(tag).is_ok_and(|number| number <= current) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[cfg(windows)]
pub fn on_exit(_app: &AppHandle) {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
    let Ok(mut state) = UPDATE.try_lock() else {
        return;
    };
    let Some(update) = state.take() else {
        return;
    };
    let start = || -> Result<()> {
        // Prevent changes to the verified executable between verification and launch.
        let file = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&update.installer)
            .map_err(err)?;
        verify(&file, update.size, &update.digest)?;
        Command::new(&update.installer)
            .args(["/P", "/UPDATE"])
            .spawn()
            .map_err(err)?;
        Ok(())
    };
    if let Err(error) = start() {
        let message: Vec<_> = format!("Could not start the verified Editor update. {error}")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        // Tauri's event loop is exiting. Use the native dialog directly here.
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                message.as_ptr(),
                windows_sys::w!("Editor update"),
                MB_OK | MB_ICONERROR,
            );
        }
    }
}

#[tauri::command]
pub async fn update_editor(app: AppHandle, progress: Channel<String>) -> Result<String> {
    if app.config().identifier.contains(".Portable") {
        return Err(
            "Automatic installation is available in the installed version of Editor.".into(),
        );
    }
    crate::blocking(move || {
        let mut state = UPDATE
            .try_lock()
            .map_err(|_| "An update check is already in progress.")?;
        if let Some(update) = &*state {
            return Ok(update.message.clone());
        }
        let mut builder = tempfile::Builder::new();
        builder.prefix("editor-update-");
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(fs::Permissions::from_mode(0o700));
        }
        let dir = builder.tempdir().map_err(err)?;
        let metadata = dir.path().join("release.json");
        match fetch(LATEST, &metadata, METADATA_LIMIT, true)? {
            200 => (),
            404 => return Ok("GitHub has no public stable release available for Editor.".into()),
            403 | 429 => return Err("GitHub limited the update request. Try again later.".into()),
            code => return Err(format!("GitHub could not check for updates (HTTP {code}).")),
        }
        if fs::metadata(&metadata).map_err(err)?.len() > METADATA_LIMIT {
            return Err("The release metadata is too large.".into());
        }
        let bytes = fs::read(&metadata).map_err(err)?;
        let release: Release = serde_json::from_slice(&bytes)
            .map_err(|_| "GitHub returned invalid release metadata.")?;
        let current = env!("CARGO_PKG_VERSION");
        let Some(version) = latest_version(&release, current)? else {
            return Ok(format!("Editor V{current} is up to date."));
        };
        if !cfg!(target_arch = "x86_64") {
            return Err("No update package is available for this CPU architecture.".into());
        }
        let format = installed_format()?;
        let (asset, digest) = package(&release, format, &version)?;
        let _ = progress.send(format!("Downloading Editor V{version}…"));
        let path = dir.path().join(&asset.name);
        let status = fetch(&asset.browser_download_url, &path, asset.size, false)?;
        if status != 200 {
            return Err(format!(
                "GitHub could not deliver the update package (HTTP {status})."
            ));
        }
        verify(fs::File::open(&path).map_err(err)?, asset.size, digest)?;
        let _ = progress.send(format!("Installing Editor V{version}…"));
        #[cfg(windows)]
        let applied = stage(&app, &path, digest, asset.size, &version)?;
        #[cfg(target_os = "linux")]
        let applied = install(format, &path, digest, &version)?;
        let message = applied.message.clone();
        *state = Some(applied);
        Ok(message)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release() -> Release {
        let tag = "V1.10.0";
        let hash = hex::encode(Sha256::digest(b"package"));
        let assets = [Format::Windows, Format::Deb, Format::Rpm, Format::TarUser]
            .into_iter()
            .map(|format| {
                let name = format.filename("1.10.0");
                Asset {
                    browser_download_url: format!("{DOWNLOADS}/{tag}/{name}"),
                    name,
                    state: "uploaded".into(),
                    size: 7,
                    digest: Some(format!("sha256:{hash}")),
                }
            })
            .collect();
        Release {
            tag_name: tag.into(),
            draft: false,
            prerelease: false,
            assets,
        }
    }

    #[test]
    fn stable_versions_advance_numerically() {
        let mut r = release();
        assert_eq!(
            latest_version(&r, "1.9.99").unwrap().as_deref(),
            Some("1.10.0")
        );
        assert_eq!(latest_version(&r, "1.10.0").unwrap(), None);
        assert_eq!(latest_version(&r, "2.0.0").unwrap(), None);
        r.prerelease = true;
        assert_eq!(latest_version(&r, "1.0.2").unwrap(), None);
        r.prerelease = false;
        r.draft = true;
        assert_eq!(latest_version(&r, "1.0.2").unwrap(), None);
        for invalid in [
            "V1",
            "1.0.",
            "1.02.3",
            "1.0.3/other",
            "1.2.3-beta",
            "+1.2.3",
        ] {
            assert!(version(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn requires_correct_asset_origin_digest_and_content() {
        let mut r = release();
        for format in [
            Format::Windows,
            Format::Deb,
            Format::Rpm,
            Format::TarUser,
            Format::TarSystem,
        ] {
            let (asset, digest) = package(&r, format, "1.10.0").unwrap();
            assert!(verify(b"package".as_slice(), asset.size, digest).is_ok());
            assert!(verify(b"changed".as_slice(), asset.size, digest).is_err());
            assert!(verify(b"package+".as_slice(), asset.size, digest).is_err());
            assert!(verify(b"pack".as_slice(), asset.size, digest).is_err());
        }
        r.assets[0].digest = None;
        assert!(package(&r, Format::Windows, "1.10.0").is_err());
        r.assets[1].browser_download_url.push_str("?other");
        assert!(package(&r, Format::Deb, "1.10.0").is_err());
        r.assets[2].size = PACKAGE_LIMIT + 1;
        assert!(package(&r, Format::Rpm, "1.10.0").is_err());
        r.assets[3].name = "Editor-V1.10.0-TAR-Source.zip".into();
        assert!(package(&r, Format::TarUser, "1.10.0").is_err());
    }
}
