use crate::files::{LIMIT, Result, atomic_data, bytes_at, decode, err};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{ErrorKind, Read},
    path::{Path, PathBuf},
};

const MAX_ENTRIES: usize = 128;
const MAX_STORAGE: u64 = 192 * 1024 * 1024;
const MAX_RECORD: u64 = 6 * LIMIT as u64 + 65536;

#[derive(Serialize, Deserialize)]
pub struct Recovery {
    pub id: String,
    pub name: String,
    pub path: Option<String>,
    pub text: String,
    pub encoding: String,
    pub eol: String,
}

fn record_path(dir: &Path, id: &str) -> Result<PathBuf> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
    {
        return Err("Invalid recovery identifier.".into());
    }
    Ok(dir.join(format!("{id}.json")))
}

pub fn delete(dir: &Path, id: &str) -> Result<()> {
    match fs::remove_file(record_path(dir, id)?) {
        Ok(_) => {
            #[cfg(unix)]
            fs::File::open(dir)
                .and_then(|d| d.sync_all())
                .map_err(err)?;
            Ok(())
        }
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(err(e)),
    }
}

fn records(dir: &Path) -> Result<Vec<(PathBuf, u64)>> {
    let mut items = Vec::new();
    for item in fs::read_dir(dir).map_err(err)? {
        let item = item.map_err(err)?;
        let p = item.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json")
            || !item.file_type().map_err(err)?.is_file()
        {
            continue;
        }
        items.push((p, item.metadata().map_err(err)?.len()));
    }
    Ok(items)
}

pub fn put(dir: &Path, entry: &Recovery) -> Result<()> {
    let dest = record_path(dir, &entry.id)?;
    if entry.text.len() > LIMIT
        || entry.name.len() > 4096
        || entry.path.as_ref().is_some_and(|s| s.len() > 32768)
    {
        return Err("Document exceeds the recovery size limit.".into());
    }
    let encoded = serde_json::to_vec(entry).map_err(err)?;
    let other: Vec<_> = records(dir)?
        .into_iter()
        .filter(|(p, _)| *p != dest)
        .collect();
    if other.len() >= MAX_ENTRIES
        || other.iter().map(|(_, len)| len).sum::<u64>() + encoded.len() as u64 > MAX_STORAGE
    {
        return Err("Recovery storage is full. Save or close other unsaved documents.".into());
    }
    atomic_data(&dest, &encoded)
}

fn quarantine(p: &Path) -> Result<()> {
    // A damaged journal can still contain readable user text. Keep those bytes,
    // and take the record out of the live journal so it cannot block new edits.
    let mut dest = p.with_extension("damaged");
    for n in 1.. {
        if !dest.exists() {
            return fs::rename(p, dest).map_err(err);
        }
        dest = p.with_extension(format!("damaged-{n}"));
    }
    unreachable!()
}

pub fn list(dir: &Path) -> Result<(Vec<Recovery>, usize)> {
    let mut damaged = 0;
    let mut entries = vec![];
    let mut paths = records(dir)?;
    paths.sort_by(|a, b| a.0.cmp(&b.0));
    for (p, len) in paths {
        if len > MAX_RECORD || len == 0 {
            quarantine(&p)?;
            damaged += 1;
            continue;
        }
        let mut raw = Vec::new();
        fs::File::open(&p)
            .map_err(err)?
            .take(MAX_RECORD + 1)
            .read_to_end(&mut raw)
            .map_err(err)?;
        let Ok(entry) = serde_json::from_slice::<Recovery>(&raw) else {
            quarantine(&p)?;
            damaged += 1;
            continue;
        };
        if record_path(dir, &entry.id).ok().as_ref() != Some(&p) || entry.text.len() > LIMIT {
            quarantine(&p)?;
            damaged += 1;
            continue;
        }
        let saved = entry.path.as_ref().is_some_and(|path| {
            let path = Path::new(path);
            bytes_at(path)
                .ok()
                .flatten()
                .and_then(|b| decode(path, &b, true).ok())
                .is_some_and(|d| {
                    d.text == entry.text && d.encoding == entry.encoding && d.eol == entry.eol
                })
        });
        if saved || (entry.path.is_none() && entry.text.is_empty()) {
            delete(dir, &entry.id)?;
        } else {
            entries.push(entry);
        }
    }
    Ok((entries, damaged))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_only_offers_unsaved_content_and_respects_encoding() {
        let dir = tempfile::tempdir().unwrap();
        let disk = dir.path().join("disk.txt");
        fs::write(&disk, b"saved").unwrap();
        let mut entry = Recovery {
            id: "doc-1".into(),
            name: "disk.txt".into(),
            path: Some(disk.to_str().unwrap().into()),
            text: "pending".into(),
            encoding: "UTF-8".into(),
            eol: "LF".into(),
        };
        put(dir.path(), &entry).unwrap();
        assert_eq!(list(dir.path()).unwrap().0[0].text, "pending");
        assert_eq!(fs::read(&disk).unwrap(), b"saved");
        entry.text = "saved".into();
        entry.encoding = "UTF-8 BOM".into();
        put(dir.path(), &entry).unwrap();
        assert_eq!(list(dir.path()).unwrap().0.len(), 1);
        entry.encoding = "UTF-8".into();
        put(dir.path(), &entry).unwrap();
        assert!(list(dir.path()).unwrap().0.is_empty());
        assert!(!dir.path().join("doc-1.json").exists());
        entry.path = None;
        entry.text = "new".into();
        put(dir.path(), &entry).unwrap();
        assert_eq!(list(dir.path()).unwrap().0.len(), 1);
        delete(dir.path(), &entry.id).unwrap();
        delete(dir.path(), &entry.id).unwrap();
        assert!(list(dir.path()).unwrap().0.is_empty());
    }
    #[test]
    fn recovery_rejects_traversal_and_skips_corrupt_records() {
        let dir = tempfile::tempdir().unwrap();
        for bad in ["", ".", "../settings", "a/b", "C:\\file"] {
            assert!(delete(dir.path(), bad).is_err());
        }
        fs::write(dir.path().join("bad.json"), b"broken").unwrap();
        let (entries, damaged) = list(dir.path()).unwrap();
        assert!(entries.is_empty());
        assert_eq!(damaged, 1);
        assert_eq!(fs::read(dir.path().join("bad.damaged")).unwrap(), b"broken");
        assert_eq!(list(dir.path()).unwrap().1, 0);
    }
}
