//! Phase 6 contract: first-run wizard, tray menu and global hotkey shell.
//!
//! Activation note (same as phases 1-5): this file lives here until the
//! symbols exist, then the implementation commit moves it into
//! src-tauri/tests/ with `git mv`. The pure parts (wizard gating, tray
//! enablement, accelerator parsing/conflicts) are contract-tested here; OS
//! behaviour is left for real-machine acceptance.
//!
//! Fixed decisions encoded here:
//! - wizard_steps reuses diagnostics classify() and never re-classifies;
//!   any Red step blocks proceeding, Yellow never blocks, order is stable.
//! - tray_menu is a pure state->enabled mapping with stable distinct ids;
//!   STOP is disabled while no live voice, Wake is disabled while voice is
//!   active, Diagnostics/Exit are always enabled.
//! - parse_accelerator produces structured errors; conflicts with reserved
//!   shortcuts are decidable; formatting round-trips.
//! - Tray wake and global hotkey both enter VoiceEvent::WakeDetected, the
//!   same single entry as the button (phase 2).

use jarvis_codex_lib::{
    app_shell::{
        can_proceed, format_accelerator, has_conflict, parse_accelerator, reserved_accelerators,
        tray_menu, wake_entry, wizard_steps, AcceleratorError, MenuItemSpec, Modifier, WizardStep,
    },
    voice_state_transition, ProbeResult, RuntimeState, VerdictLevel, VoiceEvent, VoiceState,
};

#[test]
fn wizard_steps_reuse_classify_and_keep_stable_order() {
    let results = [
        ("network", ProbeResult::NetworkTimeout),
        ("codex", ProbeResult::Ok),
        ("workspace", ProbeResult::WorkspaceUnreadable),
        ("microphone", ProbeResult::MicDenied),
        ("webview2", ProbeResult::Ok),
        ("speech_pack", ProbeResult::SpeechPackMissing),
        ("windows", ProbeResult::Ok),
    ];
    let steps = wizard_steps(&results);
    let ids: Vec<&str> = steps.iter().map(|step| step.id).collect();
    assert_eq!(
        ids,
        [
            "windows",
            "webview2",
            "microphone",
            "speech_pack",
            "codex",
            "workspace",
            "network"
        ],
        "wizard step order must be stable"
    );
    let network = steps.iter().find(|step| step.id == "network").unwrap();
    assert_eq!(network.status, VerdictLevel::Yellow);
    assert!(!network.blocking, "Yellow never blocks");
    let workspace = steps.iter().find(|step| step.id == "workspace").unwrap();
    assert_eq!(workspace.status, VerdictLevel::Red);
    assert!(workspace.blocking, "Red blocks");
}

#[test]
fn red_blocking_item_prevents_proceeding() {
    let steps = wizard_steps(&[
        ("codex", ProbeResult::CodexMissing),
        ("workspace", ProbeResult::Ok),
        ("network", ProbeResult::Ok),
        ("webview2", ProbeResult::Ok),
        ("microphone", ProbeResult::Ok),
        ("speech_pack", ProbeResult::Ok),
        ("windows", ProbeResult::Ok),
    ]);
    assert!(!can_proceed(&steps));
}

#[test]
fn yellow_only_allows_proceeding() {
    let steps = wizard_steps(&[
        ("network", ProbeResult::ProxyUnreachable),
        ("microphone", ProbeResult::MicDenied),
        ("speech_pack", ProbeResult::SpeechPackMissing),
        ("codex", ProbeResult::Ok),
        ("workspace", ProbeResult::Ok),
        ("webview2", ProbeResult::Ok),
        ("windows", ProbeResult::Ok),
    ]);
    assert!(can_proceed(&steps), "Yellow-only must not block the wizard");
}

#[test]
fn all_green_allows_proceeding() {
    let steps = wizard_steps(&[
        ("windows", ProbeResult::Ok),
        ("webview2", ProbeResult::Ok),
        ("microphone", ProbeResult::Ok),
        ("speech_pack", ProbeResult::Ok),
        ("codex", ProbeResult::Ok),
        ("workspace", ProbeResult::Ok),
        ("network", ProbeResult::Ok),
    ]);
    assert!(can_proceed(&steps));
}

#[test]
fn wizard_step_ids_are_stable_and_distinct() {
    let steps = wizard_steps(&[
        ("windows", ProbeResult::Ok),
        ("webview2", ProbeResult::Ok),
        ("microphone", ProbeResult::Ok),
        ("speech_pack", ProbeResult::Ok),
        ("codex", ProbeResult::Ok),
        ("workspace", ProbeResult::Ok),
        ("network", ProbeResult::Ok),
    ]);
    let mut ids: Vec<&str> = steps.iter().map(|step| step.id).collect();
    ids.dedup();
    assert_eq!(ids.len(), steps.len());
    for step in &steps {
        let _: WizardStep = *step;
    }
}

#[test]
fn tray_stop_is_disabled_without_a_live_voice() {
    for runtime in [
        RuntimeState::Absent,
        RuntimeState::Starting,
        RuntimeState::Ready,
        RuntimeState::Dead,
    ] {
        let menu = tray_menu(runtime, VoiceState::WakeReady);
        let stop = menu.iter().find(|item| item.id == "stop").unwrap();
        assert!(!stop.enabled, "{runtime:?} + WakeReady must disable STOP");
    }
}

#[test]
fn tray_stop_is_enabled_only_for_ready_runtime_and_live_voice() {
    for voice in [
        VoiceState::VoiceConnecting,
        VoiceState::VoiceListening,
        VoiceState::VoiceSpeaking,
        VoiceState::Working,
    ] {
        let enabled = tray_menu(RuntimeState::Ready, voice)
            .iter()
            .find(|item| item.id == "stop")
            .unwrap()
            .enabled;
        assert!(enabled, "{voice:?} with Ready runtime must enable STOP");
        let not_ready = tray_menu(RuntimeState::Dead, voice)
            .iter()
            .find(|item| item.id == "stop")
            .unwrap()
            .enabled;
        assert!(!not_ready, "{voice:?} with Dead runtime must disable STOP");
    }
}

#[test]
fn tray_wake_is_disabled_while_voice_is_active() {
    for voice in [
        VoiceState::VoiceConnecting,
        VoiceState::VoiceListening,
        VoiceState::VoiceSpeaking,
        VoiceState::Working,
        VoiceState::VoiceStopping,
    ] {
        let menu = tray_menu(RuntimeState::Ready, voice);
        assert!(
            !menu.iter().find(|item| item.id == "wake").unwrap().enabled,
            "{voice:?} must disable Wake"
        );
    }
}

#[test]
fn tray_wake_is_enabled_when_standby() {
    for voice in [
        VoiceState::Booting,
        VoiceState::WakeArming,
        VoiceState::WakeReady,
        VoiceState::WakeDetected,
        VoiceState::VoiceAcquiringMicrophone,
        VoiceState::WakeRearming,
        VoiceState::Degraded,
    ] {
        assert!(
            tray_menu(RuntimeState::Ready, voice)
                .iter()
                .find(|item| item.id == "wake")
                .unwrap()
                .enabled,
            "{voice:?} must enable Wake"
        );
    }
}

#[test]
fn tray_diagnostics_and_exit_are_always_enabled() {
    for runtime in [
        RuntimeState::Absent,
        RuntimeState::Starting,
        RuntimeState::Ready,
        RuntimeState::Dead,
        RuntimeState::Failed,
    ] {
        for voice in [
            VoiceState::Booting,
            VoiceState::WakeReady,
            VoiceState::VoiceListening,
            VoiceState::VoiceStopping,
            VoiceState::Degraded,
        ] {
            let menu = tray_menu(runtime, voice);
            assert!(
                menu.iter()
                    .find(|item| item.id == "diagnostics")
                    .unwrap()
                    .enabled
            );
            assert!(menu.iter().find(|item| item.id == "exit").unwrap().enabled);
        }
    }
}

#[test]
fn tray_menu_ids_are_stable_and_distinct() {
    let menu = tray_menu(RuntimeState::Ready, VoiceState::WakeReady);
    let ids: Vec<&str> = menu.iter().map(|item| item.id).collect();
    assert_eq!(
        ids,
        [
            "show",
            "hide",
            "wake",
            "textMode",
            "stop",
            "diagnostics",
            "exit"
        ]
    );
    let mut sorted = ids.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sorted.len(), ids.len());
    for item in &menu {
        let _: MenuItemSpec = *item;
    }
}

#[test]
fn parse_accelerator_accepts_valid_combinations() {
    let accel = parse_accelerator("Alt+Shift+J").expect("parses");
    assert_eq!(accel.modifiers, vec![Modifier::Alt, Modifier::Shift]);
    assert_eq!(accel.key, "J");
    assert_eq!(parse_accelerator("Ctrl+F1").unwrap().key, "F1");
    assert_eq!(parse_accelerator("Super+Space").unwrap().key, "Space");
    assert_eq!(parse_accelerator("Alt+Ctrl+9").unwrap().key, "9");
}

#[test]
fn parse_accelerator_reports_structured_errors() {
    assert_eq!(parse_accelerator(""), Err(AcceleratorError::Empty));
    assert_eq!(
        parse_accelerator("J"),
        Err(AcceleratorError::MissingModifier)
    );
    assert_eq!(parse_accelerator("Alt+"), Err(AcceleratorError::Empty));
    assert_eq!(
        parse_accelerator("Alt+J+K"),
        Err(AcceleratorError::TooManyKeys)
    );
    assert_eq!(
        parse_accelerator("Alt+~"),
        Err(AcceleratorError::InvalidKey)
    );
    assert_eq!(
        parse_accelerator("Shift+NotAKey"),
        Err(AcceleratorError::InvalidKey)
    );
}

#[test]
fn accelerator_formatting_round_trips() {
    for sample in ["Alt+Shift+J", "Ctrl+F1", "Alt+Ctrl+9", "Super+Space"] {
        let parsed = parse_accelerator(sample).unwrap();
        assert_eq!(format_accelerator(&parsed), sample);
        let again = parse_accelerator(&format_accelerator(&parsed)).unwrap();
        assert_eq!(again, parsed);
    }
}

#[test]
fn accelerator_conflicts_are_decidable() {
    let reserved = [parse_accelerator("Ctrl+Shift+J").unwrap()];
    assert!(has_conflict(
        &parse_accelerator("Ctrl+Shift+J").unwrap(),
        &reserved
    ));
    assert!(
        has_conflict(&parse_accelerator("Shift+Ctrl+J").unwrap(), &reserved),
        "modifier order must not matter"
    );
    assert!(
        !has_conflict(&parse_accelerator("Ctrl+Shift+K").unwrap(), &reserved),
        "a different key must not conflict"
    );
    assert!(
        !has_conflict(&parse_accelerator("Ctrl+J").unwrap(), &reserved),
        "a different modifier set must not conflict"
    );
}

#[test]
fn reserved_accelerators_are_parseable_and_detectable() {
    let reserved = reserved_accelerators();
    assert!(!reserved.is_empty());
    for accel in &reserved {
        let formatted = format_accelerator(accel);
        assert_eq!(parse_accelerator(&formatted).unwrap(), *accel);
    }
    assert!(has_conflict(&reserved[0], &reserved));
}

#[test]
fn wake_entry_is_the_phase_two_single_entry() {
    assert_eq!(wake_entry(), VoiceEvent::WakeDetected);
    assert_eq!(
        voice_state_transition(VoiceState::WakeReady, wake_entry()),
        VoiceState::WakeDetected,
        "tray and hotkey must enter through the same WakeDetected event as the button"
    );
}
