//! Phase 5 contract: versioned backend settings store.
//!
//! Activation note (same as phases 1-4): this file lives here until the
//! symbols exist, then the implementation commit moves it into
//! src-tauri/tests/ with `git mv`. Pure functions are driven with injected
//! probes and snapshots; no real disk, device or network is touched.
//!
//! Fixed decisions encoded here:
//! - migrate(raw, from_version) deterministically upgrades every historical
//!   version to the current schema, preserves unknown top-level fields, and
//!   is idempotent.
//! - import_legacy(localStorage snapshot) folds every spelling of a directory
//!   into one canonical thread mapping (P0-1 semantics), preferring the
//!   canonical spelling when several thread ids compete.
//! - write_plan produces temp -> backup -> final paths for atomic replacement.
//! - Stored permissions always pass evaluate_permission_mode(StoredConfig):
//!   stored full downgrades to safe; auto on the home directory downgrades.

use jarvis_codex_lib::{
    canonicalize_workspace, import_legacy, migrate, resolve_stored_permission, upsert_thread,
    write_plan, PathProbe, Platform, Settings, SettingsError, ThreadMapping, WorkspaceError,
    WorkspaceId, SETTINGS_SCHEMA_VERSION,
};
use serde_json::{json, Value};

struct AnyDir;

impl PathProbe for AnyDir {
    fn is_dir(&self, _path: &str) -> bool {
        true
    }
    fn real_path(&self, path: &str) -> Result<String, WorkspaceError> {
        Ok(format!(r"\\?\{}", path.trim_end_matches('\\')))
    }
}

fn id(path: &str) -> WorkspaceId {
    canonicalize_workspace(path, Platform::Windows, &AnyDir)
        .expect("test path resolves")
        .id
}

struct CaseFoldingProbe;

impl PathProbe for CaseFoldingProbe {
    fn is_dir(&self, _path: &str) -> bool {
        true
    }
    fn real_path(&self, path: &str) -> Result<String, WorkspaceError> {
        // 模拟 Windows 文件系统按磁盘实际大小写归一：同一目录的所有大小写
        // 写法都解析到同一规范路径。
        let cleaned = path.trim_end_matches('\\');
        if cleaned.to_ascii_lowercase().contains(r"c:\users\dell\proj") {
            Ok(r"\\?\C:\Users\DELL\proj".to_owned())
        } else {
            Ok(format!(r"\\?\{}", cleaned))
        }
    }
}
fn snapshot_with_competing_threads() -> Value {
    json!({
        "jarvis.workspace": r"C:\Users\DELL\proj",
        "jarvis.permissionMode": "auto",
        "jarvis.speechStyle": "shaanxi",
        "jarvis.codexBinary": r"C:\tools\codex.exe",
        r"jarvis.threadId:C:\Users\DELL\proj": "t-canonical",
        r"jarvis.threadId:c:\users\dell\proj\": "t-lower",
        r"jarvis.threadId:\\?\C:\Users\DELL\proj": "t-extended",
    })
}

#[test]
fn empty_object_upgrades_to_current_schema() {
    let settings = migrate("{}", 0).expect("empty object migrates");
    assert_eq!(settings.schema_version, SETTINGS_SCHEMA_VERSION);
    assert_eq!(settings.permission_mode, "safe");
    assert_eq!(settings.speech_style, "mandarin");
    assert!(settings.autostart);
    assert!(settings.workspace.is_none());
    assert!(settings.threads.is_empty());
}

#[test]
fn missing_fields_get_defaults() {
    let settings = migrate(r#"{"workspace":"C:\\proj"}"#, 0).expect("partial migrates");
    assert_eq!(settings.workspace.as_deref(), Some("C:\\proj"));
    assert_eq!(settings.permission_mode, "safe");
    assert_eq!(settings.speech_style, "mandarin");
}

#[test]
fn every_historical_version_upgrades() {
    for version in 0..=SETTINGS_SCHEMA_VERSION {
        let settings = migrate("{}", version).expect("every known version upgrades");
        assert_eq!(settings.schema_version, SETTINGS_SCHEMA_VERSION);
    }
    assert_eq!(
        migrate("{}", SETTINGS_SCHEMA_VERSION + 1),
        Err(SettingsError::UnknownVersion)
    );
}

#[test]
fn migrate_is_idempotent() {
    let once = migrate("{}", 0).unwrap();
    let serialized = serde_json::to_string(&once).unwrap();
    let twice = migrate(&serialized, SETTINGS_SCHEMA_VERSION).unwrap();
    assert_eq!(once, twice);
}

#[test]
fn unknown_fields_are_preserved() {
    let raw = r#"{"workspace":"C:\\proj","futureFlag":true,"futureList":[1,2]}"#;
    let settings = migrate(raw, 0).unwrap();
    assert_eq!(settings.extra.get("futureFlag"), Some(&json!(true)));
    assert_eq!(settings.extra.get("futureList"), Some(&json!([1, 2])));
    let back = serde_json::to_string(&settings).unwrap();
    let again = migrate(&back, SETTINGS_SCHEMA_VERSION).unwrap();
    assert_eq!(again.extra.get("futureFlag"), Some(&json!(true)));
}

#[test]
fn invalid_json_is_an_error() {
    assert_eq!(migrate("not json", 0), Err(SettingsError::InvalidJson));
}

#[test]
fn threads_round_trip_through_json() {
    let mut settings = migrate("{}", 0).unwrap();
    upsert_thread(&mut settings.threads, "ws-1", "t-1");
    upsert_thread(&mut settings.threads, "ws-2", "t-2");
    let serialized = serde_json::to_string(&settings).unwrap();
    let parsed = migrate(&serialized, SETTINGS_SCHEMA_VERSION).unwrap();
    assert_eq!(parsed.threads, settings.threads);
}

#[test]
fn import_legacy_folds_competing_spellings_into_one_record() {
    let settings = import_legacy(
        &snapshot_with_competing_threads(),
        Platform::Windows,
        &CaseFoldingProbe,
    );
    assert_eq!(
        settings.threads.len(),
        1,
        "one directory must produce one mapping"
    );
    let canonical = id(r"C:\Users\DELL\proj").as_str().to_owned();
    let matches: Vec<&ThreadMapping> = settings
        .threads
        .iter()
        .filter(|mapping| mapping.workspace == canonical)
        .collect();
    assert_eq!(matches.len(), 1, "one directory must produce one mapping");
    assert_eq!(
        matches[0].thread_id, "t-canonical",
        "the canonical spelling wins"
    );
    assert_eq!(settings.workspace.as_deref(), Some(canonical.as_str()));
    assert_eq!(settings.permission_mode, "auto");
    assert_eq!(settings.speech_style, "shaanxi");
    assert_eq!(
        settings.codex_binary.as_deref(),
        Some(r"C:\tools\codex.exe")
    );
}

#[test]
fn import_legacy_handles_case_slashes_trailing_and_extended_prefix() {
    let variants = [
        r"C:\Users\DELL\proj",
        r"c:\users\dell\proj",
        r"C:\Users\DELL\proj\",
        r"C:/Users/DELL/proj",
        r"\\?\C:\Users\DELL\proj",
    ];
    let canonical =
        canonicalize_workspace(r"C:\Users\DELL\proj", Platform::Windows, &CaseFoldingProbe)
            .expect("canonical path resolves")
            .id;
    for variant in variants {
        let canonicalized = canonicalize_workspace(variant, Platform::Windows, &CaseFoldingProbe)
            .expect("variant resolves")
            .id;
        assert_eq!(
            canonicalized, canonical,
            "{variant} must map to one workspace id"
        );
    }
    let snapshot = json!({
        "jarvis.workspace": r"C:\Users\DELL\proj",
        r"jarvis.threadId:C:\Users\DELL\proj": "t-1",
        r"jarvis.threadId:c:\users\dell\proj": "t-2",
        r"jarvis.threadId:C:\Users\DELL\proj\": "t-3",
        r"jarvis.threadId:\\?\C:\Users\DELL\proj": "t-4",
    });
    let settings = import_legacy(&snapshot, Platform::Windows, &CaseFoldingProbe);
    assert_eq!(settings.threads.len(), 1);
    assert_eq!(settings.threads[0].workspace, canonical.as_str());
}

#[test]
fn import_legacy_keeps_distinct_directories_separate() {
    let snapshot = json!({
        r"jarvis.threadId:C:\Users\DELL\proj": "t-a",
        r"jarvis.threadId:E:\Work\proj": "t-b",
    });
    let settings = import_legacy(&snapshot, Platform::Windows, &AnyDir);
    assert_eq!(settings.threads.len(), 2);
}

#[test]
fn import_legacy_missing_fields_stay_defaults() {
    let settings = import_legacy(&json!({}), Platform::Windows, &AnyDir);
    assert_eq!(settings.permission_mode, "safe");
    assert_eq!(settings.speech_style, "mandarin");
    assert!(settings.threads.is_empty());
}

#[test]
fn import_legacy_ignores_unreadable_workspaces() {
    struct NotFound;
    impl PathProbe for NotFound {
        fn is_dir(&self, _path: &str) -> bool {
            false
        }
        fn real_path(&self, _path: &str) -> Result<String, WorkspaceError> {
            Err(WorkspaceError::NotFound)
        }
    }
    let snapshot = json!({
        "jarvis.workspace": r"C:\gone\missing",
        r"jarvis.threadId:C:\gone\missing": "t-x",
    });
    let settings = import_legacy(&snapshot, Platform::Windows, &NotFound);
    assert!(settings.workspace.is_none());
    assert!(settings.threads.is_empty());
}

#[test]
fn stored_full_downgrades_to_safe() {
    let home = id(r"C:\Users\DELL");
    let workspace = id(r"C:\Users\DELL\proj");
    assert_eq!(
        resolve_stored_permission("full", Some(&workspace), &home, Platform::Windows),
        "safe"
    );
}

#[test]
fn stored_auto_on_home_downgrades_to_safe() {
    let home = id(r"C:\Users\DELL");
    assert_eq!(
        resolve_stored_permission("auto", Some(&home), &home, Platform::Windows),
        "safe"
    );
}

#[test]
fn stored_auto_below_home_stays_auto() {
    let home = id(r"C:\Users\DELL");
    let workspace = id(r"C:\Users\DELL\proj");
    assert_eq!(
        resolve_stored_permission("auto", Some(&workspace), &home, Platform::Windows),
        "auto"
    );
}

#[test]
fn stored_safe_stays_safe() {
    let home = id(r"C:\Users\DELL");
    let workspace = id(r"C:\Users\DELL\proj");
    assert_eq!(
        resolve_stored_permission("safe", Some(&workspace), &home, Platform::Windows),
        "safe"
    );
}

#[test]
fn missing_workspace_resolves_to_safe() {
    let home = id(r"C:\Users\DELL");
    assert_eq!(
        resolve_stored_permission("full", None, &home, Platform::Windows),
        "safe"
    );
}

#[test]
fn write_plan_uses_temp_then_final_with_backup() {
    let plan = write_plan(r"C:\data\settings.json", b"hello");
    assert_ne!(plan.temp_path, plan.final_path);
    assert_ne!(plan.backup_path, plan.final_path);
    assert_ne!(plan.temp_path, plan.backup_path);
    assert_eq!(plan.final_path, r"C:\data\settings.json");
    assert_eq!(plan.size_bytes, 5);
}

#[test]
fn write_plan_paths_are_stable() {
    let first = write_plan("settings.json", b"x");
    let second = write_plan("settings.json", b"x");
    assert_eq!(first, second);
}

#[test]
fn upsert_thread_replaces_existing_workspace() {
    let mut threads = Vec::new();
    upsert_thread(&mut threads, "ws-1", "old");
    upsert_thread(&mut threads, "ws-2", "other");
    upsert_thread(&mut threads, "ws-1", "new");
    assert_eq!(threads.len(), 2);
    let ws1 = threads.iter().find(|m| m.workspace == "ws-1").unwrap();
    assert_eq!(ws1.thread_id, "new");
}

#[test]
fn settings_defaults_are_versioned() {
    let settings = Settings::default();
    assert_eq!(settings.schema_version, SETTINGS_SCHEMA_VERSION);
    assert_eq!(settings.permission_mode, "safe");
    assert!(settings.autostart);
}

#[test]
fn thread_mapping_serializes_camel_case() {
    let mapping = ThreadMapping {
        workspace: "ws".to_owned(),
        thread_id: "t".to_owned(),
    };
    let value = serde_json::to_value(mapping).unwrap();
    assert_eq!(value, json!({"workspace": "ws", "threadId": "t"}));
}
