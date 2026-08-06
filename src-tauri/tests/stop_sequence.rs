//! Phase 3 contract: ordered STOP sequence with precise Job Object tree kill.
//!
//! Activation note (same as phases 1-2): this file lives here until the
//! symbols exist, then the implementation commit moves it into
//! src-tauri/tests/ with `git mv`. Everything is expressed through
//! #[doc(hidden)] pub pure types and pure functions so the suite runs on any
//! platform without real processes.
//!
//! Fixed decisions encoded here:
//! - The sequence never skips: KillJobTree may only be returned after
//!   SendRealtimeStop, SendTurnInterrupt and the grace wait.
//! - Precision ownership: termination_targets() returns exactly the pids of
//!   this runtime's job tree; pids belonging to another concurrent Codex are
//!   never included (TerminateJobObject kills the job, never by image name).
//! - STOP idempotency: a repeated trigger while a sequence is in progress is
//!   dropped (step unchanged, no error); only a completed sequence may start
//!   a fresh cycle.
//! - If the child exits during grace, KillJobTree is skipped and Rebuild runs.
//! - KillJobTree is re-issued while the tree is still alive, then Rebuild once
//!   it is gone; Done is terminal.

use jarvis_codex_lib::{
    advance_stop_step, next_stop_action, on_stop_triggered, termination_targets, JobTreeSnapshot,
    StopAction, StopStep, STOP_GRACE,
};
use std::time::Duration;

const IN_PROGRESS_STEPS: [StopStep; 5] = [
    StopStep::Start,
    StopStep::RealtimeStopSent,
    StopStep::TurnInterruptSent,
    StopStep::GraceWaiting,
    StopStep::KillIssued,
];

#[test]
fn starts_with_realtime_stop() {
    for alive in [false, true] {
        for grace in [false, true] {
            assert_eq!(
                next_stop_action(StopStep::Start, alive, grace),
                StopAction::SendRealtimeStop
            );
        }
    }
}

#[test]
fn realtime_stop_precedes_turn_interrupt() {
    assert_eq!(
        next_stop_action(StopStep::RealtimeStopSent, true, true),
        StopAction::SendTurnInterrupt
    );
    for grace in [false, true] {
        assert_ne!(
            next_stop_action(StopStep::Start, true, grace),
            StopAction::SendTurnInterrupt,
            "turn interrupt must not be sent before realtime/stop"
        );
    }
}

#[test]
fn kill_requires_the_full_prefix_and_grace() {
    for step in [
        StopStep::Start,
        StopStep::RealtimeStopSent,
        StopStep::TurnInterruptSent,
    ] {
        for alive in [false, true] {
            for grace in [false, true] {
                assert_ne!(
                    next_stop_action(step, alive, grace),
                    StopAction::KillJobTree,
                    "{step:?} must not jump to KillJobTree"
                );
            }
        }
    }
    assert_eq!(
        next_stop_action(StopStep::GraceWaiting, true, false),
        StopAction::WaitGrace,
        "grace must elapse before any kill"
    );
    assert_eq!(
        next_stop_action(StopStep::GraceWaiting, true, true),
        StopAction::KillJobTree
    );
}

#[test]
fn rebuild_never_skips_the_prefix() {
    for step in [
        StopStep::Start,
        StopStep::RealtimeStopSent,
        StopStep::TurnInterruptSent,
    ] {
        for alive in [false, true] {
            for grace in [false, true] {
                assert_ne!(
                    next_stop_action(step, alive, grace),
                    StopAction::Rebuild,
                    "{step:?} must not jump to Rebuild"
                );
            }
        }
    }
}

#[test]
fn grace_waits_until_elapsed() {
    let mut step = StopStep::TurnInterruptSent;
    step = advance_stop_step(step, next_stop_action(step, true, false));
    assert_eq!(step, StopStep::GraceWaiting);
    assert_eq!(
        next_stop_action(step, true, false),
        StopAction::WaitGrace,
        "still within grace, must keep waiting"
    );
    assert_eq!(
        next_stop_action(step, true, true),
        StopAction::KillJobTree,
        "grace elapsed with a live child, must kill"
    );
}

#[test]
fn self_exit_during_grace_skips_kill() {
    for grace in [false, true] {
        assert_eq!(
            next_stop_action(StopStep::GraceWaiting, false, grace),
            StopAction::Rebuild,
            "a child that exited during grace must skip KillJobTree"
        );
    }
}

#[test]
fn kill_is_reissued_while_alive() {
    for grace in [false, true] {
        assert_eq!(
            next_stop_action(StopStep::KillIssued, true, grace),
            StopAction::KillJobTree,
            "the tree is re-terminated until it is gone"
        );
    }
}

#[test]
fn kill_completion_rebuilds() {
    for grace in [false, true] {
        assert_eq!(
            next_stop_action(StopStep::KillIssued, false, grace),
            StopAction::Rebuild
        );
    }
}

#[test]
fn done_is_terminal_and_idempotent() {
    for alive in [false, true] {
        for grace in [false, true] {
            assert_eq!(
                next_stop_action(StopStep::RebuildDone, alive, grace),
                StopAction::Done
            );
        }
    }
}

#[test]
fn the_full_sequence_with_kill_is_ordered() {
    let mut actions = Vec::new();
    let mut step = StopStep::Start;
    let mut alive = true;
    let mut grace_elapsed = false;
    let mut wait_count = 0u32;
    let mut kill_count = 0u32;
    for _ in 0..12 {
        let action = next_stop_action(step, alive, grace_elapsed);
        actions.push(action);
        step = advance_stop_step(step, action);
        match action {
            StopAction::SendRealtimeStop | StopAction::SendTurnInterrupt => {}
            StopAction::WaitGrace => {
                wait_count += 1;
                if wait_count >= 2 {
                    grace_elapsed = true;
                }
            }
            StopAction::KillJobTree => {
                kill_count += 1;
                if kill_count >= 2 {
                    alive = false;
                }
            }
            StopAction::Rebuild => {}
            StopAction::Done => break,
        }
    }
    assert_eq!(
        actions,
        [
            StopAction::SendRealtimeStop,
            StopAction::SendTurnInterrupt,
            StopAction::WaitGrace,
            StopAction::WaitGrace,
            StopAction::KillJobTree,
            StopAction::KillJobTree,
            StopAction::Rebuild,
            StopAction::Done,
        ],
        "exact ordered sequence: stop, interrupt, grace, kill until dead, rebuild, done"
    );
}

#[test]
fn the_self_exit_sequence_never_kills() {
    let mut actions = Vec::new();
    let mut step = StopStep::Start;
    let mut alive = true;
    for _ in 0..8 {
        let action = next_stop_action(step, alive, true);
        actions.push(action);
        step = advance_stop_step(step, action);
        match action {
            StopAction::SendRealtimeStop | StopAction::SendTurnInterrupt => {}
            StopAction::WaitGrace => alive = false,
            StopAction::Rebuild => {}
            StopAction::Done => break,
            StopAction::KillJobTree => panic!("self-exit path must never kill"),
        }
    }
    assert_eq!(
        actions,
        [
            StopAction::SendRealtimeStop,
            StopAction::SendTurnInterrupt,
            StopAction::WaitGrace,
            StopAction::Rebuild,
            StopAction::Done,
        ]
    );
}

#[test]
fn repeated_trigger_is_idempotent() {
    for step in IN_PROGRESS_STEPS {
        assert_eq!(
            on_stop_triggered(step),
            step,
            "a repeated STOP while {step:?} must not reset or restart the sequence"
        );
    }
}

#[test]
fn completed_sequence_may_be_retriggered() {
    assert_eq!(
        on_stop_triggered(StopStep::RebuildDone),
        StopStep::Start,
        "only a completed sequence may begin a fresh cycle"
    );
}

#[test]
fn foreign_runtime_pids_never_enter_the_kill_set() {
    let snapshot = JobTreeSnapshot {
        root_pid: Some(10),
        owned_pids: vec![11, 12],
    };
    let targets = termination_targets(&snapshot);
    assert_eq!(targets, vec![10, 11, 12]);
    for foreign in [100u32, 101, 200, 300] {
        assert!(
            !targets.contains(&foreign),
            "a concurrent Codex / terminal pid ({foreign}) must never be terminated"
        );
    }
}

#[test]
fn root_pid_is_always_included() {
    assert_eq!(
        termination_targets(&JobTreeSnapshot {
            root_pid: Some(7),
            owned_pids: vec![],
        }),
        vec![7]
    );
    assert_eq!(
        termination_targets(&JobTreeSnapshot {
            root_pid: None,
            owned_pids: vec![],
        }),
        Vec::<u32>::new()
    );
}

#[test]
fn targets_are_sorted_and_deduplicated() {
    assert_eq!(
        termination_targets(&JobTreeSnapshot {
            root_pid: Some(1),
            owned_pids: vec![3, 1, 3],
        }),
        vec![1, 3]
    );
}

#[test]
fn grace_constant_is_two_seconds() {
    assert_eq!(STOP_GRACE, Duration::from_secs(2));
}

#[test]
fn action_triggers_are_stable() {
    assert_eq!(StopAction::SendRealtimeStop.trigger(), "sendRealtimeStop");
    assert_eq!(StopAction::SendTurnInterrupt.trigger(), "sendTurnInterrupt");
    assert_eq!(StopAction::WaitGrace.trigger(), "waitGrace");
    assert_eq!(StopAction::KillJobTree.trigger(), "killJobTree");
    assert_eq!(StopAction::Rebuild.trigger(), "rebuild");
    assert_eq!(StopAction::Done.trigger(), "done");
}

#[test]
fn advance_ignores_mismatched_actions() {
    assert_eq!(
        advance_stop_step(StopStep::Start, StopAction::KillJobTree),
        StopStep::Start,
        "a mismatched action must not corrupt the step"
    );
    assert_eq!(
        advance_stop_step(StopStep::RealtimeStopSent, StopAction::WaitGrace),
        StopStep::RealtimeStopSent
    );
}

#[test]
fn wait_grace_requires_interrupt_sent() {
    assert_eq!(
        next_stop_action(StopStep::TurnInterruptSent, true, true),
        StopAction::WaitGrace,
        "grace starts only after turn/interrupt has been sent"
    );
}
