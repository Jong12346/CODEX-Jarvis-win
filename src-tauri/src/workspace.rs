use serde::Serialize;
use std::path::Path;

const THREAD_KEY_PREFIX: &str = "jarvis.threadId:";

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Unix,
}

#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct WorkspaceId(String);

impl WorkspaceId {
    #[doc(hidden)]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkspaceError {
    Empty,
    NotFound,
    NotADirectory,
    Unreadable,
}

#[doc(hidden)]
pub trait PathProbe {
    fn is_dir(&self, path: &str) -> bool;
    fn real_path(&self, path: &str) -> Result<String, WorkspaceError>;
}

#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedWorkspace {
    pub id: WorkspaceId,
    pub native_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceInfo {
    pub(crate) id: String,
    pub(crate) display: String,
    pub(crate) thread_key: String,
    pub(crate) source_thread_key: String,
    pub(crate) legacy_thread_keys: Vec<String>,
}

pub(crate) struct SystemPathProbe;

impl PathProbe for SystemPathProbe {
    fn is_dir(&self, path: &str) -> bool {
        Path::new(path).is_dir()
    }

    fn real_path(&self, path: &str) -> Result<String, WorkspaceError> {
        Path::new(path)
            .canonicalize()
            .map(|value| value.to_string_lossy().into_owned())
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::NotFound => WorkspaceError::NotFound,
                _ => WorkspaceError::Unreadable,
            })
    }
}

#[doc(hidden)]
pub fn normalize_workspace_path(real_path: &str, platform: Platform) -> String {
    match platform {
        Platform::Windows => normalize_windows_path(real_path),
        Platform::Unix => normalize_unix_path(real_path),
    }
}

fn normalize_windows_path(real_path: &str) -> String {
    let mut normalized = real_path.replace('/', "\\");
    const VERBATIM_UNC: &str = "\\\\?\\UNC\\";
    const VERBATIM: &str = "\\\\?\\";

    if normalized
        .get(..VERBATIM_UNC.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(VERBATIM_UNC))
    {
        normalized = format!("\\\\{}", &normalized[VERBATIM_UNC.len()..]);
    } else if normalized.starts_with(VERBATIM) {
        normalized = normalized[VERBATIM.len()..].to_owned();
    }

    if normalized.as_bytes().get(1) == Some(&b':')
        && normalized
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
    {
        let drive = normalized.as_bytes()[0].to_ascii_uppercase() as char;
        normalized.replace_range(..1, &drive.to_string());
    }

    while normalized.ends_with('\\') && !is_windows_drive_root(&normalized) && normalized.len() > 2
    {
        normalized.pop();
    }
    normalized
}

fn is_windows_drive_root(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() == 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\'
}

fn normalize_unix_path(real_path: &str) -> String {
    let mut normalized = real_path.to_owned();
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    normalized
}

#[doc(hidden)]
pub fn canonicalize_workspace(
    input: &str,
    platform: Platform,
    probe: &dyn PathProbe,
) -> Result<ResolvedWorkspace, WorkspaceError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(WorkspaceError::Empty);
    }
    let native_path = probe.real_path(input)?;
    if !probe.is_dir(&native_path) {
        return Err(WorkspaceError::NotADirectory);
    }
    let id = normalize_workspace_path(&native_path, platform);
    if id.is_empty() {
        return Err(WorkspaceError::Unreadable);
    }
    Ok(ResolvedWorkspace {
        id: WorkspaceId(id),
        native_path,
    })
}

#[doc(hidden)]
pub fn workspace_thread_key(id: &WorkspaceId) -> String {
    format!("{THREAD_KEY_PREFIX}{}", id.as_str())
}

#[doc(hidden)]
pub fn workspace_display(id: &WorkspaceId) -> String {
    id.as_str().to_owned()
}

pub(crate) fn workspace_info(
    input: &str,
    platform: Platform,
    probe: &dyn PathProbe,
) -> Result<(ResolvedWorkspace, WorkspaceInfo), WorkspaceError> {
    let resolved = canonicalize_workspace(input, platform, probe)?;
    let thread_key = workspace_thread_key(&resolved.id);
    let source_thread_key = format!("{THREAD_KEY_PREFIX}{}", input.trim());
    let mut legacy_thread_keys = vec![
        source_thread_key.clone(),
        thread_key.clone(),
        format!("{THREAD_KEY_PREFIX}{}", resolved.native_path),
    ];
    legacy_thread_keys.sort();
    legacy_thread_keys.dedup();
    // Keep the exact pre-migration spelling first so the frontend can prefer
    // the thread that the previous jarvis.workspace value actually selected.
    if let Some(position) = legacy_thread_keys
        .iter()
        .position(|key| key == &source_thread_key)
    {
        legacy_thread_keys.swap(0, position);
    }
    let info = WorkspaceInfo {
        id: resolved.id.as_str().to_owned(),
        display: workspace_display(&resolved.id),
        thread_key,
        source_thread_key,
        legacy_thread_keys,
    };
    Ok((resolved, info))
}

pub(crate) fn workspace_error_message(error: WorkspaceError) -> &'static str {
    match error {
        WorkspaceError::Empty => "工作目录不能为空",
        WorkspaceError::NotFound => "工作目录不存在",
        WorkspaceError::NotADirectory => "工作目录不是文件夹",
        WorkspaceError::Unreadable => "工作目录无法读取",
    }
}

pub(crate) const fn current_platform() -> Platform {
    if cfg!(windows) {
        Platform::Windows
    } else {
        Platform::Unix
    }
}
