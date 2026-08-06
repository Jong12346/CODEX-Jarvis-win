use serde::Serialize;

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceState {
    Booting,
    WakeArming,
    WakeReady,
    WakeDetected,
    WakeReleasingMicrophone,
    VoiceAcquiringMicrophone,
    VoiceConnecting,
    VoiceListening,
    VoiceSpeaking,
    Working,
    VoiceStopping,
    WakeRearming,
    Degraded,
    Stopping,
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MicOwner {
    None,
    Wake,
    Voice,
}

/// 任一状态恰好属于一个麦克风所有者；Wake 与 Voice 永不重叠。
#[doc(hidden)]
pub fn mic_owner(state: VoiceState) -> MicOwner {
    match state {
        VoiceState::WakeArming
        | VoiceState::WakeReady
        | VoiceState::WakeDetected
        | VoiceState::WakeReleasingMicrophone => MicOwner::Wake,
        VoiceState::VoiceConnecting
        | VoiceState::VoiceListening
        | VoiceState::VoiceSpeaking
        | VoiceState::Working
        | VoiceState::VoiceStopping => MicOwner::Voice,
        VoiceState::Booting
        | VoiceState::VoiceAcquiringMicrophone
        | VoiceState::WakeRearming
        | VoiceState::Degraded
        | VoiceState::Stopping => MicOwner::None,
    }
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimeoutStage {
    WakeArm,
    MicrophoneRelease,
    MicrophoneAcquire,
    VoiceConnect,
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoiceEvent {
    BootCompleted,
    WakeArmed,
    /// 唯一唤醒入口：按钮、全局快捷键、sidecar 命中都映射到这个事件。
    WakeDetected,
    WakeReleaseRequested,
    /// sidecar 退出且麦克风释放确认后由后端发出，是 Wake -> Voice 交接的
    /// 唯一触发器，禁止由计时器替代。
    MicrophoneReleased,
    VoiceMicrophoneAcquired,
    VoiceConnected,
    TurnStarted,
    TurnCompleted,
    SpeakingStarted,
    SpeakingEnded,
    ReconnectRequested,
    StopRequested,
    WorkspaceSwitchRequested,
    VoiceStopped,
    AllTracksEnded,
    WakeError,
    RealtimeError,
    Timeout {
        stage: TimeoutStage,
    },
    RetryRequested,
}

impl VoiceEvent {
    #[doc(hidden)]
    pub const fn trigger(self) -> &'static str {
        match self {
            Self::BootCompleted => "bootCompleted",
            Self::WakeArmed => "wakeArmed",
            Self::WakeDetected => "wakeDetected",
            Self::WakeReleaseRequested => "wakeReleaseRequested",
            Self::MicrophoneReleased => "microphoneReleased",
            Self::VoiceMicrophoneAcquired => "voiceMicrophoneAcquired",
            Self::VoiceConnected => "voiceConnected",
            Self::TurnStarted => "turnStarted",
            Self::TurnCompleted => "turnCompleted",
            Self::SpeakingStarted => "speakingStarted",
            Self::SpeakingEnded => "speakingEnded",
            Self::ReconnectRequested => "reconnectRequested",
            Self::StopRequested => "stopRequested",
            Self::WorkspaceSwitchRequested => "workspaceSwitchRequested",
            Self::VoiceStopped => "voiceStopped",
            Self::AllTracksEnded => "allTracksEnded",
            Self::WakeError => "wakeError",
            Self::RealtimeError => "realtimeError",
            Self::Timeout { stage } => match stage {
                TimeoutStage::WakeArm => "timeout.wakeArm",
                TimeoutStage::MicrophoneRelease => "timeout.microphoneRelease",
                TimeoutStage::MicrophoneAcquire => "timeout.microphoneAcquire",
                TimeoutStage::VoiceConnect => "timeout.voiceConnect",
            },
            Self::RetryRequested => "retryRequested",
        }
    }

    /// 前端 `report_voice_event` 命令接受的稳定事件名。
    #[doc(hidden)]
    pub fn from_trigger(name: &str) -> Option<Self> {
        match name {
            "wakeDetected" => Some(Self::WakeDetected),
            "voiceMicrophoneAcquired" => Some(Self::VoiceMicrophoneAcquired),
            "allTracksEnded" => Some(Self::AllTracksEnded),
            "speakingStarted" => Some(Self::SpeakingStarted),
            "speakingEnded" => Some(Self::SpeakingEnded),
            "reconnectRequested" => Some(Self::ReconnectRequested),
            "retryRequested" => Some(Self::RetryRequested),
            "stopRequested" => Some(Self::StopRequested),
            "workspaceSwitchRequested" => Some(Self::WorkspaceSwitchRequested),
            "microphoneAcquireTimeout" => Some(Self::Timeout {
                stage: TimeoutStage::MicrophoneAcquire,
            }),
            "voiceConnectTimeout" => Some(Self::Timeout {
                stage: TimeoutStage::VoiceConnect,
            }),
            _ => None,
        }
    }
}

/// 纯状态迁移：未匹配的组合一律忽略（丢弃晚到事件），绝不发明新状态。
#[doc(hidden)]
pub fn voice_state_transition(state: VoiceState, event: VoiceEvent) -> VoiceState {
    match (state, event) {
        (VoiceState::Stopping, _) => VoiceState::Stopping,

        (VoiceState::Booting, VoiceEvent::BootCompleted) => VoiceState::WakeArming,
        (VoiceState::WakeArming, VoiceEvent::WakeArmed) => VoiceState::WakeReady,
        (VoiceState::WakeReady, VoiceEvent::WakeDetected) => VoiceState::WakeDetected,
        (VoiceState::WakeDetected, VoiceEvent::WakeReleaseRequested) => {
            VoiceState::WakeReleasingMicrophone
        }
        (VoiceState::WakeReleasingMicrophone, VoiceEvent::MicrophoneReleased) => {
            VoiceState::VoiceAcquiringMicrophone
        }
        (VoiceState::VoiceAcquiringMicrophone, VoiceEvent::VoiceMicrophoneAcquired) => {
            VoiceState::VoiceConnecting
        }
        (VoiceState::VoiceConnecting, VoiceEvent::VoiceConnected) => VoiceState::VoiceListening,

        (VoiceState::VoiceListening, VoiceEvent::SpeakingStarted) => VoiceState::VoiceSpeaking,
        (VoiceState::VoiceSpeaking, VoiceEvent::SpeakingEnded) => VoiceState::VoiceListening,

        (VoiceState::VoiceListening | VoiceState::VoiceSpeaking, VoiceEvent::TurnStarted) => {
            VoiceState::Working
        }
        (VoiceState::Working, VoiceEvent::TurnCompleted) => VoiceState::VoiceListening,

        (
            VoiceState::VoiceConnecting
            | VoiceState::VoiceListening
            | VoiceState::VoiceSpeaking
            | VoiceState::Working,
            VoiceEvent::ReconnectRequested,
        ) => VoiceState::VoiceConnecting,

        (
            VoiceState::VoiceAcquiringMicrophone
            | VoiceState::VoiceConnecting
            | VoiceState::VoiceListening
            | VoiceState::VoiceSpeaking
            | VoiceState::Working
            | VoiceState::VoiceStopping,
            VoiceEvent::StopRequested | VoiceEvent::WorkspaceSwitchRequested,
        ) => VoiceState::VoiceStopping,
        (
            VoiceState::Booting
            | VoiceState::WakeArming
            | VoiceState::WakeReady
            | VoiceState::WakeDetected
            | VoiceState::WakeReleasingMicrophone
            | VoiceState::WakeRearming
            | VoiceState::Degraded,
            VoiceEvent::StopRequested | VoiceEvent::WorkspaceSwitchRequested,
        ) => VoiceState::Stopping,

        (
            VoiceState::VoiceConnecting
            | VoiceState::VoiceListening
            | VoiceState::VoiceSpeaking
            | VoiceState::Working
            | VoiceState::VoiceStopping,
            VoiceEvent::VoiceStopped,
        ) => VoiceState::WakeRearming,
        (VoiceState::WakeRearming, VoiceEvent::AllTracksEnded) => VoiceState::WakeReady,

        (_, VoiceEvent::WakeError | VoiceEvent::RealtimeError | VoiceEvent::Timeout { .. }) => {
            VoiceState::Degraded
        }
        (VoiceState::Degraded, VoiceEvent::RetryRequested) => VoiceState::Booting,

        _ => state,
    }
}

/// Voice 网络自动重连只允许在实时会话仍然存活的四种状态进行；
/// STOP、目录切换、重新布防与错误态一律丢弃重连请求。
#[doc(hidden)]
pub fn is_reconnect_allowed(state: VoiceState) -> bool {
    matches!(
        state,
        VoiceState::VoiceConnecting
            | VoiceState::VoiceListening
            | VoiceState::VoiceSpeaking
            | VoiceState::Working
    )
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceErrorKind {
    WakeArmTimeout,
    MicrophoneReleaseTimeout,
    MicrophoneAcquireTimeout,
    VoiceConnectTimeout,
    WakeError,
    RealtimeError,
    Unknown,
}

/// Degraded 必须携带：错误类别、可恢复性、建议动作、当前资源所有者。
#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DegradedInfo {
    pub error_kind: VoiceErrorKind,
    pub recoverable: bool,
    pub suggested_action: &'static str,
    pub owner: MicOwner,
}

#[doc(hidden)]
pub fn degraded_info(event: VoiceEvent, owner: MicOwner) -> Option<DegradedInfo> {
    match event {
        VoiceEvent::Timeout { stage } => {
            let (error_kind, suggested_action) = match stage {
                TimeoutStage::WakeArm => (
                    VoiceErrorKind::WakeArmTimeout,
                    "The wake listener did not become ready. Check the Windows speech language pack and microphone privacy settings, then retry.",
                ),
                TimeoutStage::MicrophoneRelease => (
                    VoiceErrorKind::MicrophoneReleaseTimeout,
                    "The wake listener did not confirm microphone release. Another app may be holding the microphone; wait a moment and retry.",
                ),
                TimeoutStage::MicrophoneAcquire => (
                    VoiceErrorKind::MicrophoneAcquireTimeout,
                    "The system did not grant the microphone in time. Check the privacy settings and retry.",
                ),
                TimeoutStage::VoiceConnect => (
                    VoiceErrorKind::VoiceConnectTimeout,
                    "The Codex Voice session did not connect. Check your network or Codex login, then retry.",
                ),
            };
            Some(DegradedInfo {
                error_kind,
                recoverable: true,
                suggested_action,
                owner,
            })
        }
        VoiceEvent::WakeError => Some(DegradedInfo {
            error_kind: VoiceErrorKind::WakeError,
            recoverable: true,
            suggested_action: "The wake listener failed. Check the Windows speech language pack and microphone privacy settings, then retry.",
            owner,
        }),
        VoiceEvent::RealtimeError => Some(DegradedInfo {
            error_kind: VoiceErrorKind::RealtimeError,
            recoverable: true,
            suggested_action: "The realtime session failed. Check your network or Codex login, then retry.",
            owner,
        }),
        _ => None,
    }
}
