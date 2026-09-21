use serde::Serialize;
use std::time::Duration;

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeState {
    Absent,
    Starting,
    Ready,
    Degraded,
    Dead,
    Restarting,
    Failed,
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuntimeEvent {
    SpawnOk,
    SpawnErr,
    InitializeOk,
    InitializeErr,
    ThreadReady,
    StdoutEof,
    ChildExited { code: Option<i32> },
    RestartScheduled,
    RestartExhausted,
    StableIntervalElapsed,
    ManualRetry,
    ShutdownRequested,
}

impl RuntimeEvent {
    pub(crate) const fn trigger(self) -> &'static str {
        match self {
            Self::SpawnOk => "spawn_ok",
            Self::SpawnErr => "spawn_error",
            Self::InitializeOk => "initialize_ok",
            Self::InitializeErr => "initialize_error",
            Self::ThreadReady => "thread_ready",
            Self::StdoutEof => "stdout_eof",
            Self::ChildExited { .. } => "child_exited",
            Self::RestartScheduled => "restart_scheduled",
            Self::RestartExhausted => "restart_exhausted",
            Self::StableIntervalElapsed => "stable_interval_elapsed",
            Self::ManualRetry => "manual_retry",
            Self::ShutdownRequested => "shutdown_requested",
        }
    }
}

#[doc(hidden)]
pub fn runtime_state_transition(current: RuntimeState, event: RuntimeEvent) -> RuntimeState {
    if event == RuntimeEvent::ShutdownRequested {
        return RuntimeState::Absent;
    }
    if current == RuntimeState::Failed {
        return if event == RuntimeEvent::ManualRetry {
            RuntimeState::Starting
        } else {
            RuntimeState::Failed
        };
    }
    if current == RuntimeState::Absent
        && matches!(
            event,
            RuntimeEvent::StdoutEof | RuntimeEvent::ChildExited { .. }
        )
    {
        return RuntimeState::Absent;
    }
    if matches!(
        event,
        RuntimeEvent::StdoutEof | RuntimeEvent::ChildExited { .. }
    ) {
        return RuntimeState::Dead;
    }

    match event {
        RuntimeEvent::SpawnOk => match current {
            RuntimeState::Absent | RuntimeState::Restarting | RuntimeState::Starting => {
                RuntimeState::Starting
            }
            _ => current,
        },
        RuntimeEvent::SpawnErr => match current {
            RuntimeState::Restarting => RuntimeState::Dead,
            _ => RuntimeState::Failed,
        },
        RuntimeEvent::InitializeOk => current,
        RuntimeEvent::InitializeErr => RuntimeState::Degraded,
        RuntimeEvent::ThreadReady => RuntimeState::Ready,
        RuntimeEvent::RestartScheduled if current == RuntimeState::Dead => RuntimeState::Restarting,
        RuntimeEvent::RestartExhausted => RuntimeState::Failed,
        RuntimeEvent::StableIntervalElapsed => current,
        RuntimeEvent::ManualRetry => match current {
            RuntimeState::Absent
            | RuntimeState::Dead
            | RuntimeState::Degraded
            | RuntimeState::Failed => RuntimeState::Starting,
            _ => current,
        },
        RuntimeEvent::ShutdownRequested
        | RuntimeEvent::StdoutEof
        | RuntimeEvent::ChildExited { .. }
        | RuntimeEvent::RestartScheduled => current,
    }
}

#[doc(hidden)]
pub const MAX_AUTO_RESTARTS: u32 = 3;

#[doc(hidden)]
pub fn restart_backoff(attempt: u32) -> Option<Duration> {
    match attempt {
        1 => Some(Duration::from_secs(1)),
        2 => Some(Duration::from_secs(2)),
        3 => Some(Duration::from_secs(4)),
        _ => None,
    }
}

#[doc(hidden)]
pub fn stability_reset_interval() -> Duration {
    Duration::from_secs(60)
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequestRejection {
    RuntimeAbsent,
    RuntimeExited,
    RuntimeRestarting,
    RuntimeFailed,
}

impl RequestRejection {
    #[doc(hidden)]
    pub const fn code(self) -> &'static str {
        match self {
            Self::RuntimeAbsent => "runtime_absent",
            Self::RuntimeExited => "runtime_exited",
            Self::RuntimeRestarting => "runtime_restarting",
            Self::RuntimeFailed => "runtime_failed",
        }
    }
}

#[doc(hidden)]
pub fn request_rejection(state: RuntimeState) -> Option<RequestRejection> {
    match state {
        RuntimeState::Ready => None,
        RuntimeState::Dead => Some(RequestRejection::RuntimeExited),
        RuntimeState::Restarting => Some(RequestRejection::RuntimeRestarting),
        RuntimeState::Failed => Some(RequestRejection::RuntimeFailed),
        RuntimeState::Absent | RuntimeState::Starting | RuntimeState::Degraded => {
            Some(RequestRejection::RuntimeAbsent)
        }
    }
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuntimeGeneration(pub u64);

#[doc(hidden)]
pub fn should_watcher_restart(
    watcher: RuntimeGeneration,
    current: RuntimeGeneration,
    state: RuntimeState,
) -> bool {
    watcher == current && state == RuntimeState::Dead
}
