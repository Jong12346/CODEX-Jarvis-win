use serde::{Deserialize, Serialize};
use std::time::Duration;

#[doc(hidden)]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StopAction {
    SendRealtimeStop,
    SendTurnInterrupt,
    WaitGrace,
    KillJobTree,
    Rebuild,
    Done,
}

impl StopAction {
    #[doc(hidden)]
    pub const fn trigger(self) -> &'static str {
        match self {
            Self::SendRealtimeStop => "sendRealtimeStop",
            Self::SendTurnInterrupt => "sendTurnInterrupt",
            Self::WaitGrace => "waitGrace",
            Self::KillJobTree => "killJobTree",
            Self::Rebuild => "rebuild",
            Self::Done => "done",
        }
    }
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StopStep {
    Start,
    RealtimeStopSent,
    TurnInterruptSent,
    GraceWaiting,
    KillIssued,
    RebuildDone,
}

/// 短宽限期：realtime/stop 与 turn/interrupt 发出后，给子进程自行退出的时间。
/// 只有宽限期已过且子进程仍存活，才允许 KillJobTree。
#[doc(hidden)]
pub const STOP_GRACE: Duration = Duration::from_secs(2);

/// 纯决策：给定当前步、子进程存活与宽限期是否已过，返回下一步动作。
/// 未匹配的组合一律返回当前语义下的保守选择，绝不跳步。
#[doc(hidden)]
pub fn next_stop_action(step: StopStep, child_alive: bool, grace_elapsed: bool) -> StopAction {
    match (step, child_alive, grace_elapsed) {
        (StopStep::Start, _, _) => StopAction::SendRealtimeStop,
        (StopStep::RealtimeStopSent, _, _) => StopAction::SendTurnInterrupt,
        (StopStep::TurnInterruptSent, _, _) => StopAction::WaitGrace,
        (StopStep::GraceWaiting, true, false) => StopAction::WaitGrace,
        (StopStep::GraceWaiting, true, true) => StopAction::KillJobTree,
        (StopStep::GraceWaiting, false, _) => StopAction::Rebuild,
        (StopStep::KillIssued, true, _) => StopAction::KillJobTree,
        (StopStep::KillIssued, false, _) => StopAction::Rebuild,
        (StopStep::RebuildDone, _, _) => StopAction::Done,
    }
}

/// 动作完成后推进步骤；不匹配的组合保持不变（不破坏状态）。
#[doc(hidden)]
pub fn advance_stop_step(step: StopStep, action: StopAction) -> StopStep {
    match (step, action) {
        (StopStep::Start, StopAction::SendRealtimeStop) => StopStep::RealtimeStopSent,
        (StopStep::RealtimeStopSent, StopAction::SendTurnInterrupt) => StopStep::TurnInterruptSent,
        (StopStep::TurnInterruptSent, StopAction::WaitGrace) => StopStep::GraceWaiting,
        (StopStep::GraceWaiting, StopAction::WaitGrace) => StopStep::GraceWaiting,
        (StopStep::GraceWaiting, StopAction::KillJobTree) => StopStep::KillIssued,
        (StopStep::GraceWaiting, StopAction::Rebuild) => StopStep::RebuildDone,
        (StopStep::KillIssued, StopAction::KillJobTree) => StopStep::KillIssued,
        (StopStep::KillIssued, StopAction::Rebuild) => StopStep::RebuildDone,
        (StopStep::RebuildDone, StopAction::Done) => StopStep::RebuildDone,
        _ => step,
    }
}

/// STOP 幂等：序列进行中重复触发一律丢弃；只有已完成的序列才允许重新开始。
#[doc(hidden)]
pub fn on_stop_triggered(step: StopStep) -> StopStep {
    match step {
        StopStep::RebuildDone => StopStep::Start,
        _ => step,
    }
}

/// 本 runtime Job Object 树的精确终止集合：只有 root pid 与已归属本树的
/// pid；任何其他进程（并发 Codex、终端、VS Code）都不在其中。
#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobTreeSnapshot {
    pub root_pid: Option<u32>,
    pub owned_pids: Vec<u32>,
}

#[doc(hidden)]
pub fn termination_targets(snapshot: &JobTreeSnapshot) -> Vec<u32> {
    let mut pids = snapshot.owned_pids.clone();
    if let Some(root) = snapshot.root_pid {
        if !pids.contains(&root) {
            pids.push(root);
        }
    }
    pids.sort_unstable();
    pids.dedup();
    pids
}
