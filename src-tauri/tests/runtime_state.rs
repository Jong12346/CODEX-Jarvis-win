//! P0-2 可执行规格：runtime 状态机与恢复策略。
//!
//! 固化同步点 0.5 确定的策略：意外退出立即失败在途请求、最多 3 次自动重启、
//! 退避 1/2/4 秒、稳定 60 秒清零、`Restarting` 期间不排队、超限进入 `Failed`、
//! 人工干预可开启新一轮、主动 shutdown 直达 `Absent` 且旧监视任务不得触发重启。
//!
//! 激活前提（`#[doc(hidden)] pub`）：
//!
//! ```ignore
//! pub enum RuntimeState { Absent, Starting, Ready, Degraded, Dead, Restarting, Failed }
//! pub enum RuntimeEvent {
//!     SpawnOk, SpawnErr, InitializeOk, InitializeErr, ThreadReady,
//!     StdoutEof, ChildExited { code: Option<i32> },
//!     RestartScheduled, RestartExhausted, StableIntervalElapsed,
//!     ManualRetry, ShutdownRequested,
//! }
//! pub fn runtime_state_transition(current: RuntimeState, event: RuntimeEvent) -> RuntimeState;
//!
//! pub const MAX_AUTO_RESTARTS: u32 = 3;
//! pub fn restart_backoff(attempt: u32) -> Option<Duration>;
//! pub fn stability_reset_interval() -> Duration;
//!
//! pub enum RequestRejection { RuntimeAbsent, RuntimeExited, RuntimeRestarting, RuntimeFailed }
//! impl RequestRejection { pub fn code(&self) -> &'static str; }
//! pub fn request_rejection(state: RuntimeState) -> Option<RequestRejection>;
//!
//! pub struct RuntimeGeneration(pub u64);
//! pub fn should_watcher_restart(
//!     watcher: RuntimeGeneration, current: RuntimeGeneration, state: RuntimeState,
//! ) -> bool;
//! ```

use std::time::Duration;

use jarvis_codex_lib::{
    request_rejection, restart_backoff, runtime_state_transition, should_watcher_restart,
    stability_reset_interval, RequestRejection, RuntimeEvent, RuntimeGeneration, RuntimeState,
    MAX_AUTO_RESTARTS,
};

const ALL_STATES: [RuntimeState; 7] = [
    RuntimeState::Absent,
    RuntimeState::Starting,
    RuntimeState::Ready,
    RuntimeState::Degraded,
    RuntimeState::Dead,
    RuntimeState::Restarting,
    RuntimeState::Failed,
];

// ---------------------------------------------------------------- 核心缺陷回归

#[test]
fn stdout_eof_must_move_a_ready_runtime_out_of_ready() {
    // 这是 P0-2 本身。当前实现的 stdout 读取任务在 EOF 后直接结束，
    // 不改变任何状态，于是界面继续报告已连接。
    assert_eq!(
        runtime_state_transition(RuntimeState::Ready, RuntimeEvent::StdoutEof),
        RuntimeState::Dead,
    );
}

#[test]
fn child_exit_must_move_a_ready_runtime_out_of_ready() {
    for code in [Some(0), Some(1), Some(-1), None] {
        assert_eq!(
            runtime_state_transition(RuntimeState::Ready, RuntimeEvent::ChildExited { code }),
            RuntimeState::Dead,
            "exit code {code:?} must still be observed as death",
        );
    }
}

#[test]
fn no_state_reports_ready_after_a_terminal_observation() {
    // 兜底不变量：任何状态收到 EOF 或退出后都不得停留在 Ready。
    for state in ALL_STATES {
        for event in [
            RuntimeEvent::StdoutEof,
            RuntimeEvent::ChildExited { code: Some(1) },
        ] {
            assert_ne!(
                runtime_state_transition(state, event),
                RuntimeState::Ready,
                "{state:?} + {event:?} left the runtime claiming readiness",
            );
        }
    }
}

// ------------------------------------------------------------ 清理只发生一次

#[test]
fn terminal_observations_are_idempotent() {
    // stdout EOF 与 child exit 对同一个 runtime 会先后到达；
    // 两者只允许清理一次，因此状态迁移必须幂等。
    let after_eof = runtime_state_transition(RuntimeState::Ready, RuntimeEvent::StdoutEof);
    assert_eq!(
        runtime_state_transition(after_eof, RuntimeEvent::ChildExited { code: Some(1) }),
        RuntimeState::Dead,
        "the second observation must not advance the machine",
    );
    assert_eq!(
        runtime_state_transition(after_eof, RuntimeEvent::StdoutEof),
        RuntimeState::Dead,
    );
}

#[test]
fn death_never_schedules_its_own_restart() {
    // 重启必须由显式的 RestartScheduled 驱动，否则两条终止观测会各自
    // 触发一次重启，产生双 spawn。
    assert_eq!(
        runtime_state_transition(RuntimeState::Dead, RuntimeEvent::ChildExited { code: None }),
        RuntimeState::Dead,
    );
    assert_ne!(
        runtime_state_transition(RuntimeState::Dead, RuntimeEvent::StdoutEof),
        RuntimeState::Restarting,
    );
}

// ------------------------------------------------------------------ 正常路径

#[test]
fn the_happy_path_reaches_ready() {
    let state = runtime_state_transition(RuntimeState::Absent, RuntimeEvent::SpawnOk);
    assert_eq!(state, RuntimeState::Starting);
    let state = runtime_state_transition(state, RuntimeEvent::InitializeOk);
    let state = runtime_state_transition(state, RuntimeEvent::ThreadReady);
    assert_eq!(state, RuntimeState::Ready);
}

#[test]
fn a_failed_handshake_on_a_live_child_is_degraded_not_dead() {
    // 区分"进程活着但握手失败"与"进程已死"。两者的恢复动作不同。
    let state = runtime_state_transition(RuntimeState::Starting, RuntimeEvent::InitializeErr);
    assert_eq!(state, RuntimeState::Degraded);
    assert_eq!(
        runtime_state_transition(state, RuntimeEvent::ChildExited { code: Some(1) }),
        RuntimeState::Dead,
    );
}

#[test]
fn spawn_failure_does_not_pretend_a_process_exists() {
    assert_eq!(
        runtime_state_transition(RuntimeState::Absent, RuntimeEvent::SpawnErr),
        RuntimeState::Failed,
    );
}

#[test]
fn the_restart_cycle_is_dead_restarting_starting() {
    let state = runtime_state_transition(RuntimeState::Dead, RuntimeEvent::RestartScheduled);
    assert_eq!(state, RuntimeState::Restarting);
    assert_eq!(
        runtime_state_transition(state, RuntimeEvent::SpawnOk),
        RuntimeState::Starting,
    );
}

// ------------------------------------------------------------------ 重启策略

#[test]
fn the_backoff_schedule_is_exactly_one_two_four_seconds() {
    assert_eq!(restart_backoff(1), Some(Duration::from_secs(1)));
    assert_eq!(restart_backoff(2), Some(Duration::from_secs(2)));
    assert_eq!(restart_backoff(3), Some(Duration::from_secs(4)));
}

#[test]
fn the_backoff_schedule_ends_after_the_limit() {
    assert_eq!(MAX_AUTO_RESTARTS, 3);
    for attempt in [MAX_AUTO_RESTARTS + 1, MAX_AUTO_RESTARTS + 2, 99] {
        assert_eq!(
            restart_backoff(attempt),
            None,
            "attempt {attempt} is past the limit and must not be scheduled",
        );
    }
}

#[test]
fn the_backoff_schedule_is_monotonic() {
    let delays = (1..=MAX_AUTO_RESTARTS)
        .map(|attempt| restart_backoff(attempt).expect("within the limit"))
        .collect::<Vec<_>>();
    assert!(
        delays.windows(2).all(|pair| pair[1] > pair[0]),
        "backoff must strictly increase, got {delays:?}",
    );
}

#[test]
fn exhausting_the_restarts_reaches_a_terminal_failed_state() {
    let state = runtime_state_transition(RuntimeState::Restarting, RuntimeEvent::RestartExhausted);
    assert_eq!(state, RuntimeState::Failed);
    // Failed 是终态：后续的终止观测不得重新开启自动重启。
    for event in [
        RuntimeEvent::StdoutEof,
        RuntimeEvent::ChildExited { code: Some(1) },
        RuntimeEvent::RestartScheduled,
    ] {
        assert_eq!(
            runtime_state_transition(RuntimeState::Failed, event),
            RuntimeState::Failed,
            "{event:?} must not revive a failed runtime automatically",
        );
    }
}

#[test]
fn manual_intervention_can_leave_the_failed_state() {
    // 用户再次点击文字执行、Voice 或明确重试，视为人工干预。
    assert_eq!(
        runtime_state_transition(RuntimeState::Failed, RuntimeEvent::ManualRetry),
        RuntimeState::Starting,
    );
}

#[test]
fn the_stability_window_is_sixty_seconds() {
    assert_eq!(stability_reset_interval(), Duration::from_secs(60));
}

#[test]
fn a_stable_interval_keeps_the_runtime_ready() {
    // 连续稳定 Ready 60 秒只清零重启计数，不改变状态。
    assert_eq!(
        runtime_state_transition(RuntimeState::Ready, RuntimeEvent::StableIntervalElapsed),
        RuntimeState::Ready,
    );
}

// -------------------------------------------------------------- 在途请求语义

#[test]
fn a_dead_runtime_fails_requests_immediately_with_runtime_exited() {
    // 修复前的症状是走满 90 秒 timeout。错误码必须可与真实超时区分。
    let rejection = request_rejection(RuntimeState::Dead).expect("a dead runtime rejects requests");
    assert_eq!(rejection.code(), "runtime_exited");
    assert_eq!(rejection, RequestRejection::RuntimeExited);
}

#[test]
fn a_restarting_runtime_rejects_rather_than_queues() {
    let rejection =
        request_rejection(RuntimeState::Restarting).expect("a restarting runtime rejects requests");
    assert_eq!(rejection.code(), "runtime_restarting");
    assert_eq!(rejection, RequestRejection::RuntimeRestarting);
}

#[test]
fn only_ready_accepts_requests() {
    assert!(
        request_rejection(RuntimeState::Ready).is_none(),
        "Ready must accept requests",
    );
    for state in ALL_STATES
        .into_iter()
        .filter(|state| *state != RuntimeState::Ready)
    {
        assert!(
            request_rejection(state).is_some(),
            "{state:?} must reject requests instead of letting them hang",
        );
    }
}

#[test]
fn rejection_codes_are_stable_and_distinct() {
    // 前端与实机验收脚本按字符串匹配这些码，它们属于契约。
    let codes = [
        RequestRejection::RuntimeAbsent.code(),
        RequestRejection::RuntimeExited.code(),
        RequestRejection::RuntimeRestarting.code(),
        RequestRejection::RuntimeFailed.code(),
    ];
    assert_eq!(
        codes,
        [
            "runtime_absent",
            "runtime_exited",
            "runtime_restarting",
            "runtime_failed"
        ]
    );
    let mut sorted = codes.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(
        sorted.len(),
        codes.len(),
        "rejection codes must be distinct"
    );
}

// ---------------------------------------------------- shutdown 与代际竞态

#[test]
fn shutdown_goes_straight_to_absent_from_any_state() {
    for state in ALL_STATES {
        assert_eq!(
            runtime_state_transition(state, RuntimeEvent::ShutdownRequested),
            RuntimeState::Absent,
            "shutdown from {state:?} must not be blocked or deferred",
        );
    }
}

#[test]
fn a_stale_watcher_never_restarts_a_replaced_runtime() {
    // 主动 shutdown 后旧监视任务仍会观测到 EOF。若它据此重启，
    // 就会在用户已经停止 Jarvis 之后复活一个 app-server。
    assert!(
        !should_watcher_restart(
            RuntimeGeneration(1),
            RuntimeGeneration(2),
            RuntimeState::Dead
        ),
        "generation 1 watcher must not act after generation 2 took over",
    );
    assert!(
        !should_watcher_restart(
            RuntimeGeneration(1),
            RuntimeGeneration(1),
            RuntimeState::Absent
        ),
        "a deliberately shut-down runtime must stay down",
    );
}

#[test]
fn the_current_watcher_may_restart_its_own_dead_runtime() {
    assert!(should_watcher_restart(
        RuntimeGeneration(7),
        RuntimeGeneration(7),
        RuntimeState::Dead,
    ));
}

#[test]
fn a_watcher_never_restarts_from_a_non_dead_state() {
    for state in ALL_STATES
        .into_iter()
        .filter(|state| *state != RuntimeState::Dead)
    {
        assert!(
            !should_watcher_restart(RuntimeGeneration(3), RuntimeGeneration(3), state),
            "{state:?} is not a restartable observation",
        );
    }
}
