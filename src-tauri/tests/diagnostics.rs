//! Phase 4 contract: diagnostics classification, redaction and log rotation.
//!
//! Activation note (same as phases 1-3): this file lives here until the
//! symbols exist, then the implementation commit moves it into
//! src-tauri/tests/ with `git mv`. All behavior is expressed through
//! #[doc(hidden)] pub pure functions so the suite runs on any platform.
//!
//! Fixed decisions encoded here:
//! - classify(ProbeResult) -> Verdict: each fault maps to a stable, distinct
//!   code (frontend and reviewers match on the string, like RequestRejection).
//! - Voice-affecting faults carry a suggested_action_zh that mentions falling
//!   back to a text task on the same thread.
//! - redact() removes login tokens, proxy passwords, sensitive env values and
//!   the username segment of absolute paths while preserving structure.
//! - rotate_plan() keeps the newest logs within max_bytes and deletes oldest
//!   first; the newest file is never deleted.

use jarvis_codex_lib::{classify, redact, rotate_plan, LogFileInfo, ProbeResult, VerdictLevel};

#[test]
fn ok_is_green_with_a_stable_code() {
    let verdict = classify(ProbeResult::Ok);
    assert_eq!(verdict.level, VerdictLevel::Green);
    assert_eq!(verdict.code, "ok");
    assert!(!verdict.message_zh.trim().is_empty());
}

#[test]
fn every_fault_maps_to_a_distinct_stable_code() {
    let results = [
        ProbeResult::CodexMissing,
        ProbeResult::CodexNotLoggedIn,
        ProbeResult::ProxyUnreachable,
        ProbeResult::TlsError,
        ProbeResult::NetworkTimeout,
        ProbeResult::MicDenied,
        ProbeResult::SpeechPackMissing,
        ProbeResult::WebView2Missing,
        ProbeResult::WorkspaceUnreadable,
    ];
    let expected = [
        "codex_missing",
        "codex_not_logged_in",
        "proxy_unreachable",
        "tls_error",
        "network_timeout",
        "mic_denied",
        "speech_pack_missing",
        "webview2_missing",
        "workspace_unreadable",
    ];
    let mut codes: Vec<&str> = results
        .iter()
        .map(|result| classify(*result).code)
        .collect();
    let mut expected_sorted: Vec<&str> = expected.to_vec();
    codes.sort_unstable();
    codes.dedup();
    expected_sorted.sort_unstable();
    assert_eq!(
        codes, expected_sorted,
        "the fault code set must be stable and distinct"
    );
}

#[test]
fn fault_levels_are_appropriate() {
    for result in [
        ProbeResult::CodexMissing,
        ProbeResult::CodexNotLoggedIn,
        ProbeResult::WebView2Missing,
        ProbeResult::WorkspaceUnreadable,
    ] {
        assert_eq!(
            classify(result).level,
            VerdictLevel::Red,
            "{result:?} must be Red"
        );
    }
    for result in [
        ProbeResult::ProxyUnreachable,
        ProbeResult::TlsError,
        ProbeResult::NetworkTimeout,
        ProbeResult::MicDenied,
        ProbeResult::SpeechPackMissing,
    ] {
        assert_eq!(
            classify(result).level,
            VerdictLevel::Yellow,
            "{result:?} must be Yellow"
        );
    }
}

#[test]
fn every_verdict_has_chinese_message_and_action() {
    for result in [
        ProbeResult::Ok,
        ProbeResult::CodexMissing,
        ProbeResult::CodexNotLoggedIn,
        ProbeResult::ProxyUnreachable,
        ProbeResult::TlsError,
        ProbeResult::NetworkTimeout,
        ProbeResult::MicDenied,
        ProbeResult::SpeechPackMissing,
        ProbeResult::WebView2Missing,
        ProbeResult::WorkspaceUnreadable,
    ] {
        let verdict = classify(result);
        assert!(
            !verdict.message_zh.trim().is_empty(),
            "{result:?}.message_zh"
        );
        assert!(
            !verdict.suggested_action_zh.trim().is_empty(),
            "{result:?}.suggested_action_zh"
        );
    }
}

#[test]
fn voice_faults_suggest_text_degrade() {
    for result in [
        ProbeResult::ProxyUnreachable,
        ProbeResult::TlsError,
        ProbeResult::NetworkTimeout,
        ProbeResult::MicDenied,
        ProbeResult::SpeechPackMissing,
    ] {
        assert!(
            classify(result).suggested_action_zh.contains("文字任务"),
            "{result:?} must suggest falling back to a text task on the same thread"
        );
    }
}

#[test]
fn redact_removes_bearer_tokens() {
    let sample = "Authorization: Bearer abcDEF123XYZ";
    let out = redact(sample);
    assert!(
        !out.contains("abcDEF123XYZ"),
        "bearer token must be removed"
    );
    assert!(
        out.contains("Authorization: Bearer <redacted>"),
        "structure must stay"
    );
}

#[test]
fn redact_removes_openai_keys() {
    let bare = redact("sk-proj-abc123XYZ");
    assert!(!bare.contains("sk-proj-abc123XYZ"));
    assert!(
        bare.contains("sk-<redacted>"),
        "a bare key keeps the sk- prefix"
    );
    let env = redact("OPENAI_API_KEY=sk-proj-abc123XYZ");
    assert!(!env.contains("sk-proj-abc123XYZ"));
    assert!(
        env.contains("<redacted>"),
        "an env assignment fully redacts the value"
    );
}

#[test]
fn redact_removes_proxy_passwords() {
    let sample = "HTTP_PROXY=http://user:p@ssw0rd@proxy.example.com:8080";
    let out = redact(sample);
    assert!(!out.contains("p@ssw0rd"), "proxy password must be removed");
    assert!(
        out.contains("proxy.example.com"),
        "the diagnostic structure (host) must survive"
    );
    assert!(!out.contains("http://user:p@ssw0rd@"));
}

#[test]
fn redact_removes_sensitive_env_values() {
    let sample = "TOKEN=secret123; API_PASSWORD=hunter2; HTTP_PROXY=http://u:p@h:1";
    let out = redact(sample);
    assert!(!out.contains("secret123"));
    assert!(!out.contains("hunter2"));
    assert!(!out.contains(":p@h:1"));
}

#[test]
fn redact_windows_user_segment() {
    let sample = r"C:\Users\DELL\Workspace\project";
    let out = redact(sample);
    assert!(
        !out.contains("DELL"),
        "the username segment must be removed"
    );
    assert!(out.contains(r"C:\Users\<user>\Workspace\project"));
}

#[test]
fn redact_unix_home_segment() {
    let sample = "/home/alice/code";
    let out = redact(sample);
    assert!(!out.contains("alice"));
    assert!(out.contains("/home/<user>/code"));
}

#[test]
fn redact_preserves_plain_diagnostic_text() {
    let sample = "检查完成：工作目录可读，权限模式 safe，线程 3 个。";
    assert_eq!(redact(sample), sample);
}

#[test]
fn redact_is_idempotent() {
    let sample =
        "Authorization: Bearer abc; C:\\Users\\DELL\\x; HTTP_PROXY=http://u:p@h:1; TOKEN=secret";
    let once = redact(sample);
    let twice = redact(&once);
    assert_eq!(once, twice);
}

#[test]
fn rotate_plan_keeps_files_within_cap() {
    let files = vec![
        LogFileInfo {
            name: "a".into(),
            size_bytes: 10,
            modified_ms: 1,
        },
        LogFileInfo {
            name: "b".into(),
            size_bytes: 20,
            modified_ms: 2,
        },
        LogFileInfo {
            name: "c".into(),
            size_bytes: 30,
            modified_ms: 3,
        },
    ];
    let plan = rotate_plan(files, 60);
    assert_eq!(plan.delete, Vec::<String>::new());
    assert_eq!(plan.keep.len(), 3);
}

#[test]
fn rotate_plan_deletes_oldest_first() {
    let files = vec![
        LogFileInfo {
            name: "a".into(),
            size_bytes: 10,
            modified_ms: 1,
        },
        LogFileInfo {
            name: "b".into(),
            size_bytes: 10,
            modified_ms: 2,
        },
        LogFileInfo {
            name: "c".into(),
            size_bytes: 10,
            modified_ms: 3,
        },
    ];
    let plan = rotate_plan(files, 20);
    assert_eq!(plan.keep, vec!["c".to_string(), "b".to_string()]);
    assert_eq!(plan.delete, vec!["a".to_string()]);
}

#[test]
fn rotate_plan_never_deletes_the_newest() {
    let files = vec![
        LogFileInfo {
            name: "a".into(),
            size_bytes: 10,
            modified_ms: 1,
        },
        LogFileInfo {
            name: "b".into(),
            size_bytes: 10,
            modified_ms: 2,
        },
    ];
    let plan = rotate_plan(files, 0);
    assert_eq!(plan.keep, vec!["b".to_string()]);
    assert_eq!(plan.delete, vec!["a".to_string()]);
}

#[test]
fn rotate_plan_keeps_newest_when_it_alone_exceeds_cap() {
    let files = vec![
        LogFileInfo {
            name: "a".into(),
            size_bytes: 10,
            modified_ms: 1,
        },
        LogFileInfo {
            name: "b".into(),
            size_bytes: 100,
            modified_ms: 2,
        },
    ];
    let plan = rotate_plan(files, 50);
    assert_eq!(plan.keep, vec!["b".to_string()]);
    assert_eq!(plan.delete, vec!["a".to_string()]);
}

#[test]
fn rotate_plan_empty_input() {
    let plan = rotate_plan(Vec::new(), 100);
    assert!(plan.keep.is_empty());
    assert!(plan.delete.is_empty());
}

#[test]
fn rotate_plan_sorts_by_modification_time() {
    let files = vec![
        LogFileInfo {
            name: "late".into(),
            size_bytes: 5,
            modified_ms: 200,
        },
        LogFileInfo {
            name: "early".into(),
            size_bytes: 5,
            modified_ms: 100,
        },
    ];
    let plan = rotate_plan(files, 5);
    assert_eq!(plan.keep, vec!["late".to_string()]);
    assert_eq!(plan.delete, vec!["early".to_string()]);
}

#[test]
fn verdict_levels_serialize_stable() {
    use serde_json::json;
    assert_eq!(
        serde_json::to_value(VerdictLevel::Green).unwrap(),
        json!("green")
    );
    assert_eq!(
        serde_json::to_value(VerdictLevel::Yellow).unwrap(),
        json!("yellow")
    );
    assert_eq!(
        serde_json::to_value(VerdictLevel::Red).unwrap(),
        json!("red")
    );
}

#[test]
fn verdict_serializes_with_zh_fields() {
    use serde_json::json;
    let verdict = classify(ProbeResult::MicDenied);
    let value = serde_json::to_value(verdict).unwrap();
    assert_eq!(value["level"], json!("yellow"));
    assert_eq!(value["code"], json!("mic_denied"));
    assert!(value["messageZh"].as_str().is_some_and(|s| !s.is_empty()));
    assert!(value["suggestedActionZh"]
        .as_str()
        .is_some_and(|s| !s.is_empty()));
}
