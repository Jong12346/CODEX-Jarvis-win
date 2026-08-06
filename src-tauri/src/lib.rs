use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    fs::OpenOptions,
    io::Write as _,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    process::Command,
    sync::{oneshot, Mutex, RwLock},
    time::{timeout, Duration},
};

#[doc(hidden)]
pub mod app_shell;
mod diagnostics;
mod process;
mod runtime_state;
mod settings_store;
mod stop_sequence;
mod voice_state;
mod workspace;

#[doc(hidden)]
pub use diagnostics::{
    classify, redact, rotate_plan, LogFileInfo, ProbeResult, RotatePlan, Verdict, VerdictLevel,
};
use process::SystemProcessSpawner;
#[doc(hidden)]
pub use process::{ProcessControl, ProcessSpawner, ProcessSpec, SpawnedCodexProcess};
#[doc(hidden)]
pub use runtime_state::{
    request_rejection, restart_backoff, runtime_state_transition, should_watcher_restart,
    stability_reset_interval, RequestRejection, RuntimeEvent, RuntimeGeneration, RuntimeState,
    MAX_AUTO_RESTARTS,
};
#[doc(hidden)]
pub use settings_store::{
    import_legacy, migrate, resolve_stored_permission, upsert_thread, write_plan, Settings,
    SettingsError, ThreadMapping, WritePlan, SETTINGS_SCHEMA_VERSION,
};
#[doc(hidden)]
pub use stop_sequence::{
    advance_stop_step, next_stop_action, on_stop_triggered, termination_targets, JobTreeSnapshot,
    StopAction, StopStep, STOP_GRACE,
};
#[doc(hidden)]
pub use voice_state::{
    degraded_info, is_reconnect_allowed, mic_owner, voice_state_transition, DegradedInfo, MicOwner,
    TimeoutStage, VoiceErrorKind, VoiceEvent, VoiceState,
};
pub use workspace::{
    canonicalize_workspace, normalize_workspace_path, workspace_display, workspace_thread_key,
    PathProbe, Platform, ResolvedWorkspace, WorkspaceError, WorkspaceId,
};
use workspace::{
    current_platform, workspace_error_message, workspace_info, SystemPathProbe, WorkspaceInfo,
};

struct AppState {
    runtime: Mutex<Option<Arc<CodexRuntime>>>,
    runtime_status: RwLock<RuntimeStateInfo>,
    runtime_generation: AtomicU64,
    desired_runtime: Mutex<Option<RuntimeLaunchConfig>>,
    process_spawner: Arc<dyn ProcessSpawner>,
    log_lock: StdMutex<()>,
    cold_wake_pending: AtomicBool,
    background_start: bool,
    wake_enabled: AtomicBool,
    wake_ready: AtomicBool,
    wake_supervisor_running: AtomicBool,
    wake_pid: AtomicU32,
    wake_authorization: RwLock<String>,
    wake_release_requested: AtomicBool,
    wake_control_file: Mutex<Option<PathBuf>>,
    voice_status: RwLock<VoiceStateInfo>,
    stop_step: RwLock<StopStep>,
    stop_sequence_running: AtomicBool,
}

#[tauri::command]
fn startup_is_background(state: State<'_, AppState>) -> bool {
    state.background_start
}

#[cfg(target_os = "macos")]
#[tauri::command]
async fn request_microphone_permission() -> Result<String, String> {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};
    use std::sync::Mutex as StdMutex;

    let media_type =
        unsafe { AVMediaTypeAudio }.ok_or_else(|| "macOS 未提供音频授权类型".to_owned())?;
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media_type) };
    match status {
        AVAuthorizationStatus::Authorized => return Ok("authorized".to_owned()),
        AVAuthorizationStatus::Denied => return Ok("denied".to_owned()),
        AVAuthorizationStatus::Restricted => return Ok("restricted".to_owned()),
        _ => {}
    }

    let (sender, receiver) = oneshot::channel::<bool>();
    let sender = Arc::new(StdMutex::new(Some(sender)));
    {
        let completion_sender = sender.clone();
        let completion = RcBlock::new(move |granted: Bool| {
            if let Ok(mut guard) = completion_sender.lock() {
                if let Some(sender) = guard.take() {
                    let _ = sender.send(granted.as_bool());
                }
            }
        });
        unsafe {
            AVCaptureDevice::requestAccessForMediaType_completionHandler(media_type, &completion);
        }
    }
    let granted = receiver
        .await
        .map_err(|_| "macOS 麦克风授权回调中断".to_owned())?;
    Ok(if granted { "authorized" } else { "denied" }.to_owned())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
async fn request_microphone_permission() -> Result<String, String> {
    Ok("authorized".to_owned())
}

struct CodexRuntime {
    writer: Mutex<Box<dyn AsyncWrite + Send + Unpin>>,
    control: Arc<dyn ProcessControl>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    thread_id: RwLock<Option<String>>,
    active_turn: RwLock<Option<String>>,
    voice_active: AtomicBool,
    voice_phase: RwLock<String>,
    realtime_session_id: RwLock<Option<String>>,
    permission_mode: PermissionMode,
    speech_style: SpeechStyle,
    workspace: WorkspaceId,
    codex_binary: PathBuf,
    generation: RuntimeGeneration,
    terminal_observed: AtomicBool,
}

struct RuntimeIo {
    stdout: Box<dyn AsyncRead + Send + Unpin>,
    stderr: Box<dyn AsyncRead + Send + Unpin>,
}

#[derive(Clone)]
struct RuntimeLaunchConfig {
    permission_mode: PermissionMode,
    speech_style: SpeechStyle,
    workspace: WorkspaceId,
    codex_binary: PathBuf,
    resume_thread_id: Option<String>,
}

#[doc(hidden)]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStateInfo {
    runtime_id: Option<String>,
    state: RuntimeState,
    restart_attempts: u32,
    last_exit_code: Option<i32>,
    last_error_code: Option<String>,
    last_error: Option<String>,
}

impl Default for RuntimeStateInfo {
    fn default() -> Self {
        Self {
            runtime_id: None,
            state: RuntimeState::Absent,
            restart_attempts: 0,
            last_exit_code: None,
            last_error_code: None,
            last_error: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeTransitionLog<'a> {
    schema_version: u8,
    timestamp_ms: u128,
    event: &'static str,
    runtime_id: Option<&'a str>,
    from: RuntimeState,
    to: RuntimeState,
    trigger: &'static str,
    pid: Option<u32>,
    exit_code: Option<i32>,
    signal: Option<i32>,
    restart_attempt: u32,
    error_code: Option<&'a str>,
    error_message: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WakeProtocolLog {
    schema_version: u8,
    timestamp_ms: u128,
    event: &'static str,
}

#[derive(Default)]
struct RuntimeTransitionDetails {
    pid: Option<u32>,
    exit_code: Option<i32>,
    error_code: Option<String>,
    error_message: Option<String>,
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    #[default]
    Safe,
    Auto,
    Full,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum SpeechStyle {
    #[default]
    Mandarin,
    Shaanxi,
}

impl SpeechStyle {
    fn instructions(self) -> &'static str {
        match self {
            Self::Mandarin => "Reply in the user's language. When speaking Chinese, use clear, natural Standard Mandarin.",
            Self::Shaanxi => "Reply in the user's language. When speaking Chinese, use a friendly, natural Shaanxi dialect style with recognizable Guanzhong phrasing and a light Shaanxi accent. Keep technical terms, code, commands, paths, names, numbers, and safety warnings exact. Prioritize clarity over caricature, and do not claim the accent is an authentic local recording.",
        }
    }
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PermissionProfile {
    pub approval_policy: &'static str,
    pub sandbox: &'static str,
    pub instructions: &'static str,
}

#[doc(hidden)]
pub fn permission_profile(mode: PermissionMode) -> PermissionProfile {
    match mode {
        PermissionMode::Safe => PermissionProfile {
            approval_policy: "on-request",
            sandbox: "workspace-write",
            instructions: "Require explicit confirmation when Codex requests approval for actions outside the workspace boundary or for risky operations.",
        },
        PermissionMode::Auto => PermissionProfile {
            approval_policy: "never",
            sandbox: "workspace-write",
            instructions: "Work autonomously inside the selected workspace. Never request elevated access; if an action is blocked by the sandbox, explain the blocked boundary and continue with the safest in-workspace alternative.",
        },
        PermissionMode::Full => PermissionProfile {
            approval_policy: "never",
            sandbox: "danger-full-access",
            instructions: "Full filesystem and network access is enabled. Still avoid destructive or irreversible actions unless the user explicitly requested the exact action and target.",
        },
    }
}

impl PermissionMode {
    fn profile(self) -> PermissionProfile {
        permission_profile(self)
    }
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionSource {
    UserSelection,
    StoredConfig,
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionRejectionReason {
    WorkspaceIsHome,
    WorkspaceIsHomeAncestor,
    RequiresConfirmation,
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionDecision {
    Allow(PermissionMode),
    Reject {
        attempted: PermissionMode,
        reason: PermissionRejectionReason,
    },
    Downgraded {
        from: PermissionMode,
        to: PermissionMode,
        reason: PermissionRejectionReason,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PermissionResolution {
    mode: PermissionMode,
    changed: bool,
    reason: Option<PermissionRejectionReason>,
}

fn permission_rejection_message(reason: PermissionRejectionReason) -> &'static str {
    match reason {
        PermissionRejectionReason::WorkspaceIsHome => {
            "Automatic mode cannot use the user profile as its workspace"
        }
        PermissionRejectionReason::WorkspaceIsHomeAncestor => {
            "Automatic mode cannot use a parent of the user profile as its workspace"
        }
        PermissionRejectionReason::RequiresConfirmation => {
            "Full access requires explicit confirmation"
        }
    }
}

fn workspace_parts(id: &WorkspaceId, platform: Platform) -> Vec<String> {
    match platform {
        Platform::Windows => id
            .as_str()
            .split(['\\', '/'])
            .filter(|part| !part.is_empty())
            .map(|part| part.to_ascii_lowercase())
            .collect(),
        Platform::Unix => id
            .as_str()
            .split('/')
            .filter(|part| !part.is_empty())
            .map(str::to_owned)
            .collect(),
    }
}

#[doc(hidden)]
pub fn evaluate_permission_mode(
    mode: PermissionMode,
    workspace: &WorkspaceId,
    home: &WorkspaceId,
    source: PermissionSource,
    platform: Platform,
) -> PermissionDecision {
    if mode == PermissionMode::Safe {
        return PermissionDecision::Allow(mode);
    }
    if mode == PermissionMode::Full && source == PermissionSource::StoredConfig {
        return PermissionDecision::Downgraded {
            from: mode,
            to: PermissionMode::Safe,
            reason: PermissionRejectionReason::RequiresConfirmation,
        };
    }
    if mode != PermissionMode::Auto {
        return PermissionDecision::Allow(mode);
    }
    let candidate_parts = workspace_parts(workspace, platform);
    let home_parts = workspace_parts(home, platform);
    let reason = if candidate_parts == home_parts {
        Some(PermissionRejectionReason::WorkspaceIsHome)
    } else if candidate_parts.len() < home_parts.len() && home_parts.starts_with(&candidate_parts) {
        Some(PermissionRejectionReason::WorkspaceIsHomeAncestor)
    } else {
        None
    };
    match (reason, source) {
        (None, _) => PermissionDecision::Allow(mode),
        (Some(reason), PermissionSource::UserSelection) => PermissionDecision::Reject {
            attempted: mode,
            reason,
        },
        (Some(reason), PermissionSource::StoredConfig) => PermissionDecision::Downgraded {
            from: mode,
            to: PermissionMode::Safe,
            reason,
        },
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    thread_id: String,
    cwd: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectVoiceInfo {
    codex_connected: bool,
    voice_active: bool,
    phase: String,
    protocol: &'static str,
    thread_id: Option<String>,
    realtime_session_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartCodexVoiceRequest {
    cwd: String,
    thread_id: Option<String>,
    permission_mode: PermissionMode,
    #[serde(default)]
    speech_style: SpeechStyle,
    codex_path: Option<String>,
    sdp: String,
    voice: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WakeStatus {
    enabled: bool,
    ready: bool,
    authorization: String,
}

fn append_runtime_log<T: Serialize>(app: &AppHandle, record: &T) {
    let state = app.state::<AppState>();
    let Ok(_guard) = state.log_lock.lock() else {
        return;
    };
    let Ok(directory) = app.path().app_log_dir() else {
        return;
    };
    if fs::create_dir_all(&directory).is_err() {
        return;
    }
    let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("jarvis-runtime.jsonl"))
    else {
        return;
    };
    if let Ok(mut line) = serde_json::to_vec(record) {
        line.push(b'\n');
        let _ = file.write_all(&line);
    }
}

fn log_wake_protocol_event(app: &AppHandle, event: &'static str) {
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    append_runtime_log(
        app,
        &WakeProtocolLog {
            schema_version: 1,
            timestamp_ms,
            event,
        },
    );
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceStateInfo {
    state: VoiceState,
    mic_owner: MicOwner,
    reconnect_attempts: u32,
    degraded: Option<DegradedInfo>,
}

impl Default for VoiceStateInfo {
    fn default() -> Self {
        Self {
            state: VoiceState::Booting,
            mic_owner: MicOwner::None,
            reconnect_attempts: 0,
            degraded: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceTransitionLog<'a> {
    schema_version: u8,
    timestamp_ms: u128,
    event: &'static str,
    from: VoiceState,
    to: VoiceState,
    trigger: &'static str,
    mic_owner: MicOwner,
    reconnect_attempts: u32,
    error_kind: Option<VoiceErrorKind>,
    recoverable: Option<bool>,
    suggested_action: Option<&'a str>,
    error_owner: Option<MicOwner>,
}

/// 每次状态迁移：写 JSONL、emit 前端载荷、必要时自动重新布防唤醒。
async fn transition_voice_state(app: &AppHandle, event: VoiceEvent) -> VoiceStateInfo {
    let state = app.state::<AppState>();
    let (from, info) = {
        let mut info = state.voice_status.write().await;
        let from = info.state;
        let owner_before = mic_owner(from);
        let next = voice_state_transition(from, event);
        info.state = next;
        info.mic_owner = mic_owner(next);
        if event == VoiceEvent::ReconnectRequested && next == VoiceState::VoiceConnecting {
            info.reconnect_attempts = info.reconnect_attempts.saturating_add(1);
        }
        if event == VoiceEvent::VoiceConnected {
            info.reconnect_attempts = 0;
        }
        if let Some(degraded) = degraded_info(event, owner_before) {
            info.degraded = Some(degraded);
        } else if next != VoiceState::Degraded {
            info.degraded = None;
        }
        (from, info.clone())
    };
    if info.state == VoiceState::VoiceAcquiringMicrophone {
        schedule_voice_stage_timeout(
            app,
            VoiceState::VoiceAcquiringMicrophone,
            VoiceEvent::Timeout {
                stage: TimeoutStage::MicrophoneAcquire,
            },
            Duration::from_secs(15),
        );
    }
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    append_runtime_log(
        app,
        &VoiceTransitionLog {
            schema_version: 1,
            timestamp_ms,
            event: "jarvis.voice.state_transition",
            from,
            to: info.state,
            trigger: event.trigger(),
            mic_owner: info.mic_owner,
            reconnect_attempts: info.reconnect_attempts,
            error_kind: info.degraded.map(|degraded| degraded.error_kind),
            recoverable: info.degraded.map(|degraded| degraded.recoverable),
            suggested_action: info.degraded.map(|degraded| degraded.suggested_action),
            error_owner: info.degraded.map(|degraded| degraded.owner),
        },
    );
    let _ = app.emit("jarvis-voice-state", info.clone());
    if info.state == VoiceState::VoiceAcquiringMicrophone {
        let _ = app.emit(
            "jarvis-voice-may-acquire-microphone",
            json!({"state": "voiceAcquiringMicrophone"}),
        );
    }
    if matches!(info.state, VoiceState::WakeArming | VoiceState::WakeReady) {
        start_wake_supervisor(app.clone());
    }
    info
}

fn schedule_voice_stage_timeout(
    app: &AppHandle,
    expected: VoiceState,
    event: VoiceEvent,
    delay: Duration,
) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        let state = app.state::<AppState>();
        if state.voice_status.read().await.state == expected {
            transition_voice_state(&app, event).await;
        }
    });
}

async fn request_wake_mic_release(app: &AppHandle) {
    let state = app.state::<AppState>();
    state.wake_release_requested.store(true, Ordering::SeqCst);
    let Some(path) = state.wake_control_file.lock().await.clone() else {
        return;
    };
    let _ = fs::write(&path, "release");
}

/// STOP 与目录切换的有序关闭前缀：先停 realtime、打断 turn、清理后台终端，
/// 再让状态机推进到 WakeRearming（由 VoiceStopped 驱动）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StopSequenceLog<'a> {
    schema_version: u8,
    timestamp_ms: u128,
    event: &'static str,
    runtime_id: Option<&'a str>,
    thread_id: Option<&'a str>,
    pid: Option<u32>,
    step: StopStep,
    action: StopAction,
    child_alive: bool,
    grace_elapsed: bool,
    terminated_pids: Vec<u32>,
}

fn log_stop_sequence_action(app: &AppHandle, record: &StopSequenceLog<'_>) {
    append_runtime_log(app, record);
}

/// STOP / 目录切换 / 权限或 Codex 路径切换的有序关闭驱动：
/// thread/realtime/stop -> turn/interrupt -> 短宽限期 -> 若本 runtime 进程树
/// 仍存活则用 Job Object 精确终止 -> 按原 thread 重建 app-server -> VoiceStopped。
fn run_stop_sequence(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let Some(runtime) = state.runtime.lock().await.clone() else {
            transition_voice_state(&app, VoiceEvent::VoiceStopped).await;
            state.stop_sequence_running.store(false, Ordering::SeqCst);
            return;
        };
        // 让旧代 watcher 失效，避免杀树/自退被当成可自动重启的意外死亡。
        state.runtime_generation.fetch_add(1, Ordering::SeqCst);
        let thread_id = runtime.thread_id.read().await.clone();
        let runtime_id = state.runtime_status.read().await.runtime_id.clone();
        let mut step = {
            let mut guard = state.stop_step.write().await;
            *guard = on_stop_triggered(*guard);
            *guard
        };
        let mut grace_started_at: Option<std::time::Instant> = None;
        let mut killed_once = false;
        loop {
            let child_alive = runtime.control.try_wait().ok().flatten().is_none();
            let grace_elapsed = grace_started_at
                .map(|started| started.elapsed() >= STOP_GRACE)
                .unwrap_or(false);
            let action = next_stop_action(step, child_alive, grace_elapsed);
            let terminated_pids = if matches!(action, StopAction::KillJobTree) {
                runtime.control.pid().into_iter().collect()
            } else {
                Vec::new()
            };
            let timestamp_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            log_stop_sequence_action(
                &app,
                &StopSequenceLog {
                    schema_version: 1,
                    timestamp_ms,
                    event: "jarvis.stop_sequence.action",
                    runtime_id: runtime_id.as_deref(),
                    thread_id: thread_id.as_deref(),
                    pid: runtime.control.pid(),
                    step,
                    action,
                    child_alive,
                    grace_elapsed,
                    terminated_pids,
                },
            );
            match action {
                StopAction::SendRealtimeStop => {
                    if let Some(thread) = thread_id.as_deref() {
                        let _ = runtime
                            .request("thread/realtime/stop", json!({"threadId": thread}))
                            .await;
                    }
                }
                StopAction::SendTurnInterrupt => {
                    if let Some(thread) = thread_id.as_deref() {
                        if let Some(turn_id) = runtime.active_turn.read().await.clone() {
                            let _ = runtime
                                .request(
                                    "turn/interrupt",
                                    json!({"threadId": thread, "turnId": turn_id}),
                                )
                                .await;
                        }
                    }
                }
                StopAction::WaitGrace => {
                    grace_started_at.get_or_insert_with(std::time::Instant::now);
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
                StopAction::KillJobTree => {
                    if !killed_once {
                        killed_once = true;
                        runtime.terminal_observed.store(true, Ordering::SeqCst);
                        runtime.fail_pending("runtime_stopping").await;
                        runtime.reset_voice_state().await;
                        runtime.voice_active.store(false, Ordering::SeqCst);
                        *runtime.voice_phase.write().await = "closed".to_owned();
                        *runtime.realtime_session_id.write().await = None;
                        {
                            let mut active = state.runtime.lock().await;
                            if active
                                .as_ref()
                                .is_some_and(|candidate| Arc::ptr_eq(candidate, &runtime))
                            {
                                active.take();
                            }
                        }
                        transition_runtime_state(
                            &app,
                            RuntimeEvent::ShutdownRequested,
                            RuntimeTransitionDetails::default(),
                        )
                        .await;
                    }
                    let _ = runtime.control.terminate_job_tree();
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                StopAction::Rebuild => {
                    let config = state.desired_runtime.lock().await.clone();
                    if let Some(config) = config {
                        let generation = RuntimeGeneration(
                            state.runtime_generation.fetch_add(1, Ordering::SeqCst) + 1,
                        );
                        let _ = launch_runtime(app.clone(), config, generation, 0).await;
                    }
                }
                StopAction::Done => break,
            }
            step = advance_stop_step(step, action);
        }
        *state.stop_step.write().await = step;
        transition_voice_state(&app, VoiceEvent::VoiceStopped).await;
        state.stop_sequence_running.store(false, Ordering::SeqCst);
    });
}

/// 前端事件入口（report_voice_event 命令与 sidecar 命中共用）。
async fn handle_voice_event(app: AppHandle, event: VoiceEvent) -> VoiceStateInfo {
    match event {
        VoiceEvent::WakeDetected => {
            transition_voice_state(&app, VoiceEvent::WakeDetected).await;
            let info = transition_voice_state(&app, VoiceEvent::WakeReleaseRequested).await;
            if info.state == VoiceState::WakeReleasingMicrophone {
                request_wake_mic_release(&app).await;
            }
            info
        }
        VoiceEvent::StopRequested | VoiceEvent::WorkspaceSwitchRequested => {
            let info = transition_voice_state(&app, event).await;
            if info.state == VoiceState::VoiceStopping
                && !app
                    .state::<AppState>()
                    .stop_sequence_running
                    .swap(true, Ordering::SeqCst)
            {
                run_stop_sequence(app.clone());
            }
            info
        }
        VoiceEvent::VoiceMicrophoneAcquired => {
            let info = transition_voice_state(&app, event).await;
            if info.state == VoiceState::VoiceConnecting {
                schedule_voice_stage_timeout(
                    &app,
                    VoiceState::VoiceConnecting,
                    VoiceEvent::Timeout {
                        stage: TimeoutStage::VoiceConnect,
                    },
                    Duration::from_secs(20),
                );
            }
            info
        }
        VoiceEvent::RetryRequested => {
            let info = transition_voice_state(&app, event).await;
            if info.state == VoiceState::Booting {
                transition_voice_state(&app, VoiceEvent::BootCompleted).await
            } else {
                info
            }
        }
        _ => transition_voice_state(&app, event).await,
    }
}

/// 集成层会话重置：仅在 Stopping/Degraded 终态后由前端主动发起新会话时使用，
/// 不属于纯状态机的迁移，不写状态迁移日志。
async fn reset_voice_machine(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut info = state.voice_status.write().await;
    if !matches!(info.state, VoiceState::Stopping | VoiceState::Degraded) {
        return;
    }
    info.state = VoiceState::Booting;
    info.mic_owner = MicOwner::None;
    info.reconnect_attempts = 0;
    info.degraded = None;
    let _ = app.emit("jarvis-voice-state", info.clone());
}

#[tauri::command]
async fn voice_state(state: State<'_, AppState>) -> Result<VoiceStateInfo, String> {
    Ok(state.voice_status.read().await.clone())
}

#[tauri::command]
async fn report_voice_event(app: AppHandle, event: String) -> Result<VoiceStateInfo, String> {
    let event = VoiceEvent::from_trigger(&event).ok_or("unknown voice event")?;
    Ok(handle_voice_event(app, event).await)
}

async fn transition_runtime_state(
    app: &AppHandle,
    event: RuntimeEvent,
    details: RuntimeTransitionDetails,
) -> RuntimeStateInfo {
    let state = app.state::<AppState>();
    let (from, info) = {
        let mut info = state.runtime_status.write().await;
        let from = info.state;
        info.state = runtime_state_transition(from, event);
        if let Some(code) = details.exit_code {
            info.last_exit_code = Some(code);
        }
        if details.error_code.is_some() {
            info.last_error_code = details.error_code.clone();
            info.last_error = details.error_message.clone();
        }
        (from, info.clone())
    };
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    append_runtime_log(
        app,
        &RuntimeTransitionLog {
            schema_version: 1,
            timestamp_ms,
            event: "jarvis.runtime.state_transition",
            runtime_id: info.runtime_id.as_deref(),
            from,
            to: info.state,
            trigger: event.trigger(),
            pid: details.pid,
            exit_code: details.exit_code,
            signal: None,
            restart_attempt: info.restart_attempts,
            error_code: details.error_code.as_deref(),
            error_message: details.error_message.as_deref(),
        },
    );
    let _ = app.emit("jarvis-runtime-state", info.clone());
    info
}

#[tauri::command]
async fn runtime_state(state: State<'_, AppState>) -> Result<RuntimeStateInfo, String> {
    Ok(state.runtime_status.read().await.clone())
}

fn start_runtime_watchers(app: AppHandle, runtime: &Arc<CodexRuntime>, io: RuntimeIo) {
    let RuntimeIo { stdout, stderr } = io;
    let weak = Arc::downgrade(runtime);
    let event_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if message.get("method").is_none() {
                if let Some(id) = message.get("id").and_then(Value::as_u64) {
                    if let Some(runtime) = weak.upgrade() {
                        if let Some(sender) = runtime.pending.lock().await.remove(&id) {
                            let result = if let Some(error) = message.get("error") {
                                Err(error
                                    .get("message")
                                    .and_then(Value::as_str)
                                    .unwrap_or("Codex request failed")
                                    .to_owned())
                            } else {
                                Ok(message.get("result").cloned().unwrap_or(Value::Null))
                            };
                            let _ = sender.send(result);
                        }
                    }
                }
                continue;
            }
            if let Some(runtime) = weak.upgrade() {
                match message.get("method").and_then(Value::as_str) {
                    Some("turn/started") => {
                        *runtime.active_turn.write().await = message
                            .pointer("/params/turn/id")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        transition_voice_state(&event_app, VoiceEvent::TurnStarted).await;
                    }
                    Some("turn/completed") => {
                        *runtime.active_turn.write().await = None;
                        transition_voice_state(&event_app, VoiceEvent::TurnCompleted).await;
                    }
                    Some("thread/realtime/started") => {
                        runtime.voice_active.store(true, Ordering::SeqCst);
                        *runtime.voice_phase.write().await = "connected".to_owned();
                        *runtime.realtime_session_id.write().await = message
                            .pointer("/params/realtimeSessionId")
                            .and_then(Value::as_str)
                            .map(str::to_owned);
                        transition_voice_state(&event_app, VoiceEvent::VoiceConnected).await;
                    }
                    Some("thread/realtime/error") => {
                        runtime.voice_active.store(false, Ordering::SeqCst);
                        *runtime.voice_phase.write().await = "error".to_owned();
                        let voice = event_app
                            .state::<AppState>()
                            .voice_status
                            .read()
                            .await
                            .clone();
                        if is_reconnect_allowed(voice.state) && voice.reconnect_attempts < 3 {
                            transition_voice_state(&event_app, VoiceEvent::ReconnectRequested)
                                .await;
                        } else {
                            transition_voice_state(&event_app, VoiceEvent::RealtimeError).await;
                        }
                    }
                    Some("thread/realtime/closed") => {
                        runtime.voice_active.store(false, Ordering::SeqCst);
                        *runtime.voice_phase.write().await = "closed".to_owned();
                        *runtime.realtime_session_id.write().await = None;
                        transition_voice_state(&event_app, VoiceEvent::VoiceStopped).await;
                    }
                    _ => {}
                }
            }
            let _ = event_app.emit("codex-event", message);
        }
        if let Some(runtime) = weak.upgrade() {
            observe_runtime_death(event_app, runtime, RuntimeEvent::StdoutEof, None).await;
        }
    });

    let diagnostic_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.contains("ERROR") {
                let _ = diagnostic_app.emit("codex-diagnostic", line);
            }
        }
    });

    let weak = Arc::downgrade(runtime);
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(200)).await;
            let Some(runtime) = weak.upgrade() else {
                break;
            };
            if runtime.terminal_observed.load(Ordering::SeqCst) {
                break;
            }
            match runtime.control.try_wait() {
                Ok(Some(code)) => {
                    observe_runtime_death(
                        app.clone(),
                        runtime,
                        RuntimeEvent::ChildExited { code: Some(code) },
                        Some(code),
                    )
                    .await;
                    break;
                }
                Ok(None) => {}
                Err(error) => {
                    observe_runtime_death(
                        app.clone(),
                        runtime,
                        RuntimeEvent::ChildExited { code: None },
                        None,
                    )
                    .await;
                    let _ = app.emit("codex-diagnostic", error);
                    break;
                }
            }
        }
    });
}

async fn observe_runtime_death(
    app: AppHandle,
    runtime: Arc<CodexRuntime>,
    event: RuntimeEvent,
    exit_code: Option<i32>,
) {
    if runtime.terminal_observed.swap(true, Ordering::SeqCst) {
        return;
    }
    let state = app.state::<AppState>();
    let current = RuntimeGeneration(state.runtime_generation.load(Ordering::SeqCst));
    if runtime.generation != current {
        return;
    }
    runtime.fail_pending("runtime_exited").await;
    runtime.reset_voice_state().await;
    let _ = runtime.control.start_kill();
    {
        let mut active = state.runtime.lock().await;
        if active
            .as_ref()
            .is_some_and(|candidate| Arc::ptr_eq(candidate, &runtime))
        {
            active.take();
        }
    }
    let info = transition_runtime_state(
        &app,
        event,
        RuntimeTransitionDetails {
            pid: runtime.control.pid(),
            exit_code,
            error_code: Some("runtime_exited".to_owned()),
            error_message: Some("Codex app-server 已退出".to_owned()),
        },
    )
    .await;
    if should_watcher_restart(runtime.generation, current, info.state) {
        schedule_runtime_restart(app, runtime.generation).await;
    }
}

fn schedule_runtime_restart(
    app: AppHandle,
    generation: RuntimeGeneration,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
    Box::pin(async move {
        let state = app.state::<AppState>();
        let attempt = state.runtime_status.read().await.restart_attempts + 1;
        let Some(delay) = restart_backoff(attempt) else {
            transition_runtime_state(
                &app,
                RuntimeEvent::RestartExhausted,
                RuntimeTransitionDetails {
                    error_code: Some("runtime_failed".to_owned()),
                    error_message: Some("Codex app-server 自动重启次数已用尽".to_owned()),
                    ..Default::default()
                },
            )
            .await;
            return;
        };
        state.runtime_status.write().await.restart_attempts = attempt;
        transition_runtime_state(
            &app,
            RuntimeEvent::RestartScheduled,
            RuntimeTransitionDetails::default(),
        )
        .await;
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            let state = app.state::<AppState>();
            let current = RuntimeGeneration(state.runtime_generation.load(Ordering::SeqCst));
            let status = state.runtime_status.read().await.clone();
            if generation != current || status.state != RuntimeState::Restarting {
                return;
            }
            let Some(config) = state.desired_runtime.lock().await.clone() else {
                return;
            };
            let next =
                RuntimeGeneration(state.runtime_generation.fetch_add(1, Ordering::SeqCst) + 1);
            if launch_runtime(app.clone(), config, next, attempt)
                .await
                .is_err()
            {
                let status = state.runtime_status.read().await.state;
                if status == RuntimeState::Dead {
                    schedule_runtime_restart(app, next).await;
                }
            }
        });
    })
}

fn raise_jarvis_window(app: &AppHandle) {
    let app_handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        {
            use objc2::MainThreadMarker;
            use objc2_app_kit::NSApplication;

            if let Some(mtm) = MainThreadMarker::new() {
                let application = NSApplication::sharedApplication(mtm);
                #[allow(deprecated)]
                application.activateIgnoringOtherApps(true);
            }
        }

        if let Some(window) = app_handle.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            // A short floating interval lets macOS finish switching the
            // active application before the window returns to normal level.
            let _ = window.set_always_on_top(true);
            let _ = window.set_focus();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(700)).await;
                let _ = window.set_always_on_top(false);
            });
        }
    });
}

impl CodexRuntime {
    async fn spawn(
        permission_mode: PermissionMode,
        speech_style: SpeechStyle,
        workspace: WorkspaceId,
        codex_binary: PathBuf,
        generation: RuntimeGeneration,
        spawner: Arc<dyn ProcessSpawner>,
    ) -> Result<(Arc<Self>, RuntimeIo), String> {
        #[cfg(target_os = "windows")]
        const CREATION_FLAGS: u32 = 0x0800_0000;
        #[cfg(not(target_os = "windows"))]
        const CREATION_FLAGS: u32 = 0;
        let process = spawner.spawn(ProcessSpec {
            binary: codex_binary.clone(),
            // Realtime is enabled only for this child; never mutate the user's
            // ~/.codex/config.toml while constructing the launch specification.
            args: ["app-server", "--enable", "realtime_conversation", "--stdio"]
                .into_iter()
                .map(Into::into)
                .collect(),
            env: Vec::new(),
            creation_flags: CREATION_FLAGS,
        })?;
        let control: Arc<dyn ProcessControl> = Arc::from(process.control);
        let runtime = Arc::new(Self {
            writer: Mutex::new(process.stdin),
            control,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            thread_id: RwLock::new(None),
            active_turn: RwLock::new(None),
            voice_active: AtomicBool::new(false),
            voice_phase: RwLock::new("standby".to_owned()),
            realtime_session_id: RwLock::new(None),
            permission_mode,
            speech_style,
            workspace,
            codex_binary,
            generation,
            terminal_observed: AtomicBool::new(false),
        });
        Ok((
            runtime,
            RuntimeIo {
                stdout: process.stdout,
                stderr: process.stderr,
            },
        ))
    }

    async fn write(&self, message: &Value) -> Result<(), String> {
        let mut payload = serde_json::to_vec(message).map_err(|error| error.to_string())?;
        payload.push(b'\n');
        let mut writer = self.writer.lock().await;
        writer
            .write_all(&payload)
            .await
            .map_err(|error| error.to_string())?;
        writer.flush().await.map_err(|error| error.to_string())
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        if self.terminal_observed.load(Ordering::SeqCst) {
            return Err(RequestRejection::RuntimeExited.code().to_owned());
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        if let Err(error) = self
            .write(&json!({"id": id, "method": method, "params": params}))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        timeout(Duration::from_secs(90), receiver)
            .await
            .map_err(|_| format!("{method} 响应超时"))?
            .map_err(|_| format!("{method} 响应通道关闭"))?
    }

    async fn fail_pending(&self, code: &'static str) {
        let senders = self
            .pending
            .lock()
            .await
            .drain()
            .map(|(_, sender)| sender)
            .collect::<Vec<_>>();
        for sender in senders {
            let _ = sender.send(Err(code.to_owned()));
        }
    }

    async fn reset_voice_state(&self) {
        self.voice_active.store(false, Ordering::SeqCst);
        *self.voice_phase.write().await = "disconnected".to_owned();
        *self.realtime_session_id.write().await = None;
        *self.active_turn.write().await = None;
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write(&json!({"method": method, "params": params}))
            .await
    }

    async fn thread(&self) -> Result<String, String> {
        self.thread_id
            .read()
            .await
            .clone()
            .ok_or("Jarvis 尚未连接 Codex 线程".to_owned())
    }
}

fn codex_binary_path(app: &AppHandle, selected: Option<&str>) -> Result<PathBuf, String> {
    if let Some(selected) = selected.filter(|value| !value.trim().is_empty()) {
        let path = PathBuf::from(selected.trim());
        if !codex_executable_usable(&path) {
            return Err(
                "The selected Codex executable does not exist or cannot be started".to_owned(),
            );
        }
        #[cfg(target_os = "windows")]
        if !path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
        {
            return Err("Select the native codex.exe file, not a .cmd or .bat wrapper".to_owned());
        }
        return path
            .canonicalize()
            .map_err(|error| format!("Cannot read the selected Codex executable: {error}"));
    }
    if let Ok(configured) = std::env::var("JARVIS_CODEX_BIN") {
        let path = PathBuf::from(configured);
        if codex_executable_usable(&path) {
            return Ok(path);
        }
        return Err("JARVIS_CODEX_BIN does not point to an executable file".to_owned());
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join(if cfg!(windows) { "codex.exe" } else { "codex" });
        if codex_executable_usable(&bundled) {
            return Ok(bundled);
        }
    }

    let executable_name = if cfg!(windows) { "codex.exe" } else { "codex" };
    let mut candidates = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .map(|directory| directory.join(executable_name))
        .collect::<Vec<_>>();

    #[cfg(target_os = "windows")]
    {
        if let Ok(app_data) = std::env::var("APPDATA") {
            candidates.push(
                PathBuf::from(app_data)
                    .join("npm")
                    .join("node_modules")
                    .join("@openai")
                    .join("codex")
                    .join("node_modules")
                    .join("@openai")
                    .join("codex-win32-x64")
                    .join("vendor")
                    .join("x86_64-pc-windows-msvc")
                    .join("bin")
                    .join("codex.exe"),
            );
        }
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            candidates.push(
                PathBuf::from(local_app_data)
                    .join("Microsoft")
                    .join("WindowsApps")
                    .join("codex.exe"),
            );
        }
    }

    #[cfg(target_os = "macos")]
    candidates.extend([
        PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex"),
        PathBuf::from("/Applications/Codex.app/Contents/Resources/codex"),
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
    ]);

    if let Ok(home) = std::env::var("HOME") {
        candidates.push(PathBuf::from(&home).join(".local/bin/codex"));
        candidates.push(PathBuf::from(home).join(".cargo/bin/codex"));
    }
    candidates
        .into_iter()
        .find(|path| codex_executable_usable(path))
        .ok_or_else(|| {
            "未找到可访问的 Codex 可执行文件；请安装 Codex，设置 JARVIS_CODEX_BIN，或在 Jarvis 设置中选择 codex.exe。".to_owned()
        })
}

fn codex_executable_usable(path: &std::path::Path) -> bool {
    if !path.is_file() || fs::File::open(path).is_err() {
        return false;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new(path)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .is_ok_and(|status| status.success())
    }
    #[cfg(not(target_os = "windows"))]
    true
}

#[cfg(target_os = "windows")]
fn apply_windows_proxy(command: &mut Command) {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};

    let needs_http = std::env::var_os("HTTP_PROXY").is_none();
    let needs_https = std::env::var_os("HTTPS_PROXY").is_none();
    if !needs_http && !needs_https {
        return;
    }
    let Ok(settings) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
    else {
        return;
    };
    let enabled = settings.get_value::<u32, _>("ProxyEnable").unwrap_or(0);
    let Ok(raw) = settings.get_value::<String, _>("ProxyServer") else {
        return;
    };
    if enabled == 0 || raw.trim().is_empty() {
        return;
    }

    let mut http = None;
    let mut https = None;
    if raw.contains('=') {
        for entry in raw.split(';') {
            if let Some((scheme, address)) = entry.split_once('=') {
                match scheme.trim().to_ascii_lowercase().as_str() {
                    "http" => http = windows_proxy_url(address),
                    "https" => https = windows_proxy_url(address),
                    _ => {}
                }
            }
        }
    } else {
        http = windows_proxy_url(&raw);
        https = http.clone();
    }
    if needs_http {
        if let Some(value) = http.as_ref().or(https.as_ref()) {
            command.env("HTTP_PROXY", value);
        }
    }
    if needs_https {
        if let Some(value) = https.as_ref().or(http.as_ref()) {
            command.env("HTTPS_PROXY", value);
        }
    }
}

#[cfg(target_os = "windows")]
fn windows_proxy_url(address: &str) -> Option<String> {
    let address = address.trim();
    if address.is_empty() {
        None
    } else if address.contains("://") {
        Some(address.to_owned())
    } else {
        Some(format!("http://{address}"))
    }
}

async fn runtime(state: &State<'_, AppState>) -> Result<Arc<CodexRuntime>, String> {
    let status = state.runtime_status.read().await.state;
    if let Some(rejection) = request_rejection(status) {
        return Err(rejection.code().to_owned());
    }
    state
        .runtime
        .lock()
        .await
        .clone()
        .ok_or("Jarvis runtime 尚未启动".to_owned())
}

async fn direct_voice_info(state: &State<'_, AppState>) -> DirectVoiceInfo {
    let codex_connected = state.runtime_status.read().await.state == RuntimeState::Ready;
    let runtime = state.runtime.lock().await.clone();
    let Some(runtime) = runtime else {
        return DirectVoiceInfo {
            codex_connected: false,
            voice_active: false,
            phase: "standby".to_owned(),
            protocol: "Codex app-server V3 · WebRTC",
            thread_id: None,
            realtime_session_id: None,
        };
    };
    let phase = runtime.voice_phase.read().await.clone();
    let thread_id = runtime.thread_id.read().await.clone();
    let realtime_session_id = runtime.realtime_session_id.read().await.clone();
    DirectVoiceInfo {
        codex_connected,
        voice_active: runtime.voice_active.load(Ordering::SeqCst),
        phase,
        protocol: "Codex app-server V3 · WebRTC",
        thread_id,
        realtime_session_id,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticItem {
    key: &'static str,
    verdict: Verdict,
}

const MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;

#[cfg(target_os = "windows")]
fn probe_webview2() -> ProbeResult {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
    let Ok(clients) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(
        r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
    ) else {
        return ProbeResult::WebView2Missing;
    };
    match clients.get_value::<String, _>("pv") {
        Ok(version) if !version.trim().is_empty() => ProbeResult::Ok,
        _ => ProbeResult::WebView2Missing,
    }
}

#[cfg(not(target_os = "windows"))]
fn probe_webview2() -> ProbeResult {
    ProbeResult::Ok
}

#[cfg(target_os = "windows")]
fn probe_microphone() -> ProbeResult {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(
        r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone",
    ) else {
        return ProbeResult::Ok;
    };
    match key.get_value::<String, _>("Value") {
        Ok(value) if value.eq_ignore_ascii_case("Deny") => ProbeResult::MicDenied,
        _ => ProbeResult::Ok,
    }
}

#[cfg(not(target_os = "windows"))]
fn probe_microphone() -> ProbeResult {
    ProbeResult::Ok
}

async fn probe_speech_pack(app: &AppHandle) -> ProbeResult {
    #[cfg(target_os = "windows")]
    {
        let Ok(helper) = wake_helper_path(app) else {
            return ProbeResult::Ok;
        };
        let Ok(mut child) = Command::new(helper)
            .arg("--probe-recognizer")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            return ProbeResult::Ok;
        };
        match tokio::time::timeout(Duration::from_secs(10), child.wait()).await {
            Ok(Ok(status)) if status.code() == Some(3) => ProbeResult::SpeechPackMissing,
            _ => ProbeResult::Ok,
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        ProbeResult::Ok
    }
}

async fn probe_codex(app: &AppHandle, state: &AppState) -> ProbeResult {
    if codex_binary_path(app, None).is_err() {
        return ProbeResult::CodexMissing;
    }
    let last_error = state
        .runtime_status
        .read()
        .await
        .last_error
        .clone()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if ["401", "unauthorized", "not logged in", "登录已失效"]
        .iter()
        .any(|fragment| last_error.contains(fragment))
    {
        return ProbeResult::CodexNotLoggedIn;
    }
    ProbeResult::Ok
}

async fn probe_workspace(state: &AppState) -> ProbeResult {
    let Some(config) = state.desired_runtime.lock().await.clone() else {
        return ProbeResult::Ok;
    };
    match canonicalize_workspace(
        config.workspace.as_str(),
        current_platform(),
        &SystemPathProbe,
    ) {
        Ok(_) => ProbeResult::Ok,
        Err(_) => ProbeResult::WorkspaceUnreadable,
    }
}

fn current_proxy_address() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        let Ok(settings) = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        else {
            return None;
        };
        let enabled = settings.get_value::<u32, _>("ProxyEnable").unwrap_or(0);
        let Ok(raw) = settings.get_value::<String, _>("ProxyServer") else {
            return None;
        };
        if enabled == 0 || raw.trim().is_empty() {
            return None;
        }
        let address = if raw.contains('=') {
            raw.split(';')
                .find_map(|entry| entry.split_once('='))
                .filter(|(scheme, _)| matches!(*scheme, "http" | "https"))
                .map(|(_, address)| address)
                .unwrap_or(&raw)
        } else {
            &raw
        };
        let address = address.trim();
        Some(if address.contains("://") {
            address.to_owned()
        } else {
            format!("http://{address}")
        })
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HTTPS_PROXY")
            .ok()
            .or_else(|| std::env::var("HTTP_PROXY").ok())
    }
}

fn parse_host_port(target: &str) -> Option<(String, u16)> {
    let rest = target.split("://").nth(1).unwrap_or(target);
    let rest = rest.split('/').next().unwrap_or(rest);
    if let Some((host, port)) = rest.rsplit_once(':') {
        let port = port.parse().ok()?;
        return Some((host.to_owned(), port));
    }
    let default_port = if target.starts_with("https") { 443 } else { 80 };
    Some((rest.to_owned(), default_port))
}

async fn probe_network() -> ProbeResult {
    let proxy = current_proxy_address();
    let target = proxy
        .clone()
        .unwrap_or_else(|| "https://api.openai.com".to_owned());
    let Some((host, port)) = parse_host_port(&target) else {
        return ProbeResult::Ok;
    };
    let result = tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        let address = (host.as_str(), port)
            .to_socket_addrs()?
            .next()
            .ok_or_else(|| std::io::Error::other("no address"))?;
        std::net::TcpStream::connect_timeout(&address, Duration::from_secs(3))
    })
    .await;
    match result {
        Ok(Ok(_)) => ProbeResult::Ok,
        Ok(Err(_)) if proxy.is_some() => ProbeResult::ProxyUnreachable,
        Ok(Err(_)) => ProbeResult::NetworkTimeout,
        Err(_) => ProbeResult::Ok,
    }
}

async fn collect_diagnostics(app: &AppHandle, state: &AppState) -> Vec<DiagnosticItem> {
    vec![
        DiagnosticItem {
            key: "windows",
            verdict: classify(ProbeResult::Ok),
        },
        DiagnosticItem {
            key: "webview2",
            verdict: classify(probe_webview2()),
        },
        DiagnosticItem {
            key: "microphone",
            verdict: classify(probe_microphone()),
        },
        DiagnosticItem {
            key: "speech_pack",
            verdict: classify(probe_speech_pack(app).await),
        },
        DiagnosticItem {
            key: "codex",
            verdict: classify(probe_codex(app, state).await),
        },
        DiagnosticItem {
            key: "workspace",
            verdict: classify(probe_workspace(state).await),
        },
        DiagnosticItem {
            key: "network",
            verdict: classify(probe_network().await),
        },
    ]
}

fn apply_log_rotation(app: &AppHandle) {
    let Ok(directory) = app.path().app_log_dir() else {
        return;
    };
    let Ok(entries) = fs::read_dir(&directory) else {
        return;
    };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_owned)
        else {
            continue;
        };
        if !name.starts_with("jarvis-runtime") || !name.ends_with(".jsonl") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or(0);
        files.push(LogFileInfo {
            name,
            size_bytes: metadata.len(),
            modified_ms,
        });
    }
    let main_name = "jarvis-runtime.jsonl";
    if let Some(main) = files.iter().find(|file| file.name == main_name) {
        if main.size_bytes > MAX_LOG_BYTES {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            let archived = format!("jarvis-runtime-{timestamp}.jsonl");
            let _ = fs::rename(directory.join(main_name), directory.join(&archived));
            files.push(LogFileInfo {
                name: archived,
                size_bytes: main.size_bytes,
                modified_ms: timestamp as u64,
            });
            files.retain(|file| file.name != main_name);
        }
    }
    let plan = rotate_plan(files, MAX_LOG_BYTES);
    for name in plan.delete {
        let _ = fs::remove_file(directory.join(name));
    }
}

#[tauri::command]
async fn run_diagnostics(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<DiagnosticItem>, String> {
    apply_log_rotation(&app);
    Ok(collect_diagnostics(&app, &state).await)
}

#[tauri::command]
async fn copy_diagnostics(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    apply_log_rotation(&app);
    let items = collect_diagnostics(&app, &state).await;
    let mut lines = Vec::new();
    lines.push("Jarvis 一键诊断（已脱敏）".to_owned());
    for item in items {
        lines.push(format!(
            "[{:?}] {}（{}）：{}",
            item.verdict.level,
            item.verdict.message_zh,
            item.verdict.code,
            item.verdict.suggested_action_zh
        ));
    }
    if let Ok(directory) = app.path().app_log_dir() {
        if let Ok(content) = fs::read_to_string(directory.join("jarvis-runtime.jsonl")) {
            let tail: Vec<&str> = content.lines().rev().take(20).collect();
            if !tail.is_empty() {
                lines.push("--- 最近日志（已脱敏）---".to_owned());
                lines.push(tail.into_iter().rev().collect::<Vec<_>>().join("\n"));
            }
        }
    }
    Ok(redact(&lines.join("\n")))
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Ok(directory.join("settings.json"))
}

fn save_settings_file(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let bytes =
        serde_json::to_vec_pretty(settings).map_err(|error| format!("设置序列化失败：{error}"))?;
    let plan = write_plan(path.to_str().ok_or("设置路径无效")?, &bytes);
    fs::write(&plan.temp_path, &bytes).map_err(|error| format!("写入设置临时文件失败：{error}"))?;
    let _ = fs::remove_file(&plan.backup_path);
    let _ = fs::rename(&plan.final_path, &plan.backup_path);
    fs::rename(&plan.temp_path, &plan.final_path)
        .map_err(|error| format!("原子替换设置文件失败：{error}"))
}

fn load_settings(app: &AppHandle) -> Settings {
    let Ok(path) = settings_path(app) else {
        return Settings::default();
    };
    let read = |candidate: &PathBuf| fs::read_to_string(candidate).ok();
    if let Some(content) = read(&path) {
        if let Ok(settings) = migrate(&content, 0) {
            return settings;
        }
        // 主文件损坏：回退备份。
        let backup = path.with_extension("json.bak");
        if let Some(content) = read(&backup) {
            if let Ok(settings) = migrate(&content, 0) {
                return settings;
            }
        }
        return Settings::default();
    }
    let backup = path.with_extension("json.bak");
    if let Some(content) = read(&backup) {
        if let Ok(settings) = migrate(&content, 0) {
            return settings;
        }
    }
    Settings::default()
}

/// 启动时加载并迁移；迁移或备份回退后立即原子回写。返回是否启用自启动。
fn initialize_settings(app: &AppHandle) -> bool {
    let settings = load_settings(app);
    let _ = save_settings_file(app, &settings);
    settings.autostart
}

fn settings_dto(app: &AppHandle) -> SettingsDto {
    let settings = load_settings(app);
    let home = home_workspace_id().ok();
    let workspace = settings
        .workspace
        .as_deref()
        .and_then(|value| validated_workspace(value).ok())
        .map(|resolved| resolved.id);
    let permission_mode = match &home {
        Some(home) => resolve_stored_permission(
            &settings.permission_mode,
            workspace.as_ref(),
            home,
            current_platform(),
        ),
        None => "safe".to_owned(),
    };
    let thread_id = workspace
        .as_ref()
        .and_then(|workspace| {
            settings
                .threads
                .iter()
                .find(|mapping| mapping.workspace == workspace.as_str())
        })
        .map(|mapping| mapping.thread_id.clone());
    SettingsDto {
        present: true,
        workspace: workspace.map(|workspace| workspace.as_str().to_owned()),
        thread_id,
        permission_mode,
        speech_style: settings.speech_style,
        codex_binary: settings.codex_binary,
        autostart: settings.autostart,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsDto {
    present: bool,
    workspace: Option<String>,
    thread_id: Option<String>,
    permission_mode: String,
    speech_style: String,
    codex_binary: Option<String>,
    autostart: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveSettingsRequest {
    workspace: String,
    thread_id: Option<String>,
    permission_mode: String,
    speech_style: String,
    codex_path: Option<String>,
    autostart: Option<bool>,
}

#[tauri::command]
async fn get_settings(app: AppHandle) -> Result<SettingsDto, String> {
    Ok(settings_dto(&app))
}

#[tauri::command]
async fn save_settings(
    app: AppHandle,
    request: SaveSettingsRequest,
) -> Result<SettingsDto, String> {
    use tauri_plugin_autostart::ManagerExt;
    let workspace = validated_workspace(&request.workspace)?;
    let mut settings = load_settings(&app);
    settings.workspace = Some(workspace.id.as_str().to_owned());
    if let Some(thread_id) = request
        .thread_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        upsert_thread(&mut settings.threads, workspace.id.as_str(), thread_id);
    }
    settings.permission_mode = request.permission_mode;
    settings.speech_style = request.speech_style;
    settings.codex_binary = request.codex_path.filter(|value| !value.is_empty());
    if let Some(autostart) = request.autostart {
        settings.autostart = autostart;
    }
    save_settings_file(&app, &settings)?;
    let state = app.state::<AppState>();
    if let Some(autostart) = request.autostart {
        let autolaunch = app.autolaunch();
        if autostart {
            let _ = autolaunch.enable();
        } else {
            let _ = autolaunch.disable();
        }
    }
    let _ = &state;
    Ok(settings_dto(&app))
}

#[tauri::command]
async fn import_legacy_settings(app: AppHandle, snapshot: Value) -> Result<SettingsDto, String> {
    let mut settings = load_settings(&app);
    let imported = import_legacy(&snapshot, current_platform(), &SystemPathProbe);
    if let Some(workspace) = imported.workspace {
        settings.workspace = Some(workspace.clone());
    }
    for mapping in imported.threads {
        upsert_thread(
            &mut settings.threads,
            &mapping.workspace,
            &mapping.thread_id,
        );
    }
    if snapshot.get("jarvis.permissionMode").is_some() {
        settings.permission_mode = imported.permission_mode;
    }
    if snapshot.get("jarvis.speechStyle").is_some() {
        settings.speech_style = imported.speech_style;
    }
    if snapshot.get("jarvis.codexBinary").is_some() {
        settings.codex_binary = imported.codex_binary;
    }
    save_settings_file(&app, &settings)?;
    Ok(settings_dto(&app))
}

#[tauri::command]
async fn direct_voice_status(state: State<'_, AppState>) -> Result<DirectVoiceInfo, String> {
    Ok(direct_voice_info(&state).await)
}

fn wake_helper_path(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "macos")]
    let relative = PathBuf::from("wake-helper/JarvisWakeListener.app");
    #[cfg(target_os = "windows")]
    let relative = PathBuf::from("wake-helper/JarvisWakeListener.exe");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    return Err("Wake recognition is currently supported on macOS and Windows".to_owned());

    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join(&relative);
        if bundled.exists() {
            return Ok(bundled);
        }
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(relative);
    if development.exists() {
        return Ok(development);
    }
    Err("Jarvis 唤醒监听器未找到".to_owned())
}

#[cfg(target_os = "macos")]
fn host_app_bundle_path(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let contents_dir = resource_dir.parent()?;
    let bundle = contents_dir.parent()?;
    (bundle.extension().and_then(|value| value.to_str()) == Some("app"))
        .then(|| bundle.to_path_buf())
}

async fn wake_status_value(state: &AppState) -> WakeStatus {
    WakeStatus {
        enabled: state.wake_enabled.load(Ordering::SeqCst),
        ready: state.wake_ready.load(Ordering::SeqCst),
        authorization: state.wake_authorization.read().await.clone(),
    }
}

fn start_wake_supervisor(app: AppHandle) {
    let state = app.state::<AppState>();
    if state.wake_supervisor_running.swap(true, Ordering::SeqCst) {
        return;
    }
    state.wake_enabled.store(true, Ordering::SeqCst);
    state.wake_release_requested.store(false, Ordering::SeqCst);

    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let helper = match wake_helper_path(&app) {
            Ok(path) => path,
            Err(error) => {
                *state.wake_authorization.write().await = error.clone();
                state.wake_enabled.store(false, Ordering::SeqCst);
                state.wake_supervisor_running.store(false, Ordering::SeqCst);
                let _ = app.emit("jarvis-wake-status", wake_status_value(&state).await);
                return;
            }
        };
        #[cfg(target_os = "macos")]
        {
            // A previous host may have exited while its LaunchServices helper
            // remained alive. Keep exactly one microphone listener.
            let _ = Command::new("/usr/bin/pkill")
                .args(["-x", "JarvisWakeListener"])
                .status()
                .await;
        }

        let mut woke = false;
        while state.wake_enabled.load(Ordering::SeqCst) {
            state.wake_ready.store(false, Ordering::SeqCst);
            let event_file =
                std::env::temp_dir().join(format!("jarvis-wake-{}.jsonl", std::process::id()));
            let control_file =
                std::env::temp_dir().join(format!("jarvis-wake-{}.ctl", std::process::id()));
            *state.wake_control_file.lock().await = Some(control_file.clone());
            state.wake_release_requested.store(false, Ordering::SeqCst);
            let _ = fs::remove_file(&event_file);
            let _ = fs::remove_file(&control_file);
            if let Err(error) = fs::write(&event_file, "") {
                *state.wake_authorization.write().await = format!("无法创建唤醒事件通道：{error}");
                break;
            }
            if !state.wake_enabled.load(Ordering::SeqCst) {
                let _ = fs::remove_file(&event_file);
                break;
            }

            #[cfg(target_os = "macos")]
            let mut command = {
                // LaunchServices is required so macOS attributes microphone and
                // speech-recognition permissions to the helper app bundle.
                let mut command = Command::new("/usr/bin/open");
                command
                    .args(["-n", "-W"])
                    .arg(&helper)
                    .args(["--args", "--event-file"])
                    .arg(&event_file);
                if let Some(host_app) = host_app_bundle_path(&app) {
                    command.arg("--host-app").arg(host_app);
                }
                command
            };

            #[cfg(target_os = "windows")]
            let mut command = {
                let mut command = Command::new(&helper);
                command.arg("--event-file").arg(&event_file);
                command.arg("--control-file").arg(&control_file);
                command
            };
            let mut child = match command
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
            {
                Ok(child) => child,
                Err(error) => {
                    *state.wake_authorization.write().await =
                        format!("无法启动唤醒监听器：{error}");
                    break;
                }
            };
            state
                .wake_pid
                .store(child.id().unwrap_or(0), Ordering::SeqCst);
            let mut processed = 0usize;
            let mut mic_released = false;
            let spawned_at = std::time::Instant::now();
            let mut release_requested_at: Option<std::time::Instant> = None;

            loop {
                let content = fs::read_to_string(&event_file).unwrap_or_default();
                let lines: Vec<&str> = content.lines().collect();
                for line in lines.iter().skip(processed) {
                    let Ok(message) = serde_json::from_str::<Value>(line) else {
                        log_wake_protocol_event(&app, "wake.protocol.invalid_json");
                        continue;
                    };
                    match message.get("type").and_then(Value::as_str) {
                        Some("authorization") => {
                            let authorization = message
                                .get("status")
                                .and_then(Value::as_str)
                                .unwrap_or("unknown");
                            *state.wake_authorization.write().await = authorization.to_owned();
                            // `notDetermined` means the helper has just asked
                            // macOS for access. Keep it alive so the native
                            // permission sheet can complete its callback.
                            if matches!(authorization, "denied" | "restricted") {
                                state.wake_enabled.store(false, Ordering::SeqCst);
                            }
                        }
                        Some("ready") => {
                            state.wake_ready.store(true, Ordering::SeqCst);
                            transition_voice_state(&app, VoiceEvent::WakeArmed).await;
                        }
                        Some("wake") => {
                            woke = true;
                            state.wake_enabled.store(false, Ordering::SeqCst);
                            state.wake_ready.store(false, Ordering::SeqCst);
                            raise_jarvis_window(&app);
                            // 按钮、快捷键与 sidecar 命中共用同一入口。
                            handle_voice_event(app.clone(), VoiceEvent::WakeDetected).await;
                        }
                        Some("stopping") => {
                            log_wake_protocol_event(&app, "wake.protocol.stopping");
                        }
                        Some("microphoneReleased") => {
                            mic_released = true;
                            log_wake_protocol_event(&app, "wake.protocol.microphone_released");
                        }
                        Some("error") => {
                            *state.wake_authorization.write().await = message
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("wake listener error")
                                .to_owned();
                            state.wake_enabled.store(false, Ordering::SeqCst);
                            state.wake_ready.store(false, Ordering::SeqCst);
                            transition_voice_state(&app, VoiceEvent::WakeError).await;
                        }
                        _ => {
                            log_wake_protocol_event(&app, "wake.protocol.unknown_type");
                            continue;
                        }
                    }
                    let _ = app.emit("jarvis-wake-status", wake_status_value(&state).await);
                    if woke {
                        break;
                    }
                }
                processed = lines.len();
                if woke || !state.wake_enabled.load(Ordering::SeqCst) {
                    break;
                }
                if child.try_wait().ok().flatten().is_some() {
                    break;
                }
                let release_requested = state.wake_release_requested.load(Ordering::SeqCst);
                if release_requested && release_requested_at.is_none() {
                    release_requested_at = Some(std::time::Instant::now());
                    let _ = fs::write(&control_file, "release");
                }
                if let Some(requested_at) = release_requested_at {
                    if requested_at.elapsed() >= Duration::from_secs(3) {
                        // 兜底：释放请求超时，只产错误，不推进正常交接。
                        transition_voice_state(
                            &app,
                            VoiceEvent::Timeout {
                                stage: TimeoutStage::MicrophoneRelease,
                            },
                        )
                        .await;
                        state.wake_enabled.store(false, Ordering::SeqCst);
                        break;
                    }
                }
                if !release_requested
                    && !state.wake_ready.load(Ordering::SeqCst)
                    && spawned_at.elapsed() >= Duration::from_secs(10)
                {
                    transition_voice_state(
                        &app,
                        VoiceEvent::Timeout {
                            stage: TimeoutStage::WakeArm,
                        },
                    )
                    .await;
                    state.wake_enabled.store(false, Ordering::SeqCst);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }

            if woke || !state.wake_enabled.load(Ordering::SeqCst) {
                #[cfg(target_os = "macos")]
                {
                    let _ = Command::new("/usr/bin/pkill")
                        .args(["-x", "JarvisWakeListener"])
                        .status()
                        .await;
                }
                #[cfg(target_os = "windows")]
                if child.try_wait().ok().flatten().is_none() {
                    // Only terminate the exact helper process owned by this
                    // supervisor. Never kill by image name on Windows.
                    let _ = child.kill().await;
                }
            }
            let _ = child.wait().await;
            let _ = fs::remove_file(&event_file);
            let _ = fs::remove_file(&control_file);
            *state.wake_control_file.lock().await = None;
            state.wake_pid.store(0, Ordering::SeqCst);
            let release_was_requested = woke
                || state.wake_release_requested.load(Ordering::SeqCst)
                || release_requested_at.is_some();
            state.wake_release_requested.store(false, Ordering::SeqCst);

            // 交接确认：sidecar 已退出且麦克风释放确认齐备后，才允许 Voice 获取。
            #[cfg(not(target_os = "windows"))]
            let mic_released = mic_released || woke;
            let releasing =
                state.voice_status.read().await.state == VoiceState::WakeReleasingMicrophone;
            if releasing && mic_released {
                transition_voice_state(&app, VoiceEvent::MicrophoneReleased).await;
                state.wake_enabled.store(false, Ordering::SeqCst);
            } else if releasing && release_was_requested {
                // 已请求释放但未收到确认，只产错误、不推进正常交接。
                transition_voice_state(
                    &app,
                    VoiceEvent::Timeout {
                        stage: TimeoutStage::MicrophoneRelease,
                    },
                )
                .await;
                state.wake_enabled.store(false, Ordering::SeqCst);
            }
            if !state.wake_enabled.load(Ordering::SeqCst)
                || !matches!(
                    state.voice_status.read().await.state,
                    VoiceState::WakeArming | VoiceState::WakeReady
                )
            {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }

        state.wake_ready.store(false, Ordering::SeqCst);
        state.wake_supervisor_running.store(false, Ordering::SeqCst);
        if woke {
            // The WebView owns the RTCPeerConnection, so wake only raises the
            // Jarvis surface; the voice handshake begins when the backend emits
            // jarvis-voice-may-acquire-microphone. No keypress or UI automation.
            let _ = app.emit("jarvis-wake", json!({"ok": true}));
        }
        let _ = app.emit("jarvis-wake-status", wake_status_value(&state).await);
    });
}
#[tauri::command]
async fn arm_wake_listener(app: AppHandle) -> Result<WakeStatus, String> {
    // 新会话：终态（Stopping/Degraded）由集成层重置，再从 Booting 进入布防。
    reset_voice_machine(&app).await;
    let state = app.state::<AppState>();
    if state.voice_status.read().await.state == VoiceState::Booting {
        transition_voice_state(&app, VoiceEvent::BootCompleted).await;
    }
    start_wake_supervisor(app.clone());
    tokio::time::sleep(Duration::from_millis(80)).await;
    Ok(wake_status_value(&state).await)
}

#[tauri::command]
async fn disarm_wake_listener(app: AppHandle) -> Result<WakeStatus, String> {
    let state = app.state::<AppState>();
    state.wake_enabled.store(false, Ordering::SeqCst);
    state.wake_ready.store(false, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    {
        let pid = state.wake_pid.swap(0, Ordering::SeqCst);
        if pid > 0 {
            let _ = Command::new("/bin/kill")
                .arg(pid.to_string())
                .status()
                .await;
        }
    }
    // The supervisor starts asynchronously and can cross this command in
    // flight. Keep terminating until it has observed wake_enabled=false.
    for _ in 0..15 {
        #[cfg(target_os = "macos")]
        {
            let _ = Command::new("/usr/bin/pkill")
                .args(["-x", "JarvisWakeListener"])
                .status()
                .await;
        }
        if !state.wake_supervisor_running.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // AVAudioEngine releases the input device asynchronously after SIGTERM.
    // Starting WebRTC in the same tick can otherwise fail with NotAllowedError.
    tokio::time::sleep(Duration::from_millis(350)).await;
    Ok(wake_status_value(&state).await)
}

#[tauri::command]
async fn wake_listener_status(app: AppHandle) -> WakeStatus {
    wake_status_value(&app.state::<AppState>()).await
}

#[tauri::command]
async fn consume_cold_wake(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    if !state.cold_wake_pending.swap(false, Ordering::SeqCst) {
        return Ok(false);
    }
    // Replay a cold launch through the same external event path as a normal
    // warm wake, but only after the newly spawned listener fully releases mic.
    state.wake_enabled.store(false, Ordering::SeqCst);
    state.wake_ready.store(false, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    {
        let pid = state.wake_pid.swap(0, Ordering::SeqCst);
        if pid > 0 {
            let _ = Command::new("/bin/kill")
                .arg(pid.to_string())
                .status()
                .await;
        }
    }
    for _ in 0..15 {
        #[cfg(target_os = "macos")]
        {
            let _ = Command::new("/usr/bin/pkill")
                .args(["-x", "JarvisWakeListener"])
                .status()
                .await;
        }
        if !state.wake_supervisor_running.load(Ordering::SeqCst) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    tokio::time::sleep(Duration::from_millis(350)).await;
    raise_jarvis_window(&app);
    let _ = app.emit("jarvis-wake", json!({"ok": true, "cold": true}));
    Ok(true)
}

fn resolve_workspace_info(input: &str) -> Result<(ResolvedWorkspace, WorkspaceInfo), String> {
    workspace_info(input, current_platform(), &SystemPathProbe)
        .map_err(|error| workspace_error_message(error).to_owned())
}

#[tauri::command]
fn default_workspace() -> Result<WorkspaceInfo, String> {
    if let Ok(configured) = std::env::var("JARVIS_WORKSPACE") {
        if !configured.trim().is_empty() {
            return resolve_workspace_info(&configured)
                .map(|(_, info)| info)
                .map_err(|error| format!("无法读取 JARVIS_WORKSPACE：{error}"));
        }
    }
    let home = user_home_path()?;
    let default = home.join("Jarvis");
    fs::create_dir_all(&default)
        .map_err(|error| format!("Unable to create the default Jarvis workspace: {error}"))?;
    resolve_workspace_info(&default.to_string_lossy()).map(|(_, info)| info)
}

fn user_home_path() -> Result<PathBuf, String> {
    for variable in if cfg!(windows) {
        ["USERPROFILE", "HOME"]
    } else {
        ["HOME", "USERPROFILE"]
    } {
        if let Ok(home) = std::env::var(variable) {
            let path = PathBuf::from(home);
            if path.is_dir() {
                return Ok(path);
            }
        }
    }
    Err("Unable to determine the user profile directory".to_owned())
}

fn home_workspace_id() -> Result<WorkspaceId, String> {
    let home = user_home_path()?;
    resolve_workspace_info(&home.to_string_lossy()).map(|(resolved, _)| resolved.id)
}

fn validated_workspace(cwd: &str) -> Result<ResolvedWorkspace, String> {
    resolve_workspace_info(cwd).map(|(resolved, _)| resolved)
}

#[tauri::command]
fn validate_workspace(cwd: String) -> Result<WorkspaceInfo, String> {
    resolve_workspace_info(&cwd).map(|(_, info)| info)
}

#[tauri::command]
fn resolve_permission_mode(
    cwd: String,
    mode: PermissionMode,
    source: PermissionSource,
) -> Result<PermissionResolution, String> {
    let workspace = validated_workspace(&cwd)?;
    let home = home_workspace_id()?;
    match evaluate_permission_mode(mode, &workspace.id, &home, source, current_platform()) {
        PermissionDecision::Allow(mode) => Ok(PermissionResolution {
            mode,
            changed: false,
            reason: None,
        }),
        PermissionDecision::Downgraded { to, reason, .. } => Ok(PermissionResolution {
            mode: to,
            changed: true,
            reason: Some(reason),
        }),
        PermissionDecision::Reject { reason, .. } => {
            Err(permission_rejection_message(reason).to_owned())
        }
    }
}

async fn terminate_runtime(
    app: &AppHandle,
    state: &AppState,
    clear_desired: bool,
) -> Result<(), String> {
    state.runtime_generation.fetch_add(1, Ordering::SeqCst);
    if clear_desired {
        state.desired_runtime.lock().await.take();
    }
    if let Some(runtime) = state.runtime.lock().await.take() {
        runtime.terminal_observed.store(true, Ordering::SeqCst);
        runtime.fail_pending("runtime_absent").await;
        runtime.reset_voice_state().await;
        runtime.control.start_kill()?;
    }
    transition_runtime_state(
        app,
        RuntimeEvent::ShutdownRequested,
        RuntimeTransitionDetails::default(),
    )
    .await;
    Ok(())
}

async fn fail_runtime_startup(
    app: &AppHandle,
    state: &AppState,
    runtime: &Arc<CodexRuntime>,
    error: String,
) -> String {
    transition_runtime_state(
        app,
        RuntimeEvent::InitializeErr,
        RuntimeTransitionDetails {
            pid: runtime.control.pid(),
            error_code: Some("runtime_initialize_failed".to_owned()),
            error_message: Some(error.clone()),
            ..Default::default()
        },
    )
    .await;
    runtime.terminal_observed.store(true, Ordering::SeqCst);
    runtime.fail_pending("runtime_absent").await;
    runtime.reset_voice_state().await;
    let _ = runtime.control.start_kill();
    let mut active = state.runtime.lock().await;
    if active
        .as_ref()
        .is_some_and(|candidate| Arc::ptr_eq(candidate, runtime))
    {
        active.take();
    }
    error
}

async fn launch_runtime(
    app: AppHandle,
    config: RuntimeLaunchConfig,
    generation: RuntimeGeneration,
    restart_attempt: u32,
) -> Result<Arc<CodexRuntime>, String> {
    let state = app.state::<AppState>();
    {
        let mut status = state.runtime_status.write().await;
        status.runtime_id = Some(generation.0.to_string());
        status.restart_attempts = restart_attempt;
        status.last_exit_code = None;
        status.last_error_code = None;
        status.last_error = None;
    }
    let spawned = CodexRuntime::spawn(
        config.permission_mode,
        config.speech_style,
        config.workspace.clone(),
        config.codex_binary.clone(),
        generation,
        state.process_spawner.clone(),
    )
    .await;
    let (runtime, io) = match spawned {
        Ok(value) => value,
        Err(error) => {
            transition_runtime_state(
                &app,
                RuntimeEvent::SpawnErr,
                RuntimeTransitionDetails {
                    error_code: Some("runtime_spawn_failed".to_owned()),
                    error_message: Some(error.clone()),
                    ..Default::default()
                },
            )
            .await;
            return Err(error);
        }
    };
    *state.runtime.lock().await = Some(runtime.clone());
    transition_runtime_state(
        &app,
        RuntimeEvent::SpawnOk,
        RuntimeTransitionDetails {
            pid: runtime.control.pid(),
            ..Default::default()
        },
    )
    .await;
    start_runtime_watchers(app.clone(), &runtime, io);

    let initialized = runtime
        .request(
            "initialize",
            json!({
                "clientInfo": {"name": "jarvis-codex", "title": "Jarvis Codex", "version": env!("CARGO_PKG_VERSION")},
                "capabilities": {"experimentalApi": true}
            }),
        )
        .await;
    if let Err(error) = initialized {
        return Err(fail_runtime_startup(&app, &state, &runtime, error).await);
    }
    if let Err(error) = runtime.notify("initialized", json!({})).await {
        return Err(fail_runtime_startup(&app, &state, &runtime, error).await);
    }
    transition_runtime_state(
        &app,
        RuntimeEvent::InitializeOk,
        RuntimeTransitionDetails {
            pid: runtime.control.pid(),
            ..Default::default()
        },
    )
    .await;

    let profile = config.permission_mode.profile();
    let thread_options = json!({
        "cwd": config.workspace.as_str(),
        "approvalPolicy": profile.approval_policy,
        "sandbox": profile.sandbox,
        "baseInstructions": format!(
            "You are Codex speaking through the local Jarvis interface. Keep voice replies concise and natural, execute real tasks with Codex tools when asked, report progress while work continues, and accept spoken corrections in the same thread. {} {}",
            config.speech_style.instructions(),
            profile.instructions
        )
    });
    let thread_setup: Result<String, String> = async {
        let started = if let Some(thread_id) = config
            .resume_thread_id
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            let mut resume_options = thread_options.clone();
            resume_options["threadId"] = Value::String(thread_id.to_owned());
            runtime
                .request("thread/resume", resume_options)
                .await
                .map_err(|error| format!("无法续接原 Codex thread；原 thread id 已保留：{error}"))?
        } else {
            let mut start_options = thread_options;
            start_options["ephemeral"] = Value::Bool(false);
            runtime.request("thread/start", start_options).await?
        };
        let thread_id = started
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .ok_or("Codex 未返回 threadId")?
            .to_owned();
        Ok(thread_id)
    }
    .await;
    let thread_id = match thread_setup {
        Ok(thread_id) => thread_id,
        Err(error) => return Err(fail_runtime_startup(&app, &state, &runtime, error).await),
    };
    *runtime.thread_id.write().await = Some(thread_id.clone());
    if let Some(desired) = state.desired_runtime.lock().await.as_mut() {
        desired.resume_thread_id = Some(thread_id);
    }
    transition_runtime_state(
        &app,
        RuntimeEvent::ThreadReady,
        RuntimeTransitionDetails {
            pid: runtime.control.pid(),
            ..Default::default()
        },
    )
    .await;

    let stable_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(stability_reset_interval()).await;
        let state = stable_app.state::<AppState>();
        if RuntimeGeneration(state.runtime_generation.load(Ordering::SeqCst)) == generation
            && state.runtime_status.read().await.state == RuntimeState::Ready
        {
            state.runtime_status.write().await.restart_attempts = 0;
            transition_runtime_state(
                &stable_app,
                RuntimeEvent::StableIntervalElapsed,
                RuntimeTransitionDetails::default(),
            )
            .await;
        }
    });
    Ok(runtime)
}

async fn ensure_runtime(
    app: AppHandle,
    state: &State<'_, AppState>,
    cwd: &str,
    resume_thread_id: Option<&str>,
    permission_mode: PermissionMode,
    speech_style: SpeechStyle,
    selected_codex_binary: Option<&str>,
) -> Result<Arc<CodexRuntime>, String> {
    let workspace = validated_workspace(cwd)?;
    let home = home_workspace_id()?;
    let permission_mode = match evaluate_permission_mode(
        permission_mode,
        &workspace.id,
        &home,
        PermissionSource::UserSelection,
        current_platform(),
    ) {
        PermissionDecision::Allow(mode) => mode,
        PermissionDecision::Reject { reason, .. } => {
            return Err(permission_rejection_message(reason).to_owned());
        }
        PermissionDecision::Downgraded { to, .. } => to,
    };
    let current_status = state.runtime_status.read().await.state;
    if matches!(
        current_status,
        RuntimeState::Starting | RuntimeState::Dead | RuntimeState::Restarting
    ) {
        return Err(request_rejection(current_status)
            .expect("non-ready runtime state must reject requests")
            .code()
            .to_owned());
    }
    let codex_binary = codex_binary_path(&app, selected_codex_binary)?;
    let existing = { state.runtime.lock().await.clone() };
    if let Some(existing) = existing {
        if existing.permission_mode == permission_mode
            && existing.speech_style == speech_style
            && existing.workspace == workspace.id
            && existing.codex_binary == codex_binary
            && state.runtime_status.read().await.state == RuntimeState::Ready
        {
            return Ok(existing);
        }
        terminate_runtime(&app, state, false).await?;
    }
    let config = RuntimeLaunchConfig {
        permission_mode,
        speech_style,
        workspace: workspace.id,
        codex_binary,
        resume_thread_id: resume_thread_id.map(str::to_owned),
    };
    *state.desired_runtime.lock().await = Some(config.clone());
    if state.runtime_status.read().await.state == RuntimeState::Failed {
        state.runtime_status.write().await.restart_attempts = 0;
        transition_runtime_state(
            &app,
            RuntimeEvent::ManualRetry,
            RuntimeTransitionDetails::default(),
        )
        .await;
    }
    let generation = RuntimeGeneration(state.runtime_generation.fetch_add(1, Ordering::SeqCst) + 1);
    launch_runtime(app, config, generation, 0).await
}

#[tauri::command]
async fn start_jarvis(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    thread_id: Option<String>,
    permission_mode: PermissionMode,
    speech_style: Option<SpeechStyle>,
    codex_path: Option<String>,
) -> Result<SessionInfo, String> {
    let runtime = ensure_runtime(
        app,
        &state,
        &cwd,
        thread_id.as_deref(),
        permission_mode,
        speech_style.unwrap_or_default(),
        codex_path.as_deref(),
    )
    .await?;
    let thread_id = runtime.thread().await?;
    Ok(SessionInfo {
        thread_id,
        cwd: runtime.workspace.as_str().to_owned(),
    })
}

#[tauri::command]
async fn start_codex_voice(
    app: AppHandle,
    state: State<'_, AppState>,
    request: StartCodexVoiceRequest,
) -> Result<DirectVoiceInfo, String> {
    let StartCodexVoiceRequest {
        cwd,
        thread_id,
        permission_mode,
        speech_style,
        codex_path,
        sdp,
        voice,
    } = request;
    if !sdp.starts_with("v=0") {
        return Err("WebRTC SDP offer 无效".to_owned());
    }
    let runtime = ensure_runtime(
        app,
        &state,
        &cwd,
        thread_id.as_deref(),
        permission_mode,
        speech_style,
        codex_path.as_deref(),
    )
    .await?;
    let thread_id = runtime.thread().await?;
    if runtime.voice_active.load(Ordering::SeqCst) {
        let _ = runtime
            .request("thread/realtime/stop", json!({"threadId": thread_id}))
            .await;
    }
    *runtime.voice_phase.write().await = "starting".to_owned();
    runtime.voice_active.store(false, Ordering::SeqCst);
    *runtime.realtime_session_id.write().await = None;

    let mut params = json!({
        "threadId": thread_id,
        "outputModality": "audio",
        "version": "v3",
        "includeStartupContext": true,
        "clientManagedHandoffs": false,
        // STOP must be final. Flushing the tail can create a new Codex turn
        // after the user has already stopped the session.
        "flushTranscriptTailOnSessionEnd": false,
        "codexResponsesAsItems": false,
        "codexResponseHandoffMode": "commentary",
        "transport": {"type": "webrtc", "sdp": sdp}
    });
    if let Some(voice) = voice {
        const SUPPORTED: &[&str] = &[
            "alloy", "arbor", "ash", "ballad", "breeze", "cedar", "coral", "cove", "echo", "ember",
            "juniper", "maple", "marin", "sage", "shimmer", "sol", "spruce", "vale", "verse",
        ];
        if SUPPORTED.contains(&voice.as_str()) {
            params["voice"] = Value::String(voice);
        }
    }
    if let Err(error) = runtime.request("thread/realtime/start", params).await {
        *runtime.voice_phase.write().await = "error".to_owned();
        return Err(format!("Codex Voice V3 启动失败：{error}"));
    }
    Ok(direct_voice_info(&state).await)
}

#[tauri::command]
async fn stop_codex_voice(state: State<'_, AppState>) -> Result<DirectVoiceInfo, String> {
    let Ok(runtime) = runtime(&state).await else {
        return Ok(direct_voice_info(&state).await);
    };
    let thread_id = runtime.thread().await?;
    *runtime.voice_phase.write().await = "stopping".to_owned();
    let result = runtime
        .request("thread/realtime/stop", json!({"threadId": thread_id}))
        .await;
    runtime.voice_active.store(false, Ordering::SeqCst);
    *runtime.voice_phase.write().await = "closed".to_owned();
    *runtime.realtime_session_id.write().await = None;
    result?;
    Ok(direct_voice_info(&state).await)
}

#[tauri::command]
async fn append_codex_voice_text(state: State<'_, AppState>, text: String) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Voice 文本不能为空".to_owned());
    }
    let runtime = runtime(&state).await?;
    if !runtime.voice_active.load(Ordering::SeqCst) {
        return Err("Codex Voice 尚未连接".to_owned());
    }
    let thread_id = runtime.thread().await?;
    runtime
        .request(
            "thread/realtime/appendText",
            json!({"threadId": thread_id, "role": "user", "text": text}),
        )
        .await?;
    Ok(())
}

#[tauri::command]
async fn send_text(state: State<'_, AppState>, text: String) -> Result<(), String> {
    let runtime = runtime(&state).await?;
    let thread_id = runtime.thread().await?;
    runtime
        .request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{"type": "text", "text": text, "text_elements": []}]
            }),
        )
        .await?;
    Ok(())
}

#[tauri::command]
async fn stop_all(state: State<'_, AppState>) -> Result<(), String> {
    let Ok(runtime) = runtime(&state).await else {
        return Ok(());
    };
    let thread_id = runtime.thread().await?;
    // A realtime handoff and STOP can cross in flight. Re-check briefly so a
    // turn that starts just after realtime/stop is interrupted as well.
    let mut interrupted_turn: Option<String> = None;
    for _ in 0..6 {
        if let Some(turn_id) = runtime.active_turn.read().await.clone() {
            if interrupted_turn.as_deref() != Some(turn_id.as_str()) {
                let _ = runtime
                    .request(
                        "turn/interrupt",
                        json!({"threadId": thread_id, "turnId": turn_id}),
                    )
                    .await;
                interrupted_turn = Some(turn_id);
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
    if let Ok(background) = runtime
        .request(
            "thread/backgroundTerminals/list",
            json!({"threadId": thread_id, "limit": 100}),
        )
        .await
    {
        if let Some(terminals) = background.get("data").and_then(Value::as_array) {
            for terminal in terminals {
                if let Some(process_id) = terminal.get("processId").and_then(Value::as_str) {
                    let _ = runtime
                        .request(
                            "thread/backgroundTerminals/terminate",
                            json!({"threadId": thread_id, "processId": process_id}),
                        )
                        .await;
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
async fn resolve_server_request(
    state: State<'_, AppState>,
    request_id: Value,
    approved: bool,
) -> Result<(), String> {
    let runtime = runtime(&state).await?;
    runtime.write(&json!({"id": request_id, "result": {"decision": if approved {"accept"} else {"decline"}}})).await
}

#[tauri::command]
async fn shutdown(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    terminate_runtime(&app, &state, true).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let arguments: Vec<String> = std::env::args().collect();
    let cold_wake_pending = arguments.iter().any(|argument| argument == "--jarvis-wake");
    let background_start = arguments.iter().any(|argument| argument == "--background");
    tauri::Builder::default()
        // This must remain the first plugin. A second launch only raises the
        // existing window instead of starting another Codex/Voice runtime.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            raise_jarvis_window(app);
            if args.iter().any(|argument| argument == "--jarvis-wake") {
                app.state::<AppState>()
                    .cold_wake_pending
                    .store(true, Ordering::SeqCst);
                let _ = app.emit("jarvis-wake", json!({"ok": true, "cold": true}));
            }
        }))
        .manage(AppState {
            runtime: Mutex::new(None),
            runtime_status: RwLock::new(RuntimeStateInfo::default()),
            runtime_generation: AtomicU64::new(0),
            desired_runtime: Mutex::new(None),
            process_spawner: Arc::new(SystemProcessSpawner),
            log_lock: StdMutex::new(()),
            cold_wake_pending: AtomicBool::new(cold_wake_pending),
            background_start,
            wake_enabled: AtomicBool::new(false),
            wake_ready: AtomicBool::new(false),
            wake_supervisor_running: AtomicBool::new(false),
            wake_pid: AtomicU32::new(0),
            wake_authorization: RwLock::new("notDetermined".to_owned()),
            wake_release_requested: AtomicBool::new(false),
            wake_control_file: Mutex::new(None),
            voice_status: RwLock::new(VoiceStateInfo::default()),
            stop_step: RwLock::new(StopStep::Start),
            stop_sequence_running: AtomicBool::new(false),
        })
        .invoke_handler(tauri::generate_handler![
            direct_voice_status,
            arm_wake_listener,
            disarm_wake_listener,
            wake_listener_status,
            voice_state,
            report_voice_event,
            run_diagnostics,
            copy_diagnostics,
            get_settings,
            save_settings,
            import_legacy_settings,
            consume_cold_wake,
            runtime_state,
            default_workspace,
            validate_workspace,
            resolve_permission_mode,
            startup_is_background,
            request_microphone_permission,
            start_jarvis,
            start_codex_voice,
            stop_codex_voice,
            append_codex_voice_text,
            send_text,
            stop_all,
            resolve_server_request,
            shutdown
        ])
        .setup(move |app| {
            use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
            app.handle().plugin(tauri_plugin_autostart::init(
                MacosLauncher::LaunchAgent,
                Some(vec!["--background"]),
            ))?;
            let autostart = initialize_settings(app.handle());
            if autostart {
                let _ = app.autolaunch().enable();
            } else {
                let _ = app.autolaunch().disable();
            }
            apply_log_rotation(app.handle());
            if let Some(window) = app.get_webview_window("main") {
                if background_start {
                    let _ = window.hide();
                } else {
                    raise_jarvis_window(app.handle());
                }
            }
            if background_start {
                start_wake_supervisor(app.handle().clone());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Jarvis Codex");
}
