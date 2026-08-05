//! P0-3 可执行规格：权限模式映射与危险工作区的拒绝／降级。
//!
//! 激活前提（`#[doc(hidden)] pub`）：
//!
//! ```ignore
//! pub enum PermissionMode { Safe, Auto, Full }   // impl Default -> Safe
//! pub struct PermissionProfile {
//!     pub approval_policy: &'static str,
//!     pub sandbox: &'static str,
//!     pub instructions: &'static str,
//! }
//! pub fn permission_profile(mode: PermissionMode) -> PermissionProfile;
//!
//! pub enum PermissionSource { UserSelection, StoredConfig }
//! pub enum PermissionRejectionReason { WorkspaceIsHome, WorkspaceIsHomeAncestor, RequiresConfirmation }
//! pub enum PermissionDecision {
//!     Allow(PermissionMode),
//!     Reject { attempted: PermissionMode, reason: PermissionRejectionReason },
//!     Downgraded { from: PermissionMode, to: PermissionMode, reason: PermissionRejectionReason },
//! }
//! pub fn evaluate_permission_mode(
//!     mode: PermissionMode,
//!     workspace: &WorkspaceId,
//!     home: &WorkspaceId,
//!     source: PermissionSource,
//!     platform: Platform,
//! ) -> PermissionDecision;
//! ```

use jarvis_codex_lib::{
    canonicalize_workspace, evaluate_permission_mode, permission_profile, PathProbe,
    PermissionDecision, PermissionMode, PermissionRejectionReason, PermissionSource, Platform,
    WorkspaceError, WorkspaceId,
};

/// 最小探测器：把任何以盘符开头的路径当作存在的目录。
/// 本文件关心的是权限判定，不是路径解析（那是 workspace_path.rs 的职责）。
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

#[test]
fn the_mapping_table_is_exact() {
    // 逐模式断言三元组。这是 Codex app-server 实际收到的参数，
    // 也是 P0-3 影响面的唯一来源。
    for (mode, approval, sandbox) in [
        (PermissionMode::Safe, "on-request", "workspace-write"),
        (PermissionMode::Auto, "never", "workspace-write"),
        (PermissionMode::Full, "never", "danger-full-access"),
    ] {
        let profile = permission_profile(mode);
        assert_eq!(
            profile.approval_policy, approval,
            "{mode:?}.approval_policy"
        );
        assert_eq!(profile.sandbox, sandbox, "{mode:?}.sandbox");
        assert!(
            !profile.instructions.trim().is_empty(),
            "{mode:?}.instructions must not be empty"
        );
    }
}

#[test]
fn safe_is_the_only_mode_that_still_asks() {
    // 决定 3 的实质：safe 之外的两个模式都不再询问，
    // 所以默认值必须是 safe。
    assert_eq!(
        permission_profile(PermissionMode::Safe).approval_policy,
        "on-request"
    );
    for mode in [PermissionMode::Auto, PermissionMode::Full] {
        assert_eq!(
            permission_profile(mode).approval_policy,
            "never",
            "{mode:?} does not prompt, so it cannot be a default"
        );
    }
}

#[test]
fn the_default_mode_is_safe() {
    assert_eq!(PermissionMode::default(), PermissionMode::Safe);
}

#[test]
fn explicitly_choosing_auto_in_the_home_directory_is_rejected() {
    // P0-3 的核心回归。
    let home = id(r"C:\Users\DELL");
    let decision = evaluate_permission_mode(
        PermissionMode::Auto,
        &home,
        &home,
        PermissionSource::UserSelection,
        Platform::Windows,
    );
    match decision {
        PermissionDecision::Reject { attempted, reason } => {
            assert_eq!(attempted, PermissionMode::Auto);
            assert_eq!(reason, PermissionRejectionReason::WorkspaceIsHome);
        }
        other => panic!("expected Reject, got {other:?}"),
    }
}

#[test]
fn explicitly_choosing_auto_above_the_home_directory_is_rejected() {
    let home = id(r"C:\Users\DELL");
    for ancestor in [r"C:\Users", r"C:\"] {
        let decision = evaluate_permission_mode(
            PermissionMode::Auto,
            &id(ancestor),
            &home,
            PermissionSource::UserSelection,
            Platform::Windows,
        );
        match decision {
            PermissionDecision::Reject { reason, .. } => assert_eq!(
                reason,
                PermissionRejectionReason::WorkspaceIsHomeAncestor,
                "{ancestor} is an ancestor of the home directory"
            ),
            other => panic!("{ancestor}: expected Reject, got {other:?}"),
        }
    }
}

#[test]
fn auto_is_allowed_strictly_below_the_home_directory() {
    // 决定 2 的默认工作区 %USERPROFILE%\Jarvis 必须仍然可用 auto，
    // 否则新默认值会让推荐配置无法工作。
    let home = id(r"C:\Users\DELL");
    for descendant in [
        r"C:\Users\DELL\Jarvis",
        r"C:\Users\DELL\Jarvis\project",
        r"E:\Workspace",
    ] {
        let decision = evaluate_permission_mode(
            PermissionMode::Auto,
            &id(descendant),
            &home,
            PermissionSource::UserSelection,
            Platform::Windows,
        );
        assert!(
            matches!(decision, PermissionDecision::Allow(PermissionMode::Auto)),
            "{descendant} should permit auto, got {decision:?}"
        );
    }
}

#[test]
fn a_sibling_that_merely_shares_a_prefix_is_not_the_home_directory() {
    // 前缀匹配的经典陷阱：C:\Users\DELL2 不是 C:\Users\DELL 的后代，
    // 也不是它的祖先。用字符串 starts_with 实现会误判。
    let home = id(r"C:\Users\DELL");
    let decision = evaluate_permission_mode(
        PermissionMode::Auto,
        &id(r"C:\Users\DELL2"),
        &home,
        PermissionSource::UserSelection,
        Platform::Windows,
    );
    assert!(
        matches!(decision, PermissionDecision::Allow(PermissionMode::Auto)),
        "C:\\Users\\DELL2 is unrelated to the home directory, got {decision:?}"
    );
}

#[test]
fn a_stored_auto_plus_home_config_is_downgraded_not_rejected() {
    // 决定 4：旧配置不能直接报错把用户挡在门外，也不能静默继续以 auto 运行。
    let home = id(r"C:\Users\DELL");
    let decision = evaluate_permission_mode(
        PermissionMode::Auto,
        &home,
        &home,
        PermissionSource::StoredConfig,
        Platform::Windows,
    );
    match decision {
        PermissionDecision::Downgraded { from, to, reason } => {
            assert_eq!(from, PermissionMode::Auto);
            assert_eq!(to, PermissionMode::Safe, "must land on the prompting mode");
            assert_eq!(reason, PermissionRejectionReason::WorkspaceIsHome);
        }
        other => panic!("expected Downgraded, got {other:?}"),
    }
}

#[test]
fn stored_config_never_restores_full_access() {
    // 决定 4：full 不跨重启恢复，必须重新二次确认。
    let workspace = id(r"E:\Workspace");
    let home = id(r"C:\Users\DELL");
    let decision = evaluate_permission_mode(
        PermissionMode::Full,
        &workspace,
        &home,
        PermissionSource::StoredConfig,
        Platform::Windows,
    );
    match decision {
        PermissionDecision::Downgraded { from, to, reason } => {
            assert_eq!(from, PermissionMode::Full);
            assert_eq!(to, PermissionMode::Safe);
            assert_eq!(reason, PermissionRejectionReason::RequiresConfirmation);
        }
        other => panic!("full must not survive a restart unconfirmed, got {other:?}"),
    }
}

#[test]
fn safe_is_always_allowed_regardless_of_workspace() {
    let home = id(r"C:\Users\DELL");
    for workspace in [r"C:\Users\DELL", r"C:\Users", r"C:\", r"E:\Workspace"] {
        for source in [
            PermissionSource::UserSelection,
            PermissionSource::StoredConfig,
        ] {
            let decision = evaluate_permission_mode(
                PermissionMode::Safe,
                &id(workspace),
                &home,
                source,
                Platform::Windows,
            );
            assert!(
                matches!(decision, PermissionDecision::Allow(PermissionMode::Safe)),
                "safe must never be blocked ({workspace}, {source:?}), got {decision:?}"
            );
        }
    }
}

#[test]
fn no_decision_path_silently_keeps_auto_over_the_home_directory() {
    // 兜底不变量：无论来源如何，"auto + 主目录/祖先"都不得产出 Allow(Auto)。
    let home = id(r"C:\Users\DELL");
    for workspace in [r"C:\Users\DELL", r"C:\Users", r"C:\"] {
        for source in [
            PermissionSource::UserSelection,
            PermissionSource::StoredConfig,
        ] {
            let decision = evaluate_permission_mode(
                PermissionMode::Auto,
                &id(workspace),
                &home,
                source,
                Platform::Windows,
            );
            assert!(
                !matches!(decision, PermissionDecision::Allow(PermissionMode::Auto)),
                "{workspace} ({source:?}) leaked an autonomous runtime over the user profile"
            );
        }
    }
}
