use crate::workspace::{canonicalize_workspace, PathProbe, Platform, WorkspaceId};
use crate::{evaluate_permission_mode, PermissionDecision, PermissionMode, PermissionSource};
use serde::Serialize;
use serde_json::{Map, Value};

#[doc(hidden)]
pub const SETTINGS_SCHEMA_VERSION: u32 = 2;

#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadMapping {
    pub workspace: String,
    pub thread_id: String,
}

#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub schema_version: u32,
    pub workspace: Option<String>,
    pub threads: Vec<ThreadMapping>,
    pub permission_mode: String,
    pub speech_style: String,
    pub codex_binary: Option<String>,
    pub microphone: Option<String>,
    pub autostart: bool,
    pub hotkey: Option<String>,
    pub wizard_completed: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            workspace: None,
            threads: Vec::new(),
            permission_mode: "safe".to_owned(),
            speech_style: "mandarin".to_owned(),
            codex_binary: None,
            microphone: None,
            autostart: true,
            hotkey: None,
            wizard_completed: false,
            extra: Map::new(),
        }
    }
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingsError {
    InvalidJson,
    UnknownVersion,
}

/// 确定性升级：缺失字段补默认值、未知顶层字段保留在 extra、版本号固定为当前
/// schema。migrate 对已是最新 schema 的输入是幂等的。
#[doc(hidden)]
pub fn migrate(raw_json: &str, from_version: u32) -> Result<Settings, SettingsError> {
    if from_version > SETTINGS_SCHEMA_VERSION {
        return Err(SettingsError::UnknownVersion);
    }
    let parsed: Value = serde_json::from_str(raw_json).map_err(|_| SettingsError::InvalidJson)?;
    let mut obj = parsed.as_object().cloned().unwrap_or_default();
    let _ = obj.remove("schemaVersion");
    let mut settings = Settings::default();
    if let Some(value) = obj.remove("workspace") {
        if let Some(workspace) = value.as_str() {
            settings.workspace = Some(workspace.to_owned());
        }
    }
    if let Some(value) = obj.remove("threads") {
        if let Some(list) = value.as_array() {
            settings.threads = list
                .iter()
                .filter_map(|item| {
                    let workspace = item.get("workspace")?.as_str()?.to_owned();
                    let thread_id = item
                        .get("threadId")
                        .or_else(|| item.get("thread_id"))?
                        .as_str()?
                        .to_owned();
                    Some(ThreadMapping {
                        workspace,
                        thread_id,
                    })
                })
                .collect();
        }
    }
    if let Some(value) = obj.remove("permissionMode") {
        if let Some(permission) = value.as_str() {
            settings.permission_mode = permission.to_owned();
        }
    }
    if let Some(value) = obj.remove("speechStyle") {
        if let Some(style) = value.as_str() {
            settings.speech_style = style.to_owned();
        }
    }
    if let Some(value) = obj.remove("codexBinary") {
        if let Some(binary) = value.as_str() {
            settings.codex_binary = Some(binary.to_owned());
        }
    }
    if let Some(value) = obj.remove("microphone") {
        if let Some(microphone) = value.as_str() {
            settings.microphone = Some(microphone.to_owned());
        }
    }
    if let Some(value) = obj.remove("autostart") {
        if let Some(autostart) = value.as_bool() {
            settings.autostart = autostart;
        }
    }
    if let Some(value) = obj.remove("hotkey") {
        if let Some(hotkey) = value.as_str() {
            settings.hotkey = Some(hotkey.to_owned());
        }
    }
    if let Some(value) = obj.remove("wizardCompleted") {
        if let Some(completed) = value.as_bool() {
            settings.wizard_completed = completed;
        }
    }
    settings.extra = obj;
    settings.schema_version = SETTINGS_SCHEMA_VERSION;
    Ok(settings)
}

/// 把前端 localStorage 快照导入为版本化设置：工作目录按规范 id 落盘，
/// thread 键按规范 workspace 去重折叠（同目录多种写法合并为一条记录，
/// 规范写法的 threadId 优先）。
#[doc(hidden)]
pub fn import_legacy(snapshot: &Value, platform: Platform, probe: &dyn PathProbe) -> Settings {
    let mut settings = Settings::default();
    let Some(obj) = snapshot.as_object() else {
        return settings;
    };
    if let Some(workspace) = obj.get("jarvis.workspace").and_then(Value::as_str) {
        if let Ok(resolved) = canonicalize_workspace(workspace, platform, probe) {
            settings.workspace = Some(resolved.id.as_str().to_owned());
        }
    }
    if let Some(permission) = obj.get("jarvis.permissionMode").and_then(Value::as_str) {
        settings.permission_mode = permission.to_owned();
    }
    if let Some(style) = obj.get("jarvis.speechStyle").and_then(Value::as_str) {
        settings.speech_style = style.to_owned();
    }
    if let Some(binary) = obj.get("jarvis.codexBinary").and_then(Value::as_str) {
        settings.codex_binary = Some(binary.to_owned());
    }
    let mut raw_mappings: Vec<(String, String, String)> = Vec::new();
    for (key, value) in obj {
        let Some(suffix) = key.strip_prefix("jarvis.threadId:") else {
            continue;
        };
        let Some(thread_id) = value.as_str() else {
            continue;
        };
        if let Ok(resolved) = canonicalize_workspace(suffix, platform, probe) {
            raw_mappings.push((
                resolved.id.as_str().to_owned(),
                suffix.to_owned(),
                thread_id.to_owned(),
            ));
        }
    }
    for (canonical, suffix, thread_id) in raw_mappings {
        if let Some(existing) = settings
            .threads
            .iter_mut()
            .find(|mapping| mapping.workspace == canonical)
        {
            if suffix == canonical {
                existing.thread_id = thread_id;
            }
        } else {
            settings.threads.push(ThreadMapping {
                workspace: canonical,
                thread_id,
            });
        }
    }
    settings
}

/// 存储态权限落地：一律经 evaluate_permission_mode(StoredConfig)。
/// 存储的 full 降级为 safe；auto + 主目录降级为 safe；safe 原样保留。
#[doc(hidden)]
pub fn resolve_stored_permission(
    mode: &str,
    workspace: Option<&WorkspaceId>,
    home: &WorkspaceId,
    platform: Platform,
) -> String {
    let mode = match mode {
        "auto" => PermissionMode::Auto,
        "full" => PermissionMode::Full,
        _ => PermissionMode::Safe,
    };
    let Some(workspace) = workspace else {
        return "safe".to_owned();
    };
    let decision = evaluate_permission_mode(
        mode,
        workspace,
        home,
        PermissionSource::StoredConfig,
        platform,
    );
    match decision {
        PermissionDecision::Allow(permission) => permission_name(permission),
        PermissionDecision::Downgraded { to, .. } => permission_name(to),
        PermissionDecision::Reject { .. } => "safe".to_owned(),
    }
}

fn permission_name(mode: PermissionMode) -> String {
    match mode {
        PermissionMode::Safe => "safe",
        PermissionMode::Auto => "auto",
        PermissionMode::Full => "full",
    }
    .to_owned()
}

#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WritePlan {
    pub temp_path: String,
    pub backup_path: String,
    pub final_path: String,
    pub size_bytes: usize,
}

/// 原子写计划：先写 temp，再把 final 改名备份，最后 temp 原子替换 final。
#[doc(hidden)]
pub fn write_plan(path: &str, bytes: &[u8]) -> WritePlan {
    WritePlan {
        temp_path: format!("{path}.tmp"),
        backup_path: format!("{path}.bak"),
        final_path: path.to_owned(),
        size_bytes: bytes.len(),
    }
}

/// 按规范 workspace id 更新 thread 映射；已存在则替换，否则追加。
#[doc(hidden)]
pub fn upsert_thread(threads: &mut Vec<ThreadMapping>, workspace: &str, thread_id: &str) {
    if let Some(existing) = threads
        .iter_mut()
        .find(|mapping| mapping.workspace == workspace)
    {
        existing.thread_id = thread_id.to_owned();
    } else {
        threads.push(ThreadMapping {
            workspace: workspace.to_owned(),
            thread_id: thread_id.to_owned(),
        });
    }
}
