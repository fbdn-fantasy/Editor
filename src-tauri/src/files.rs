use encoding_rs::WINDOWS_1252;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, Metadata, OpenOptions},
    io::{ErrorKind, Read, Write},
    path::{Path, PathBuf},
    time::SystemTime,
};
use tempfile::NamedTempFile;

pub type Result<T> = std::result::Result<T, String>;
pub const LIMIT: usize = 16 * 1024 * 1024;
pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Serialize)]
pub struct Document {
    pub path: String,
    pub name: String,
    pub text: String,
    pub encoding: String,
    pub eol: String,
    pub version: String,
    #[serde(skip)]
    mixed_endings: bool,
}

#[derive(Deserialize)]
pub struct Tracked {
    pub path: String,
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct Stamp {
    size: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    identity: (u64, i64, i64),
}

impl From<&Metadata> for Stamp {
    fn from(m: &Metadata) -> Self {
        Self {
            size: m.len(),
            modified: m.modified().ok(),
            #[cfg(unix)]
            identity: {
                use std::os::unix::fs::MetadataExt;
                (m.ino(), m.ctime(), m.ctime_nsec())
            },
        }
    }
}

#[derive(Default)]
pub struct Files {
    grants: HashSet<PathBuf>,
    cache: HashMap<PathBuf, (Stamp, String)>,
    // CodeMirror normalizes line breaks. Keep the original bytes only for
    // documents whose individual separators cannot be inferred from their EOL.
    mixed_originals: HashMap<PathBuf, Vec<u8>>,
}

pub fn path_string(p: &Path) -> Result<String> {
    p.to_str()
        .map(String::from)
        .ok_or_else(|| "This path contains bytes that cannot be represented as Unicode.".into())
}

pub fn bytes_at(path: &Path) -> Result<Option<Vec<u8>>> {
    // Avoid opening pipes, devices, and directories. Limit the actual read as well
    // as the reported size because another writer can grow the file.
    let m = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(err(e)),
    };
    if !m.is_file() {
        return Err("Choose a regular text file.".into());
    }
    if m.len() > LIMIT as u64 {
        return Err("This file exceeds the 16 MiB editing limit.".into());
    }
    let mut bytes = Vec::with_capacity(m.len() as usize);
    File::open(path)
        .map_err(err)?
        .take(LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(err)?;
    if bytes.len() > LIMIT {
        return Err("This file exceeds the 16 MiB editing limit.".into());
    }
    Ok(Some(bytes))
}

pub fn hash(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn binary_name(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "exe"
            | "dll"
            | "so"
            | "dylib"
            | "o"
            | "class"
            | "wasm"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "ico"
            | "bmp"
            | "webp"
            | "pdf"
            | "zip"
            | "gz"
            | "tar"
            | "xz"
            | "bz2"
            | "7z"
            | "rar"
            | "rpm"
            | "deb"
            | "doc"
            | "docx"
            | "xls"
            | "xlsx"
            | "ppt"
            | "pptx"
            | "odt"
            | "ods"
            | "mp3"
            | "mp4"
    )
}

fn binary_signature(b: &[u8]) -> bool {
    [
        b"\x7fELF".as_slice(),
        b"%PDF-",
        b"PK\x03\x04",
        b"PK\x05\x06",
        b"\x89PNG\r\n\x1a\n",
        b"GIF87a",
        b"GIF89a",
        b"\xff\xd8\xff",
        b"\x1f\x8b",
        b"SQLite format 3\0",
        b"\xd0\xcf\x11\xe0",
        b"7z\xbc\xaf\x27\x1c",
        b"\x00asm",
    ]
    .iter()
    .any(|sig| b.starts_with(sig))
}

fn unpack(bytes: &[u8], legacy: bool) -> Result<(String, &'static str)> {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let le = bytes[0] == 0xff;
        if bytes.len() % 2 != 0 {
            return Err("Incomplete UTF-16 code unit.".into());
        }
        let decoded: std::result::Result<String, _> =
            char::decode_utf16(bytes[2..].chunks_exact(2).map(|p| {
                if le {
                    u16::from_le_bytes([p[0], p[1]])
                } else {
                    u16::from_be_bytes([p[0], p[1]])
                }
            }))
            .collect();
        return Ok((
            decoded.map_err(|_| "Invalid UTF-16 surrogate pair.")?,
            if le { "UTF-16 LE" } else { "UTF-16 BE" },
        ));
    }
    let (data, utf) = match bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        Some(b) => (b, "UTF-8 BOM"),
        None => (bytes, "UTF-8"),
    };
    if data.contains(&0)
        || data.iter().filter(|c| matches!(c, 1..=8|14..=31)).count() > data.len() / 100
    {
        return Err("This appears to be a binary file.".into());
    }
    match std::str::from_utf8(data) {
        Ok(s) => Ok((s.to_owned(), utf)),
        Err(_) if utf == "UTF-8 BOM" => Err("Invalid UTF-8 after the byte-order mark.".into()),
        Err(_) if legacy => Ok((
            WINDOWS_1252
                .decode_without_bom_handling(data)
                .0
                .into_owned(),
            "Windows-1252",
        )),
        Err(_) => Err("ENCODING: The encoding is ambiguous. Open using Windows-1252?".into()),
    }
}

// Retain individual separators in mixed-ending documents for unchanged lines.
// New separators use the predominant style of the original file.
fn split_lines(s: &str) -> impl Iterator<Item = (&str, &str)> {
    let mut rest = s;
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        if let Some(i) = rest.find(['\r', '\n']) {
            let n = if rest[i..].starts_with("\r\n") { 2 } else { 1 };
            let item = (&rest[..i], &rest[i..i + n]);
            rest = &rest[i + n..];
            Some(item)
        } else {
            let last = rest;
            rest = "";
            Some((last, ""))
        }
    })
}

fn line_style(raw: &str) -> (&'static str, bool) {
    let mut counts = [0usize; 3];
    for (_, sep) in split_lines(raw) {
        match sep {
            "\n" => counts[0] += 1,
            "\r\n" => counts[1] += 1,
            "\r" => counts[2] += 1,
            _ => {}
        }
    }
    let style = if counts[1] > counts[0] && counts[1] >= counts[2] {
        "CRLF"
    } else if counts[2] > counts[0] && counts[2] > counts[1] {
        "CR"
    } else {
        "LF"
    };
    (style, counts.iter().filter(|&&count| count > 0).count() > 1)
}

pub fn decode(path: &Path, bytes: &[u8], legacy: bool) -> Result<Document> {
    if binary_name(path) || binary_signature(bytes) {
        return Err("This appears to be a binary file.".into());
    }
    let (raw, encoding) = unpack(bytes, legacy)?;
    if raw.contains('\0') {
        return Err("This appears to be a binary file.".into());
    }
    if raw.len() > LIMIT {
        return Err("Decoded text exceeds the 16 MiB editing limit.".into());
    }
    let (eol, mixed_endings) = line_style(&raw);
    let text = if raw.contains('\r') {
        raw.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        raw
    };
    Ok(Document {
        path: path_string(path)?,
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        text,
        encoding: encoding.into(),
        eol: eol.into(),
        version: hash(bytes),
        mixed_endings,
    })
}

// Find the last logical line without allocating a line table for large logs.
fn last_line(s: &str) -> Option<(&str, &str, &str)> {
    if s.is_empty() {
        return None;
    }
    let body = s
        .strip_suffix("\r\n")
        .or_else(|| s.strip_suffix(['\r', '\n']))
        .unwrap_or(s);
    let start = body.rfind(['\r', '\n']).map_or(0, |i| i + 1);
    Some((&s[..start], &body[start..], &s[body.len()..]))
}

fn restore_separators(text: &str, original: &str, sep: &str) -> String {
    let (mut new, mut old) = (text, original);
    let mut raw = String::with_capacity(text.len());
    // Take equal prefix and suffix lines verbatim, so inserting or deleting a line
    // in the middle does not move mixed CR/LF separators to unrelated lines.
    while let (Some((a, end_a)), Some((b, end_b))) =
        (split_lines(new).next(), split_lines(old).next())
    {
        if a != b || end_a.is_empty() != end_b.is_empty() {
            break;
        }
        let n = b.len() + end_b.len();
        raw.push_str(&old[..n]);
        new = &new[a.len() + end_a.len()..];
        old = &old[n..];
    }
    let after_prefix = old;
    while let (Some((remaining_a, a, end_a)), Some((remaining_b, b, end_b))) =
        (last_line(new), last_line(old))
    {
        if a != b || end_a.is_empty() != end_b.is_empty() {
            break;
        }
        new = remaining_a;
        old = remaining_b;
    }
    let mut old_lines = split_lines(old);
    for (line, ending) in split_lines(new) {
        let prev = old_lines.next();
        raw.push_str(line);
        if !ending.is_empty() {
            raw.push_str(prev.map(|v| v.1).filter(|e| !e.is_empty()).unwrap_or(sep));
        }
    }
    raw.push_str(&after_prefix[old.len()..]);
    raw
}

fn encode(text: &str, encoding: &str, eol: &str, previous: Option<&[u8]>) -> Result<Vec<u8>> {
    let sep = match eol {
        "LF" => "\n",
        "CRLF" => "\r\n",
        "CR" => "\r",
        _ => return Err("Unknown line-ending format.".into()),
    };
    if text.len() > LIMIT {
        return Err("Text exceeds the 16 MiB editing limit.".into());
    }
    let original = previous.and_then(|b| unpack(b, true).ok()).map(|v| v.0);
    let raw = restore_separators(text, original.as_deref().unwrap_or(""), sep);
    let bytes = match encoding {
        "UTF-8" => raw.into_bytes(),
        "UTF-8 BOM" => [&[0xef, 0xbb, 0xbf], raw.as_bytes()].concat(),
        "UTF-16 LE" | "UTF-16 BE" => {
            let le = encoding == "UTF-16 LE";
            let mut out = if le {
                vec![0xff, 0xfe]
            } else {
                vec![0xfe, 0xff]
            };
            for u in raw.encode_utf16() {
                out.extend(if le { u.to_le_bytes() } else { u.to_be_bytes() });
            }
            out
        }
        "Windows-1252" => {
            let (b, _, errors) = WINDOWS_1252.encode(&raw);
            if errors {
                return Err(
                    "Some characters cannot be represented in Windows-1252. Save a UTF-8 copy."
                        .into(),
                );
            }
            b.into_owned()
        }
        _ => return Err("Unknown character encoding.".into()),
    };
    if bytes.len() > LIMIT {
        return Err("Encoded file exceeds the 16 MiB editing limit.".into());
    }
    Ok(bytes)
}

fn install(temp: NamedTempFile, path: &Path, replace: bool) -> Result<()> {
    if replace {
        temp.persist(path)
    } else {
        temp.persist_noclobber(path)
    }
    .map_err(err)?;
    #[cfg(unix)]
    File::open(path.parent().ok_or("Missing parent folder.")?)
        .and_then(|dir| dir.sync_all())
        .map_err(err)?;
    Ok(())
}

// ReplaceFile preserves the target DACL, creation time and named streams on NTFS.
#[cfg(windows)]
fn replace_windows_file(temp: NamedTempFile, path: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_NORMAL, ReplaceFileW, SetFileAttributesW,
    };
    let wide = |p: &Path| {
        p.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<u16>>()
    };
    let dest = wide(path);
    let staged = wide(temp.path());
    // Close the write handle before ReplaceFile asks for exclusive write access.
    let path_guard = temp.into_temp_path();
    let null = std::ptr::null();
    let ok = unsafe {
        SetFileAttributesW(staged.as_ptr(), FILE_ATTRIBUTE_NORMAL) != 0
            && ReplaceFileW(
                dest.as_ptr(),
                staged.as_ptr(),
                null,
                0,
                null.cast(),
                null.cast(),
            ) != 0
    };
    if !ok {
        return Err(err(std::io::Error::last_os_error()));
    }
    drop(path_guard);
    Ok(())
}

pub fn atomic_data(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut tmp =
        NamedTempFile::new_in(path.parent().ok_or("Missing parent folder.")?).map_err(err)?;
    tmp.write_all(bytes)
        .and_then(|_| tmp.as_file().sync_all())
        .map_err(err)?;
    install(tmp, path, true)
}

impl Files {
    pub fn grant(&mut self, path: &Path) -> Result<String> {
        let abs = match dunce::canonicalize(path) {
            Ok(p) => p,
            Err(e) if e.kind() == ErrorKind::NotFound => {
                let p = path.parent().ok_or("Missing parent directory.")?;
                dunce::canonicalize(p)
                    .map_err(err)?
                    .join(path.file_name().ok_or("Missing filename.")?)
            }
            Err(e) => return Err(err(e)),
        };
        let s = path_string(&abs)?;
        self.grants.insert(abs);
        Ok(s)
    }
    fn allowed(&self, path: &Path) -> Result<()> {
        if !self.grants.contains(path) {
            return Err("Choose this file in the native file dialog first.".into());
        }
        let parent = path.parent().ok_or("Missing parent directory.")?;
        if dunce::canonicalize(parent).map_err(err)? != parent {
            return Err("The file's parent folder has moved. Open the file again.".into());
        }
        if let Ok(m) = path.symlink_metadata()
            && m.is_symlink()
        {
            return Err("The path has become a symbolic link. Open its target again.".into());
        }
        Ok(())
    }
    pub fn forget(&mut self, path: &Path) {
        self.grants.remove(path);
        self.cache.remove(path);
        self.mixed_originals.remove(path);
    }
    fn remember_layout(&mut self, path: &Path, bytes: Vec<u8>, mixed: bool) {
        if mixed {
            self.mixed_originals.insert(path.into(), bytes);
        } else {
            self.mixed_originals.remove(path);
        }
    }
    pub fn read(&mut self, path: &Path, legacy: bool) -> Result<Document> {
        self.allowed(path)?;
        let stamp = fs::metadata(path).ok().as_ref().map(Stamp::from);
        let bytes = bytes_at(path)?.ok_or("The file no longer exists.")?;
        let doc = decode(path, &bytes, legacy)?;
        self.remember_layout(path, bytes, doc.mixed_endings);
        if let Some(stamp) = stamp {
            self.cache.insert(path.into(), (stamp, doc.version.clone()));
        }
        Ok(doc)
    }
    pub fn version(&mut self, path: &Path, cached: bool) -> Result<Option<String>> {
        self.allowed(path)?;
        let stamp = match fs::metadata(path) {
            Ok(m) => Stamp::from(&m),
            Err(e) if e.kind() == ErrorKind::NotFound => {
                self.cache.remove(path);
                return Ok(None);
            }
            Err(e) => return Err(err(e)),
        };
        if cached
            && let Some((old, v)) = self.cache.get(path)
            && stamp == *old
            && stamp.modified.is_some()
        {
            return Ok(Some(v.clone()));
        }
        let version = bytes_at(path)?.as_deref().map(hash);
        if let Some(v) = &version {
            self.cache.insert(path.into(), (stamp, v.clone()));
        }
        Ok(version)
    }
    pub fn write(
        &mut self,
        path: &Path,
        text: &str,
        encoding: &str,
        eol: &str,
        expected: Option<&str>,
        source: Option<&Path>,
    ) -> Result<String> {
        self.allowed(path)?;
        if binary_name(path) {
            return Err("Choose a text filename for this document.".into());
        }
        let previous = bytes_at(path)?;
        const CONFLICT: &str = "CONFLICT: The file on disk has changed.";
        if previous.as_deref().map(hash).as_deref() != expected {
            return Err(CONFLICT.into());
        }
        if let Some(bytes) = &previous {
            // Refuse a binary Save As target even when it was selected explicitly.
            decode(path, bytes, true)?;
            OpenOptions::new().write(true).open(path).map_err(err)?;
        }
        let original = source.and_then(|p| self.mixed_originals.get(p));
        let bytes = encode(text, encoding, eol, original.map(Vec::as_slice))?;
        let preserve_mixed = original.is_some();
        let version = hash(&bytes);
        if expected == Some(version.as_str()) {
            self.remember_layout(path, bytes, preserve_mixed);
            return Ok(version);
        }
        let mut tmp =
            NamedTempFile::new_in(path.parent().ok_or("Missing parent folder.")?).map_err(err)?;
        tmp.write_all(&bytes).map_err(err)?;
        if previous.is_some() {
            tmp.as_file()
                .set_permissions(fs::metadata(path).map_err(err)?.permissions())
                .map_err(err)?;
            #[cfg(target_os = "linux")]
            if let Ok(names) = xattr::list(path) {
                for name in names.filter(|name| {
                    let n = name.to_string_lossy();
                    n.starts_with("user.") || n == "system.posix_acl_access"
                }) {
                    if let Some(v) = xattr::get(path, &name).map_err(err)? {
                        xattr::set(tmp.path(), &name, &v).map_err(err)?;
                    }
                }
            }
        }
        tmp.as_file().sync_all().map_err(err)?;
        if self.version(path, false)?.as_deref() != expected {
            return Err(CONFLICT.into());
        }
        #[cfg(windows)]
        if expected.is_some() {
            replace_windows_file(tmp, path)?;
        } else {
            install(tmp, path, false)?;
        }
        #[cfg(not(windows))]
        install(tmp, path, expected.is_some())?;
        self.cache.remove(path);
        self.remember_layout(path, bytes, preserve_mixed);
        Ok(version)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    #[test]
    fn text_formats_roundtrip_and_reject_lossy_changes() {
        let path = Path::new("file");
        for (b, encoding, eol) in [
            (b"a\r\nb".as_slice(), "UTF-8", "CRLF"),
            (b"\xef\xbb\xbfa\nb", "UTF-8 BOM", "LF"),
            (b"\xff\xfeA\0\r\0B\0", "UTF-16 LE", "CR"),
            (b"\xfe\xff\0A\0\n\0B", "UTF-16 BE", "LF"),
            (b"\x93quoted\x94\r", "Windows-1252", "CR"),
        ] {
            let doc = decode(path, b, true).unwrap();
            assert_eq!(doc.encoding, encoding);
            assert_eq!(doc.eol, eol);
            assert_eq!(encode(&doc.text, encoding, eol, Some(b)).unwrap(), b);
        }
        assert!(
            decode(path, b"\x80", false)
                .err()
                .unwrap()
                .starts_with("ENCODING:")
        );
        assert!(encode("🌺", "Windows-1252", "LF", None).is_err());
        for bad in [
            b"\xfe\xff\x00".as_slice(),
            b"\xff\xfe\x00\xd8",
            b"\xef\xbb\xbf\xff",
            b"\x00this is binary",
            b"\x7fELFexample",
            b"PK\x03\x04docx",
            b"\x89PNG\r\n\x1a\n",
        ] {
            assert!(decode(path, bad, true).is_err());
        }
        assert!(decode(Path::new("payload.exe"), b"fake", true).is_err());
        assert!(decode(path, b"MZ is a prefix in my notes", false).is_ok());
    }
    #[test]
    fn blank_extensionless_file_roundtrips_without_adding_bytes_or_a_suffix() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("notes");
        let mut files = Files::default();
        files.grant(&path).unwrap();
        let version = files.write(&path, "", "UTF-8", "LF", None, Some(&path)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        assert_eq!(files.read(&path, false).unwrap().text, "");
        files.write(&path, "next", "UTF-8", "LF", Some(&version), Some(&path)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"next");
    }
    #[test]
    fn mixed_endings_survive_insert_deletion_and_replacement() {
        let original = b"a\nb\r\nc\rd\n";
        assert_eq!(
            encode("a\nadded\nb\nc\nd\n", "UTF-8", "LF", Some(original)).unwrap(),
            b"a\nadded\nb\r\nc\rd\n"
        );
        assert_eq!(
            encode("a\nc\nd\n", "UTF-8", "LF", Some(original)).unwrap(),
            b"a\nc\rd\n"
        );
        assert_eq!(
            encode("a\nB\nc\nd\n", "UTF-8", "LF", Some(original)).unwrap(),
            b"a\nB\r\nc\rd\n"
        );
    }
    #[test]
    fn save_as_preserves_the_open_documents_mixed_endings() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("original.txt");
        let copy = dir.path().join("copy.txt");
        let original = b"a\r\nb\nc\rd\n";
        fs::write(&source, original).unwrap();
        let mut files = Files::default();
        files.grant(&source).unwrap();
        files.grant(&copy).unwrap();
        let doc = files.read(&source, false).unwrap();
        fs::remove_file(&source).unwrap();
        let saved = files.write(&copy, &doc.text, &doc.encoding, &doc.eol, None, Some(&source)).unwrap();
        assert_eq!(fs::read(&copy).unwrap(), original);
        files.forget(&source);
        let changed = files.write(&copy, "a\nB\nc\nd\n", "UTF-8", "LF", Some(&saved), Some(&copy)).unwrap();
        assert_eq!(fs::read(&copy).unwrap(), b"a\r\nB\nc\rd\n");
        // Saving an untitled document over that same target uses the new
        // document's formatting, regardless of what the destination contains.
        files.write(&copy, &doc.text, "UTF-8", "LF", Some(&changed), None).unwrap();
        assert_eq!(fs::read(&copy).unwrap(), b"a\nb\nc\nd\n");
    }
    #[test]
    fn grants_detect_stale_saves_and_deleted_files() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("space 🧪.txt");
        let mut f = Files::default();
        assert!(f.read(&p, false).is_err());
        assert!(f.write(&p, "x", "UTF-8", "LF", None, Some(&p)).is_err());
        f.grant(&p).unwrap();
        assert!(!p.exists());
        let rev = f.write(&p, "one", "UTF-8", "LF", None, Some(&p)).unwrap();
        assert_eq!(f.read(&p, false).unwrap().version, rev);
        fs::write(&p, "two").unwrap();
        assert_ne!(f.version(&p, true).unwrap(), Some(rev.clone()));
        assert!(
            f.write(&p, "lost?", "UTF-8", "LF", Some(&rev), Some(&p))
                .unwrap_err()
                .starts_with("CONFLICT:")
        );
        assert_eq!(fs::read(&p).unwrap(), b"two");
        let next = f.version(&p, false).unwrap().unwrap();
        fs::remove_file(&p).unwrap();
        assert!(f.write(&p, "three", "UTF-8", "LF", Some(&next), Some(&p)).is_err());
        assert!(!p.exists());
        assert!(f.write(&p, "three", "UTF-8", "LF", None, Some(&p)).is_ok());
    }
    #[test]
    fn failed_conversion_preserves_original_bytes_and_no_temporary_files() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("legacy");
        fs::write(&p, b"\x80").unwrap();
        let mut f = Files::default();
        f.grant(&p).unwrap();
        let d = f.read(&p, true).unwrap();
        assert!(
            f.write(&p, "€🧪", &d.encoding, &d.eol, Some(&d.version), Some(&p))
                .is_err()
        );
        assert_eq!(fs::read(&p).unwrap(), b"\x80");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    fn refuses_oversized_files_and_non_regular_files() {
        let d = tempdir().unwrap();
        let p = d.path().join("large.txt");
        File::create(&p).unwrap().set_len(LIMIT as u64 + 1).unwrap();
        assert!(bytes_at(&p).unwrap_err().contains("16 MiB"));
        assert!(bytes_at(d.path()).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn writes_preserve_permissions_and_symlink_target() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir = tempdir().unwrap();
        let p = dir.path().join("script");
        let link = dir.path().join("shortcut");
        fs::write(&p, b"one").unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o750)).unwrap();
        symlink(&p, &link).unwrap();
        let mut f = Files::default();
        let granted = PathBuf::from(f.grant(&link).unwrap());
        let v = f.read(&granted, false).unwrap().version;
        f.write(&granted, "two", "UTF-8", "LF", Some(&v), Some(&granted)).unwrap();
        assert!(link.is_symlink());
        assert_eq!(fs::read(link).unwrap(), b"two");
        assert_eq!(fs::metadata(p).unwrap().permissions().mode() & 0o777, 0o750);
    }
}
