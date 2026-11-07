//! Per-PR draft review records, one JSON file per PR under `<app_config_dir>/review/`.
//! The record is opaque to Rust; TypeScript owns the schema.

use super::StoreError;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Injective: `[A-Za-z0-9._-]` are kept, every other byte becomes `~XX`.
pub fn key_to_file(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 5);
    for b in key.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-') {
            out.push(b as char);
        } else {
            out.push_str(&format!("~{b:02X}"));
        }
    }
    out.push_str(".json");
    out
}

fn file_to_key(name: &str) -> Option<String> {
    let stem = name.strip_suffix(".json")?;
    let bytes = stem.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'~' {
            let hex = stem.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub fn load_in(dir: &Path, key: &str) -> Result<Option<Value>, StoreError> {
    match fs::read_to_string(dir.join(key_to_file(key))) {
        Ok(text) => Ok(Some(serde_json::from_str(&text)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Writes a sibling `.tmp` then renames over the target, so a crash never
/// leaves a truncated draft.
pub fn save_in(dir: &Path, key: &str, value: &Value) -> Result<(), StoreError> {
    fs::create_dir_all(dir)?;
    let path = dir.join(key_to_file(key));
    let mut tmp = path.clone().into_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, serde_json::to_string_pretty(value)?)?;
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(e.into());
    }
    Ok(())
}

pub fn delete_in(dir: &Path, key: &str) -> Result<(), StoreError> {
    match fs::remove_file(dir.join(key_to_file(key))) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

pub fn list_in(dir: &Path) -> Result<Vec<String>, StoreError> {
    let rd = match fs::read_dir(dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut keys = Vec::new();
    for entry in rd {
        if let Some(key) = file_to_key(&entry?.file_name().to_string_lossy()) {
            keys.push(key);
        }
    }
    Ok(keys)
}

fn review_dir(app: &AppHandle) -> Result<PathBuf, StoreError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| StoreError::Path(e.to_string()))?;
    Ok(dir.join("review"))
}

pub fn load(app: &AppHandle, key: &str) -> Result<Option<Value>, StoreError> {
    load_in(&review_dir(app)?, key)
}

pub fn save(app: &AppHandle, key: &str, value: &Value) -> Result<(), StoreError> {
    save_in(&review_dir(app)?, key, value)
}

pub fn delete(app: &AppHandle, key: &str) -> Result<(), StoreError> {
    delete_in(&review_dir(app)?, key)
}

pub fn list(app: &AppHandle) -> Result<Vec<String>, StoreError> {
    list_in(&review_dir(app)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("riff-review-{}-{}", std::process::id(), name));
        let _ = fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn key_to_file_is_injective() {
        let dir = tmp("inj");
        let (a, b) = ("h/o/r#1", "h_o_r#1");
        assert_ne!(key_to_file(a), key_to_file(b));
        save_in(&dir, a, &json!(1)).unwrap();
        save_in(&dir, b, &json!(2)).unwrap();
        let mut keys = list_in(&dir).unwrap();
        keys.sort();
        assert_eq!(keys, vec![a.to_string(), b.to_string()]);
        assert_eq!(load_in(&dir, a).unwrap(), Some(json!(1)));
        assert_eq!(load_in(&dir, b).unwrap(), Some(json!(2)));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_then_load_round_trips() {
        let dir = tmp("rt");
        let v = json!({"items": [1, 2], "s": "한글"});
        save_in(&dir, "h/o/r#7", &v).unwrap();
        assert_eq!(load_in(&dir, "h/o/r#7").unwrap(), Some(v));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_missing_is_none() {
        let dir = tmp("miss");
        assert_eq!(load_in(&dir, "h/o/r#1").unwrap(), None);
    }

    #[test]
    fn save_overwrites_atomically() {
        let dir = tmp("atomic");
        save_in(&dir, "h/o/r#1", &json!(1)).unwrap();
        save_in(&dir, "h/o/r#1", &json!(2)).unwrap();
        assert_eq!(load_in(&dir, "h/o/r#1").unwrap(), Some(json!(2)));
        let names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 1, "{names:?}");
        assert!(!names.iter().any(|n| n.ends_with(".tmp")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn delete_missing_is_ok() {
        let dir = tmp("del");
        delete_in(&dir, "h/o/r#1").unwrap();
        save_in(&dir, "h/o/r#1", &json!(1)).unwrap();
        delete_in(&dir, "h/o/r#1").unwrap();
        assert_eq!(load_in(&dir, "h/o/r#1").unwrap(), None);
        let _ = fs::remove_dir_all(&dir);
    }
}
