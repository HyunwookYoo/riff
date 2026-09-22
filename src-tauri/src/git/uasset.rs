//! Unreal Engine `.uasset` / `.umap` preview support.
//!
//! These files are binary, so a raw git diff is useless. When enabled and a
//! path to `UAssetGUI.exe` is configured, we shell out to its `tojson`
//! command to derive a readable JSON property view for each side of the diff,
//! then strip volatile serialization artifacts so the diff reflects real
//! content changes. Any failure (missing tool, unsupported engine version,
//! parse error) degrades gracefully to the normal binary view with a note.
//!
//! v1 targets *versioned* (editor / source-control) assets. Cooked or
//! unversioned assets need a `.usmap` mappings file and are out of scope —
//! they simply fail to parse and fall back to binary.

use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use super::FileDiff;

/// Combined byte cap above which we don't attempt to parse — keeps a
/// pathologically large asset from blocking the UI. Applies to the `.uasset`
/// header size (bulk data lives in `.uexp`, fetched separately).
pub const UASSET_MAX_BYTES: u64 = 64_000_000;

/// Top-level / per-export JSON keys that change on every re-save without
/// Top-level keys worth keeping. UAssetAPI's tojson emits the full package
/// summary (engine version, name map, soft refs, thumbnails, offsets, …) for
/// round-trip fidelity; for a content diff only the exports (and imports, for
/// dependency changes) matter. Everything else at the root is dropped.
const ROOT_KEEP: &[&str] = &["Exports", "Imports"];

/// Keys stripped at every depth — .NET type tags plus serialization
/// artifacts (offsets, sizes, hashes, GUIDs, package indices, object flags,
/// dependency tables) that change on re-save without representing content.
/// Tunable as real assets reveal more noise.
const NOISE_KEYS: &[&str] = &[
    "$type",
    "SerialOffset",
    "SerialSize",
    "PackageGuid",
    "PublicExportHash",
    "SavedHash",
    "PackageFlags",
    "ObjectFlags",
    "OuterIndex",
    "ClassIndex",
    "SuperIndex",
    "TemplateIndex",
    "PropertyGuid",
    "DuplicationIndex",
    "ArrayIndex",
    "NameMap",
    "FirstExportDependency",
    "SerializationBeforeSerializationDependencies",
    "CreateBeforeSerializationDependencies",
    "SerializationBeforeCreateDependencies",
    "CreateBeforeCreateDependencies",
    "bForcedExport",
    "bNotForClient",
    "bNotForServer",
    "bIsInheritedInstance",
    "bNotAlwaysLoadedForEditorGame",
    "bIsAsset",
    "bGeneratePublicHash",
];

/// Resolved configuration for a single derive attempt, assembled by the
/// command layer from persisted settings + the frontend's version choice.
pub struct Config {
    /// Master toggle ("Parse Unreal assets").
    pub enabled: bool,
    /// Absolute path to `UAssetGUI.exe`. `None`/empty → can't parse.
    pub uassetgui_path: Option<String>,
    /// Whether `uassetgui_path` came from the app bundle rather than the
    /// settings override. Only used to label failure notes, so a user report
    /// says which of the two resolutions was actually in play.
    pub uassetgui_bundled: bool,
    /// Engine version string passed to `tojson` (e.g. "5.3"). Already
    /// defaulted by the caller.
    pub engine_version: String,
}

/// Heuristic: a Git LFS pointer file begins with this version line. Such bytes
/// reach the parser only when the LFS object couldn't be smudged (not pulled).
fn looks_like_lfs_pointer(bytes: &[u8]) -> bool {
    bytes.starts_with(b"version https://git-lfs.github.com/spec/")
}

/// True for files whose binary content we can derive a property view for.
pub fn is_uasset_path(p: &str) -> bool {
    let lower = p.to_ascii_lowercase();
    lower.ends_with(".uasset") || lower.ends_with(".umap")
}

/// The sibling `.uexp` path for a `.uasset`/`.umap` (export/bulk data lives
/// there in UE 4.20+). Returns `None` if `p` has no extension.
pub fn sibling_uexp(p: &str) -> Option<String> {
    let idx = p.rfind('.')?;
    Some(format!("{}.uexp", &p[..idx]))
}

/// Build a derived `FileDiff::Text` for a uasset, or `FileDiff::Binary` with a
/// note when prerequisites are missing or parsing fails. The caller fetches
/// the `.uasset` bytes plus the sibling `.uexp` bytes for both sides (their
/// source differs between branch and worktree mode).
#[allow(clippy::too_many_arguments)]
pub fn derive_filediff(
    cfg: &Config,
    file_path: &str,
    old_bytes: &[u8],
    old_uexp: Option<&[u8]>,
    new_bytes: &[u8],
    new_uexp: Option<&[u8]>,
    old_size: u64,
    new_size: u64,
) -> FileDiff {
    let tool = match cfg.uassetgui_path.as_deref() {
        Some(p) if !p.trim().is_empty() => p.to_string(),
        _ => {
            return FileDiff::Binary {
                old_size,
                new_size,
                note: Some(
                    "Set the UAssetGUI path in settings to preview Unreal assets.".to_string(),
                ),
            }
        }
    };

    let tool_label = format!(
        "{tool} ({})",
        if cfg.uassetgui_bundled {
            "bundled"
        } else {
            "from settings"
        }
    );
    let stem = safe_stem(file_path);
    let render = |bytes: &[u8], uexp: Option<&[u8]>| -> Result<String, String> {
        // An absent side (added / deleted file) yields empty JSON so the diff
        // renders as a pure add/remove.
        if bytes.is_empty() {
            return Ok(String::new());
        }
        render_side(&tool, &tool_label, &cfg.engine_version, &stem, bytes, uexp)
    };

    let old_json = match render(old_bytes, old_uexp) {
        Ok(s) => s,
        Err(e) => {
            return FileDiff::Binary {
                old_size,
                new_size,
                note: Some(e),
            }
        }
    };
    let new_json = match render(new_bytes, new_uexp) {
        Ok(s) => s,
        Err(e) => {
            return FileDiff::Binary {
                old_size,
                new_size,
                note: Some(e),
            }
        }
    };

    let old_content = super::diff::normalize_eol(&old_json);
    let new_content = super::diff::normalize_eol(&new_json);
    let changes = super::diff::compute_changes(&old_content, &new_content);
    FileDiff::Text {
        old_content,
        new_content,
        old_size,
        new_size,
        derived_label: Some(format!("Property view · UE {}", cfg.engine_version)),
        ue_version: Some(cfg.engine_version.clone()),
        changes,
    }
}

/// Run `UAssetGUI tojson` on one side's bytes and return the filtered JSON.
/// Entries kept in the rendered-JSON cache, and the total JSON it may hold.
/// Two per diff (old + new side), so a dozen entries spans several files'
/// worth of back-and-forth.
const RENDER_CACHE_ENTRIES: usize = 12;
const RENDER_CACHE_BYTES: usize = 64 * 1024 * 1024;

/// What a render actually depends on: the asset bytes, the sibling `.uexp`
/// bytes (0 when there is none), and the engine version it was parsed with.
type RenderKey = (u64, u64, String);

/// Bounded LRU of rendered asset JSON.
///
/// Rendering a side costs a UAssetGUI process, two temp files, and seconds of
/// work — and riff asks for the same side over and over: every return to the
/// Changes screen re-mounts the diff view and re-derives both sides of the
/// selected file, while the old side is a committed blob that cannot have
/// changed at all. Keyed by content, so a cache hit is only ever the same
/// bytes rendered the same way.
#[derive(Default)]
struct RenderCache {
    map: HashMap<RenderKey, String>,
    /// Least-recently-used first.
    order: VecDeque<RenderKey>,
    bytes: usize,
}

impl RenderCache {
    fn get(&mut self, key: &RenderKey) -> Option<String> {
        let hit = self.map.get(key)?.clone();
        if let Some(i) = self.order.iter().position(|k| k == key) {
            let k = self.order.remove(i).expect("index came from position");
            self.order.push_back(k);
        }
        Some(hit)
    }

    fn put(&mut self, key: RenderKey, value: String) {
        // A single render bigger than the whole budget would evict everything
        // and still not fit — don't admit it.
        if value.len() > RENDER_CACHE_BYTES {
            return;
        }
        if let Some(old) = self.map.remove(&key) {
            self.bytes -= old.len();
            if let Some(i) = self.order.iter().position(|k| *k == key) {
                self.order.remove(i);
            }
        }
        self.bytes += value.len();
        self.map.insert(key.clone(), value);
        self.order.push_back(key);
        while self.order.len() > RENDER_CACHE_ENTRIES || self.bytes > RENDER_CACHE_BYTES {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(dropped) = self.map.remove(&oldest) {
                self.bytes -= dropped.len();
            }
        }
    }
}

fn render_cache() -> &'static Mutex<RenderCache> {
    static CACHE: OnceLock<Mutex<RenderCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(RenderCache::default()))
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

fn render_key(asset_bytes: &[u8], uexp_bytes: Option<&[u8]>, engine_version: &str) -> RenderKey {
    (
        hash_bytes(asset_bytes),
        uexp_bytes.map(hash_bytes).unwrap_or(0),
        engine_version.to_string(),
    )
}

fn render_side(
    tool: &str,
    tool_label: &str,
    engine_version: &str,
    stem: &str,
    asset_bytes: &[u8],
    uexp_bytes: Option<&[u8]>,
) -> Result<String, String> {
    // If the bytes are still an LFS pointer, the object wasn't available for
    // the smudge filter to resolve — give an actionable message instead of a
    // cryptic "file signature mismatch" from UAssetGUI.
    if looks_like_lfs_pointer(asset_bytes) {
        return Err(
            "Git LFS object isn't available locally — run `git lfs pull` and retry.".to_string(),
        );
    }

    // Only successful renders are cached: a failure is usually a missing or
    // misconfigured tool, which the user is expected to fix and retry.
    let key = render_key(asset_bytes, uexp_bytes, engine_version);
    if let Some(hit) = render_cache().lock().unwrap().get(&key) {
        return Ok(hit);
    }

    let dir = TempDir::new()?;
    let asset_path = dir.0.join(format!("{stem}.uasset"));
    fs::write(&asset_path, asset_bytes).map_err(|e| format!("write temp uasset: {e}"))?;
    if let Some(uexp) = uexp_bytes {
        let uexp_path = dir.0.join(format!("{stem}.uexp"));
        fs::write(&uexp_path, uexp).map_err(|e| format!("write temp uexp: {e}"))?;
    }
    let json_path = dir.0.join(format!("{stem}.json"));

    let output = uassetgui_command(tool)
        .arg("tojson")
        .arg(&asset_path)
        .arg(&json_path)
        .arg(engine_version)
        .output()
        .map_err(|e| format!("failed to run UAssetGUI {tool_label}: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else {
            stdout.trim().to_string()
        };
        return Err(format!(
            "UAssetGUI tojson failed (UE {engine_version}) — {tool_label}: {detail}"
        ));
    }

    let raw = fs::read_to_string(&json_path)
        .map_err(|e| format!("read UAssetGUI output: {e}"))?;
    let filtered = filter_volatile(&raw)?;
    render_cache().lock().unwrap().put(key, filtered.clone());
    Ok(filtered)
}

/// Reduce the tojson output to a content-focused view: keep only the
/// content-bearing top-level sections, then recursively drop noise keys.
/// serde_json's default `Map` is key-ordered, so output is deterministic
/// across runs of the same content.
fn filter_volatile(raw: &str) -> Result<String, String> {
    let value: Value =
        serde_json::from_str(raw).map_err(|e| format!("parse UAssetGUI JSON: {e}"))?;
    let reduced = match value {
        Value::Object(mut root) => {
            let mut kept = serde_json::Map::new();
            for key in ROOT_KEEP {
                if let Some(mut v) = root.remove(*key) {
                    clean(&mut v);
                    kept.insert((*key).to_string(), v);
                }
            }
            Value::Object(kept)
        }
        // Not the expected top-level object — clean in place and pass through.
        mut other => {
            clean(&mut other);
            other
        }
    };
    serde_json::to_string_pretty(&reduced).map_err(|e| format!("re-serialize JSON: {e}"))
}

/// Recursively remove noise keys at every depth.
fn clean(value: &mut Value) {
    match value {
        Value::Object(map) => {
            let drop: Vec<String> = map
                .keys()
                .filter(|k| NOISE_KEYS.contains(&k.as_str()))
                .cloned()
                .collect();
            for k in drop {
                map.remove(&k);
            }
            for child in map.values_mut() {
                clean(child);
            }
        }
        Value::Array(arr) => {
            for child in arr.iter_mut() {
                clean(child);
            }
        }
        _ => {}
    }
}

/// A sanitized, filesystem-safe stem for temp file names. UAssetGUI keys off
/// the file name to locate the sibling `.uexp`, so the name must be stable
/// within a single derive but is otherwise arbitrary.
fn safe_stem(file_path: &str) -> String {
    let base = file_path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(file_path);
    let stem = base.rsplit_once('.').map(|(s, _)| s).unwrap_or(base);
    let cleaned: String = stem
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if cleaned.is_empty() {
        "asset".to_string()
    } else {
        cleaned
    }
}

/// `Command::new(tool)` with `CREATE_NO_WINDOW` on Windows so the headless
/// UAssetGUI invocation doesn't flash a console window.
fn uassetgui_command(tool: &str) -> Command {
    let cmd = Command::new(tool);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = cmd;
        cmd.creation_flags(CREATE_NO_WINDOW);
        return cmd;
    }
    #[cfg(not(windows))]
    cmd
}

/// A unique temp directory, removed (with its contents) on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Result<Self, String> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("riff-uasset-{}-{}", std::process::id(), n));
        fs::create_dir_all(&dir).map_err(|e| format!("create temp dir: {e}"))?;
        Ok(TempDir(dir))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(path: Option<&str>, bundled: bool) -> Config {
        Config {
            enabled: true,
            uassetgui_path: path.map(str::to_string),
            uassetgui_bundled: bundled,
            engine_version: "5.5".to_string(),
        }
    }

    #[test]
    fn derive_without_tool_points_at_settings() {
        let fd = derive_filediff(&cfg(None, true), "A.uasset", b"\x01", None, b"\x02", None, 1, 1);
        match fd {
            FileDiff::Binary { note, .. } => {
                assert!(note.unwrap_or_default().contains("settings"));
            }
            _ => panic!("expected a binary fallback"),
        }
    }

    #[test]
    fn derive_failure_note_names_tool_and_source() {
        let missing = "riff-test-definitely-missing-UAssetGUI.exe";
        let fd = derive_filediff(
            &cfg(Some(missing), true),
            "A.uasset",
            b"\x01\x02",
            None,
            b"\x03",
            None,
            2,
            1,
        );
        match fd {
            FileDiff::Binary { note, .. } => {
                let n = note.unwrap_or_default();
                assert!(n.contains(missing), "note should name the tool path: {n}");
                assert!(n.contains("bundled"), "note should name the source: {n}");
            }
            _ => panic!("expected a binary fallback"),
        }
    }

    /// Manual validation harness: run riff's real `filter_volatile` over an
    /// actual `UAssetGUI tojson` output file and write the reduced view out, so
    /// the user-facing diff can be inspected against real assets. Gated behind
    /// `--ignored` + env vars so it never runs in CI. Example:
    ///   $env:RIFF_UASSET_JSON="...\out.json"; $env:RIFF_UASSET_OUT="...\filtered.json"
    ///   cargo test --manifest-path src-tauri/Cargo.toml filter_real_json -- --ignored
    #[test]
    #[ignore]
    fn filter_real_json() {
        let inp = std::env::var("RIFF_UASSET_JSON").expect("set RIFF_UASSET_JSON");
        let outp = std::env::var("RIFF_UASSET_OUT").expect("set RIFF_UASSET_OUT");
        let raw = std::fs::read_to_string(&inp).expect("read input json");
        let filtered = filter_volatile(&raw).expect("filter_volatile ok");
        std::fs::write(&outp, &filtered).expect("write filtered json");
        eprintln!("filtered {} -> {} bytes", raw.len(), filtered.len());
        assert!(filtered.contains("Exports"));
    }

    #[test]
    fn is_uasset_path_matches_uasset_and_umap() {
        assert!(is_uasset_path("Foo.uasset"));
        assert!(is_uasset_path("Foo.umap"));
        assert!(is_uasset_path("deep/dir/Bar.UASSET")); // case-insensitive
        assert!(is_uasset_path(r"win\style\Level.Umap"));
        assert!(!is_uasset_path("Foo.uexp"));
        assert!(!is_uasset_path("notes.txt"));
        assert!(!is_uasset_path("uasset")); // extension-less, not a match
    }

    #[test]
    fn sibling_uexp_swaps_final_extension() {
        assert_eq!(sibling_uexp("Foo.uasset").as_deref(), Some("Foo.uexp"));
        assert_eq!(sibling_uexp("a/b/Level.umap").as_deref(), Some("a/b/Level.uexp"));
        // only the final extension is replaced
        assert_eq!(sibling_uexp("a.b.uasset").as_deref(), Some("a.b.uexp"));
        // no extension -> no sibling
        assert_eq!(sibling_uexp("noext"), None);
    }

    fn key(n: u64) -> RenderKey {
        (n, 0, "5.3".to_string())
    }

    #[test]
    fn render_cache_returns_what_it_stored() {
        let mut c = RenderCache::default();
        c.put(key(1), "json".into());
        assert_eq!(c.get(&key(1)).as_deref(), Some("json"));
        assert!(c.get(&key(2)).is_none());
    }

    #[test]
    fn render_cache_keys_on_the_engine_version_too() {
        // The same bytes parsed as a different engine version are a different
        // render, not a hit.
        let mut c = RenderCache::default();
        c.put((7, 0, "5.3".into()), "as 5.3".into());
        assert!(c.get(&(7, 0, "5.5".into())).is_none());
        assert_eq!(c.get(&(7, 0, "5.3".into())).as_deref(), Some("as 5.3"));
    }

    #[test]
    fn render_cache_evicts_the_least_recently_used() {
        let mut c = RenderCache::default();
        for i in 0..RENDER_CACHE_ENTRIES as u64 {
            c.put(key(i), format!("v{i}"));
        }
        // Touch the oldest so it is no longer the eviction candidate.
        assert!(c.get(&key(0)).is_some());
        c.put(key(999), "new".into());
        assert!(c.get(&key(0)).is_some(), "recently used entry survived");
        assert!(c.get(&key(1)).is_none(), "least recently used was dropped");
        assert_eq!(c.map.len(), RENDER_CACHE_ENTRIES);
    }

    #[test]
    fn render_cache_replaces_a_key_without_double_counting_bytes() {
        let mut c = RenderCache::default();
        c.put(key(1), "aaaa".into());
        c.put(key(1), "bb".into());
        assert_eq!(c.get(&key(1)).as_deref(), Some("bb"));
        assert_eq!(c.map.len(), 1);
        assert_eq!(c.order.len(), 1);
        assert_eq!(c.bytes, 2);
    }

    #[test]
    fn render_cache_refuses_a_value_larger_than_the_whole_budget() {
        let mut c = RenderCache::default();
        c.put(key(1), "x".repeat(RENDER_CACHE_BYTES + 1));
        assert!(c.get(&key(1)).is_none());
        assert_eq!(c.bytes, 0);
    }

    #[test]
    fn render_key_tracks_the_uexp_side() {
        assert_ne!(
            render_key(b"asset", Some(b"uexp"), "5.3"),
            render_key(b"asset", None, "5.3")
        );
        assert_eq!(
            render_key(b"asset", Some(b"uexp"), "5.3"),
            render_key(b"asset", Some(b"uexp"), "5.3")
        );
    }

    #[test]
    fn safe_stem_sanitizes_and_falls_back() {
        assert_eq!(safe_stem("dir/My_Asset.uasset"), "My_Asset");
        assert_eq!(safe_stem(r"C:\x\Weapon-01.umap"), "Weapon-01");
        // drops spaces / punctuation / non-ascii
        assert_eq!(safe_stem("My Asset!.uasset"), "MyAsset");
        // an all-garbage stem falls back to a constant
        assert_eq!(safe_stem("???.uasset"), "asset");
    }

    #[test]
    fn looks_like_lfs_pointer_detects_spec_header() {
        assert!(looks_like_lfs_pointer(
            b"version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 12\n"
        ));
        assert!(!looks_like_lfs_pointer(b"\x00\x01\x02 real binary asset"));
        assert!(!looks_like_lfs_pointer(b""));
    }

    #[test]
    fn filter_volatile_keeps_only_exports_and_imports() {
        let raw = r#"{
            "$type": "UAssetAPI.UAsset, UAssetAPI",
            "NameMap": ["A", "B"],
            "PackageGuid": "{F1F9-...}",
            "Exports": [],
            "Imports": []
        }"#;
        let out = filter_volatile(raw).unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        let obj = v.as_object().unwrap();
        assert!(obj.contains_key("Exports"));
        assert!(obj.contains_key("Imports"));
        // every other root-level key is dropped
        assert_eq!(obj.len(), 2);
    }

    #[test]
    fn filter_volatile_strips_noise_at_every_depth() {
        let raw = r#"{
          "Exports": [
            {
              "$type": "UAssetAPI.ExportTypes.NormalExport, UAssetAPI",
              "ObjectName": "Script",
              "SerialOffset": 1382,
              "SerialSize": 41,
              "OuterIndex": 0,
              "ObjectFlags": "RF_Public",
              "PackageGuid": "{0000}",
              "Data": [
                {
                  "$type": "UAssetAPI.PropertyTypes.Objects.ObjectPropertyData, UAssetAPI",
                  "Name": "AssetImportData",
                  "ArrayIndex": 0,
                  "PropertyGuid": null,
                  "Value": 1
                }
              ]
            }
          ],
          "Imports": []
        }"#;
        let out = filter_volatile(raw).unwrap();
        // content-bearing fields survive...
        assert!(out.contains("\"ObjectName\""));
        assert!(out.contains("Script"));
        assert!(out.contains("\"Value\""));
        // ...while serialization noise is gone at both export and property depth
        for noise in [
            "$type",
            "SerialOffset",
            "SerialSize",
            "OuterIndex",
            "ObjectFlags",
            "PackageGuid",
            "ArrayIndex",
            "PropertyGuid",
        ] {
            assert!(!out.contains(noise), "noise key `{noise}` should be stripped");
        }
    }

    #[test]
    fn filter_volatile_is_deterministic() {
        // serde_json's default key-ordered Map makes the same content serialize
        // byte-identically, which is what keeps derived diffs stable.
        let raw = r#"{"Imports":[],"Exports":[{"ObjectName":"Z","Data":[]}]}"#;
        assert_eq!(filter_volatile(raw).unwrap(), filter_volatile(raw).unwrap());
    }

    #[test]
    fn filter_volatile_passes_through_non_object_root() {
        // A non-object root isn't the expected package summary; it's cleaned in
        // place (noise stripped) and passed through rather than reduced to {}.
        let raw = r#"[{"$type":"X","keep":1}]"#;
        let out = filter_volatile(raw).unwrap();
        assert!(out.contains("keep"));
        assert!(!out.contains("$type"));
    }

    #[test]
    fn filter_volatile_rejects_malformed_json() {
        assert!(filter_volatile("{ not valid json").is_err());
    }
}
