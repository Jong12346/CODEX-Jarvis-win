//! P0-2b contract: Wake/Voice deterministic microphone handoff state machine.
//!
//! Activation note (identical to phase 1): these tests live here until the
//! symbols exist, then the implementation commit moves this file into
//! src-tauri/tests/ with `git mv`. All required behavior is expressed through
//! #[doc(hidden)] pub pure types and pure functions so the suite runs on any
//! platform without a microphone or audio hardware.
//!
//! Fixed decisions encoded here:
//! - Mic ownership is a total pure function; a state owns exactly one of
//!   None / Wake / Voice, and no (state, event) pair may flip ownership
//!   directly between Wake and Voice (release-before-acquire).
//! - WakeReleasingMicrophone -> VoiceAcquiringMicrophone is driven ONLY by the
//!   sidecar MicrophoneReleased confirmation, never by a timer.
//! - WakeRearming -> WakeReady is driven ONLY by AllTracksEnded.
//! - StopRequested / WorkspaceSwitchRequested share the same ordered shutdown
//!   prefix; repeated StopRequested is idempotent.
//! - ReconnectRequested is dropped in VoiceStopping / WakeRearming /
//!   WakeReleasingMicrophone / Degraded / Stopping and every non-live state.
//! - Timeout{stage} always lands in Degraded and only produces an error, never
//!   a normal sync path.
//! - Button, global hotkey and sidecar hit all map to the same WakeDetected
//!   entry event.

use jarvis_codex_lib::{
    degraded_info, is_reconnect_allowed, mic_owner, voice_state_transition, DegradedInfo, MicOwner,
    TimeoutStage, VoiceErrorKind, VoiceEvent, VoiceState,
};

const ALL_STATES: [VoiceState; 14] = [
    VoiceState::Booting,
    VoiceState::WakeArming,
    VoiceState::WakeReady,
    VoiceState::WakeDetected,
    VoiceState::WakeReleasingMicrophone,
    VoiceState::VoiceAcquiringMicrophone,
    VoiceState::VoiceConnecting,
    VoiceState::VoiceListening,
    VoiceState::VoiceSpeaking,
    VoiceState::Working,
    VoiceState::VoiceStopping,
    VoiceState::WakeRearming,
    VoiceState::Degraded,
    VoiceState::Stopping,
];

const VOICE_STATES: [VoiceState; 5] = [
    VoiceState::VoiceAcquiringMicrophone,
    VoiceState::VoiceConnecting,
    VoiceState::VoiceListening,
    VoiceState::VoiceSpeaking,
    VoiceState::Working,
];

const ALL_TIMEOUTS: [VoiceEvent; 4] = [
    VoiceEvent::Timeout {
        stage: TimeoutStage::WakeArm,
    },
    VoiceEvent::Timeout {
        stage: TimeoutStage::MicrophoneRelease,
    },
    VoiceEvent::Timeout {
        stage: TimeoutStage::MicrophoneAcquire,
    },
    VoiceEvent::Timeout {
        stage: TimeoutStage::VoiceConnect,
    },
];

const ALL_ERROR_EVENTS: [VoiceEvent; 6] = [
    VoiceEvent::WakeError,
    VoiceEvent::RealtimeError,
    VoiceEvent::Timeout {
        stage: TimeoutStage::WakeArm,
    },
    VoiceEvent::Timeout {
        stage: TimeoutStage::MicrophoneRelease,
    },
    VoiceEvent::Timeout {
        stage: TimeoutStage::MicrophoneAcquire,
    },
    VoiceEvent::Timeout {
        stage: TimeoutStage::VoiceConnect,
    },
];

#[test]
fn mic_owner_is_total_and_single() {
    // 任一状态恰好属于一个所有者，且 Wake / Voice 集合不相交。
    let wake_owned = [
        VoiceState::WakeArming,
        VoiceState::WakeReady,
        VoiceState::WakeDetected,
        VoiceState::WakeReleasingMicrophone,
    ];
    let voice_owned = [
        VoiceState::VoiceConnecting,
        VoiceState::VoiceListening,
        VoiceState::VoiceSpeaking,
        VoiceState::Working,
        VoiceState::VoiceStopping,
    ];
    for state in ALL_STATES {
        let owner = mic_owner(state);
        let expected = if wake_owned.contains(&state) {
            MicOwner::Wake
        } else if voice_owned.contains(&state) {
            MicOwner::Voice
        } else {
            MicOwner::None
        };
        assert_eq!(owner, expected, "{state:?} must have exactly one owner");
    }
}

#[test]
fn no_transition_ever_holds_both_owners() {
    // 兜底不变量：遍历全部 (state, event)，所有权不得在 Wake 与 Voice 之间
    // 直接翻转；任何一方持有期间出现另一方都必须先经过 None。
    let events = [
        VoiceEvent::BootCompleted,
        VoiceEvent::WakeArmed,
        VoiceEvent::WakeDetected,
        VoiceEvent::WakeReleaseRequested,
        VoiceEvent::MicrophoneReleased,
        VoiceEvent::VoiceMicrophoneAcquired,
        VoiceEvent::VoiceConnected,
        VoiceEvent::TurnStarted,
        VoiceEvent::TurnCompleted,
        VoiceEvent::SpeakingStarted,
        VoiceEvent::SpeakingEnded,
        VoiceEvent::ReconnectRequested,
        VoiceEvent::StopRequested,
        VoiceEvent::WorkspaceSwitchRequested,
        VoiceEvent::VoiceStopped,
        VoiceEvent::AllTracksEnded,
        VoiceEvent::WakeError,
        VoiceEvent::RealtimeError,
        VoiceEvent::RetryRequested,
    ];
    for state in ALL_STATES {
        for event in events.into_iter().chain(ALL_TIMEOUTS) {
            let next = voice_state_transition(state, event);
            let from = mic_owner(state);
            let to = mic_owner(next);
            assert!(
                !(from == MicOwner::Wake && to == MicOwner::Voice),
                "{state:?} + {event:?} flips Wake -> Voice directly; release must precede acquire"
            );
            assert!(
                !(from == MicOwner::Voice && to == MicOwner::Wake),
                "{state:?} + {event:?} flips Voice -> Wake directly; tracks must end first"
            );
        }
    }
}

#[test]
fn the_happy_path_reaches_wake_ready() {
    let mut state = VoiceState::Booting;
    for event in [VoiceEvent::BootCompleted, VoiceEvent::WakeArmed] {
        state = voice_state_transition(state, event);
    }
    assert_eq!(state, VoiceState::WakeReady);
}

#[test]
fn the_voice_handoff_is_release_then_acquire() {
    let mut state = VoiceState::WakeReady;
    for event in [
        VoiceEvent::WakeDetected,
        VoiceEvent::WakeReleaseRequested,
        VoiceEvent::MicrophoneReleased,
        VoiceEvent::VoiceMicrophoneAcquired,
        VoiceEvent::VoiceConnected,
    ] {
        state = voice_state_transition(state, event);
    }
    assert_eq!(state, VoiceState::VoiceListening);
    assert_eq!(mic_owner(state), MicOwner::Voice);
}

#[test]
fn wake_release_requires_sidecar_confirmation() {
    // 释放先于获取：全 (state, event) 笛卡尔积中，只有
    // (WakeReleasingMicrophone, MicrophoneReleased) 允许进入
    // VoiceAcquiringMicrophone；计时器或探测不得替代确认。
    for state in ALL_STATES {
        for event in ALL_ERROR_EVENTS.into_iter().chain([
            VoiceEvent::WakeDetected,
            VoiceEvent::WakeReleaseRequested,
            VoiceEvent::MicrophoneReleased,
            VoiceEvent::VoiceMicrophoneAcquired,
            VoiceEvent::VoiceConnected,
            VoiceEvent::VoiceStopped,
            VoiceEvent::AllTracksEnded,
            VoiceEvent::ReconnectRequested,
            VoiceEvent::StopRequested,
            VoiceEvent::WorkspaceSwitchRequested,
        ]) {
            let next = voice_state_transition(state, event);
            let is_authorized = state == VoiceState::WakeReleasingMicrophone
                && event == VoiceEvent::MicrophoneReleased;
            let reached_from_elsewhere = next == VoiceState::VoiceAcquiringMicrophone
                && state != VoiceState::VoiceAcquiringMicrophone;
            assert!(
                !reached_from_elsewhere || is_authorized,
                "{state:?} + {event:?} must only reach VoiceAcquiringMicrophone via the release confirmation"
            );
        }
    }
}

#[test]
fn rearm_is_gated_on_all_tracks_ended() {
    // WakeRearming -> WakeReady 只能由 AllTracksEnded 触发。
    for event in ALL_ERROR_EVENTS.into_iter().chain([
        VoiceEvent::BootCompleted,
        VoiceEvent::WakeArmed,
        VoiceEvent::WakeDetected,
        VoiceEvent::MicrophoneReleased,
        VoiceEvent::VoiceConnected,
        VoiceEvent::VoiceStopped,
        VoiceEvent::ReconnectRequested,
        VoiceEvent::RetryRequested,
    ]) {
        assert_ne!(
            voice_state_transition(VoiceState::WakeRearming, event),
            VoiceState::WakeReady,
            "{event:?} must not re-arm before all local tracks ended"
        );
    }
    assert_eq!(
        voice_state_transition(VoiceState::WakeRearming, VoiceEvent::AllTracksEnded),
        VoiceState::WakeReady
    );
}

#[test]
fn stop_is_idempotent_from_every_voice_state() {
    for state in VOICE_STATES.into_iter().chain([VoiceState::VoiceStopping]) {
        let stopped = voice_state_transition(state, VoiceEvent::StopRequested);
        assert_eq!(
            stopped,
            VoiceState::VoiceStopping,
            "{state:?} must enter VoiceStopping"
        );
        let again = voice_state_transition(stopped, VoiceEvent::StopRequested);
        assert_eq!(
            again,
            VoiceState::VoiceStopping,
            "repeated StopRequested must be idempotent"
        );
        let third = voice_state_transition(again, VoiceEvent::StopRequested);
        assert_eq!(
            third,
            VoiceState::VoiceStopping,
            "StopRequested must never error or revive"
        );
    }
}

#[test]
fn workspace_switch_shares_the_stop_prefix() {
    // WorkspaceSwitch 与 StopRequested 走同一条有序关闭前缀。
    for state in VOICE_STATES.into_iter().chain([VoiceState::VoiceStopping]) {
        assert_eq!(
            voice_state_transition(state, VoiceEvent::WorkspaceSwitchRequested),
            VoiceState::VoiceStopping,
            "{state:?} must take the ordered shutdown prefix"
        );
        assert_eq!(
            voice_state_transition(state, VoiceEvent::WorkspaceSwitchRequested),
            voice_state_transition(state, VoiceEvent::StopRequested)
        );
    }
}

#[test]
fn reconnect_is_dropped_while_shutting_down() {
    for state in [
        VoiceState::VoiceStopping,
        VoiceState::WakeRearming,
        VoiceState::WakeReleasingMicrophone,
        VoiceState::Degraded,
        VoiceState::Stopping,
        VoiceState::Booting,
        VoiceState::WakeArming,
        VoiceState::WakeReady,
        VoiceState::WakeDetected,
        VoiceState::VoiceAcquiringMicrophone,
    ] {
        assert!(
            !is_reconnect_allowed(state),
            "{state:?} must reject reconnect"
        );
        assert_eq!(
            voice_state_transition(state, VoiceEvent::ReconnectRequested),
            state,
            "{state:?} must drop ReconnectRequested instead of reviving Voice"
        );
    }
}

#[test]
fn reconnect_is_allowed_only_for_live_voice() {
    for state in [
        VoiceState::VoiceConnecting,
        VoiceState::VoiceListening,
        VoiceState::VoiceSpeaking,
        VoiceState::Working,
    ] {
        assert!(is_reconnect_allowed(state), "{state:?} may reconnect");
        assert_eq!(
            voice_state_transition(state, VoiceEvent::ReconnectRequested),
            VoiceState::VoiceConnecting
        );
    }
}

#[test]
fn every_timeout_enters_degraded() {
    // Stopping 是终态，晚到的超时不得改变已停止的界面；其余任何状态收到
    // 超时一律进入 Degraded，绝不作为正常同步手段。
    for state in ALL_STATES
        .into_iter()
        .filter(|state| *state != VoiceState::Stopping)
    {
        for event in ALL_TIMEOUTS {
            assert_eq!(
                voice_state_transition(state, event),
                VoiceState::Degraded,
                "{state:?} + {event:?} must enter Degraded, never a normal sync path"
            );
        }
    }
}

#[test]
fn error_events_enter_degraded() {
    for state in ALL_STATES
        .into_iter()
        .filter(|state| *state != VoiceState::Stopping)
    {
        for event in [VoiceEvent::WakeError, VoiceEvent::RealtimeError] {
            assert_eq!(voice_state_transition(state, event), VoiceState::Degraded);
        }
    }
}

#[test]
fn degraded_carries_category_recoverability_action_and_owner() {
    for event in ALL_ERROR_EVENTS {
        let info: DegradedInfo =
            degraded_info(event, MicOwner::Voice).expect("error events carry DegradedInfo");
        assert_ne!(
            info.error_kind,
            VoiceErrorKind::Unknown,
            "error category must be specific"
        );
        assert!(
            !info.suggested_action.trim().is_empty(),
            "suggested action must be present"
        );
        assert_eq!(
            info.owner,
            MicOwner::Voice,
            "current resource owner must be carried"
        );
        let _ = (info.recoverable, info.error_kind);
    }
}

#[test]
fn single_entry_wake_detected() {
    // 按钮唤醒、全局快捷键、sidecar 命中都是同一个入口事件。
    let button = VoiceEvent::WakeDetected;
    let hotkey = VoiceEvent::WakeDetected;
    let sidecar = VoiceEvent::WakeDetected;
    for entry in [button, hotkey, sidecar] {
        assert_eq!(
            voice_state_transition(VoiceState::WakeReady, entry),
            VoiceState::WakeDetected
        );
    }
    for state in [
        VoiceState::VoiceListening,
        VoiceState::VoiceSpeaking,
        VoiceState::Working,
        VoiceState::VoiceStopping,
        VoiceState::VoiceConnecting,
    ] {
        assert_eq!(
            voice_state_transition(state, VoiceEvent::WakeDetected),
            state,
            "a late wake hit must never skip the release sequence"
        );
    }
}

#[test]
fn late_voice_stopped_never_revives() {
    for state in [
        VoiceState::WakeReady,
        VoiceState::WakeRearming,
        VoiceState::Degraded,
        VoiceState::Stopping,
        VoiceState::WakeDetected,
        VoiceState::WakeReleasingMicrophone,
    ] {
        assert_eq!(
            voice_state_transition(state, VoiceEvent::VoiceStopped),
            state,
            "a stale VoiceStopped must not revive or move the machine"
        );
    }
}

#[test]
fn speaking_and_working_substates() {
    let listening = voice_state_transition(VoiceState::WakeReady, VoiceEvent::WakeDetected);
    let _ = listening;
    let mut state = VoiceState::VoiceListening;
    state = voice_state_transition(state, VoiceEvent::SpeakingStarted);
    assert_eq!(state, VoiceState::VoiceSpeaking);
    state = voice_state_transition(state, VoiceEvent::SpeakingEnded);
    assert_eq!(state, VoiceState::VoiceListening);
    state = voice_state_transition(state, VoiceEvent::TurnStarted);
    assert_eq!(state, VoiceState::Working);
    state = voice_state_transition(state, VoiceEvent::TurnCompleted);
    assert_eq!(state, VoiceState::VoiceListening);
    let mut from_speaking = VoiceState::VoiceSpeaking;
    from_speaking = voice_state_transition(from_speaking, VoiceEvent::TurnStarted);
    assert_eq!(from_speaking, VoiceState::Working);
}

#[test]
fn stopping_is_terminal() {
    for event in [
        VoiceEvent::BootCompleted,
        VoiceEvent::WakeArmed,
        VoiceEvent::WakeDetected,
        VoiceEvent::MicrophoneReleased,
        VoiceEvent::VoiceConnected,
        VoiceEvent::StopRequested,
        VoiceEvent::WorkspaceSwitchRequested,
        VoiceEvent::VoiceStopped,
        VoiceEvent::AllTracksEnded,
        VoiceEvent::ReconnectRequested,
        VoiceEvent::RetryRequested,
        VoiceEvent::WakeError,
        VoiceEvent::RealtimeError,
    ] {
        assert_eq!(
            voice_state_transition(VoiceState::Stopping, event),
            VoiceState::Stopping,
            "Stopping is terminal"
        );
    }
}

#[test]
fn degraded_recovers_only_through_retry() {
    for state in ALL_STATES
        .into_iter()
        .filter(|state| *state != VoiceState::Stopping)
    {
        for event in ALL_ERROR_EVENTS {
            let degraded = voice_state_transition(state, event);
            assert_eq!(degraded, VoiceState::Degraded);
        }
    }
    for event in [
        VoiceEvent::BootCompleted,
        VoiceEvent::WakeArmed,
        VoiceEvent::WakeDetected,
        VoiceEvent::MicrophoneReleased,
        VoiceEvent::VoiceConnected,
        VoiceEvent::VoiceStopped,
        VoiceEvent::AllTracksEnded,
        VoiceEvent::ReconnectRequested,
    ] {
        assert_eq!(
            voice_state_transition(VoiceState::Degraded, event),
            VoiceState::Degraded,
            "{event:?} must not silently recover Degraded"
        );
    }
    assert_eq!(
        voice_state_transition(VoiceState::Degraded, VoiceEvent::RetryRequested),
        VoiceState::Booting,
        "manual retry re-enters from scratch"
    );
}

#[test]
fn explicit_manual_voice_bypasses_only_a_degraded_wake_engine() {
    assert_eq!(
        voice_state_transition(VoiceState::Degraded, VoiceEvent::ManualVoiceRequested),
        VoiceState::VoiceAcquiringMicrophone
    );
    assert_eq!(
        voice_state_transition(VoiceState::WakeReady, VoiceEvent::ManualVoiceRequested),
        VoiceState::WakeReady,
        "healthy standby must keep the normal release-before-acquire path"
    );
}

#[test]
fn boot_to_arm_only_via_boot_completed() {
    for event in [
        VoiceEvent::WakeArmed,
        VoiceEvent::WakeDetected,
        VoiceEvent::MicrophoneReleased,
        VoiceEvent::VoiceConnected,
        VoiceEvent::StopRequested,
        VoiceEvent::AllTracksEnded,
    ] {
        assert_ne!(
            voice_state_transition(VoiceState::Booting, event),
            VoiceState::WakeArming,
            "{event:?} must not skip boot completion"
        );
    }
    assert_eq!(
        voice_state_transition(VoiceState::Booting, VoiceEvent::BootCompleted),
        VoiceState::WakeArming
    );
    assert_eq!(
        voice_state_transition(VoiceState::WakeArming, VoiceEvent::WakeArmed),
        VoiceState::WakeReady
    );
}

#[test]
fn timeout_and_retry_cycle_reaches_wake_ready_again() {
    let mut state = VoiceState::WakeReady;
    state = voice_state_transition(state, VoiceEvent::WakeDetected);
    state = voice_state_transition(state, VoiceEvent::WakeReleaseRequested);
    state = voice_state_transition(
        state,
        VoiceEvent::Timeout {
            stage: TimeoutStage::MicrophoneRelease,
        },
    );
    assert_eq!(state, VoiceState::Degraded);
    state = voice_state_transition(state, VoiceEvent::RetryRequested);
    assert_eq!(state, VoiceState::Booting);
    for event in [VoiceEvent::BootCompleted, VoiceEvent::WakeArmed] {
        state = voice_state_transition(state, event);
    }
    assert_eq!(state, VoiceState::WakeReady);
}

#[test]
fn trigger_names_are_stable() {
    assert_eq!(VoiceEvent::BootCompleted.trigger(), "bootCompleted");
    assert_eq!(VoiceEvent::WakeDetected.trigger(), "wakeDetected");
    assert_eq!(
        VoiceEvent::MicrophoneReleased.trigger(),
        "microphoneReleased"
    );
    assert_eq!(VoiceEvent::VoiceStopped.trigger(), "voiceStopped");
    assert_eq!(VoiceEvent::AllTracksEnded.trigger(), "allTracksEnded");
    assert_eq!(
        VoiceEvent::Timeout {
            stage: TimeoutStage::MicrophoneRelease
        }
        .trigger(),
        "timeout.microphoneRelease"
    );
}

#[test]
fn frontend_events_round_trip_through_from_trigger() {
    for (name, expected) in [
        ("wakeDetected", VoiceEvent::WakeDetected),
        (
            "voiceMicrophoneAcquired",
            VoiceEvent::VoiceMicrophoneAcquired,
        ),
        ("allTracksEnded", VoiceEvent::AllTracksEnded),
        ("speakingStarted", VoiceEvent::SpeakingStarted),
        ("speakingEnded", VoiceEvent::SpeakingEnded),
        ("reconnectRequested", VoiceEvent::ReconnectRequested),
        ("retryRequested", VoiceEvent::RetryRequested),
        ("stopRequested", VoiceEvent::StopRequested),
        (
            "workspaceSwitchRequested",
            VoiceEvent::WorkspaceSwitchRequested,
        ),
        (
            "microphoneAcquireTimeout",
            VoiceEvent::Timeout {
                stage: TimeoutStage::MicrophoneAcquire,
            },
        ),
        (
            "voiceConnectTimeout",
            VoiceEvent::Timeout {
                stage: TimeoutStage::VoiceConnect,
            },
        ),
    ] {
        assert_eq!(
            VoiceEvent::from_trigger(name),
            Some(expected),
            "{name} must parse"
        );
    }
    assert_eq!(VoiceEvent::from_trigger("nonsense"), None);
}
