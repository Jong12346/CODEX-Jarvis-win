//! 实机日志校验器：用真实纯状态机回放 jarvis-runtime.jsonl。
//!
//! 用法：
//!   cargo run --manifest-path src-tauri/Cargo.toml --example verify_log -- <jarvis-runtime.jsonl>
//!
//! 校验两件事：
//! 1. jarvis.voice.state_transition 的 from/trigger/to 必须与
//!    voice_state_transition 完全一致（非法迁移会被标出）。
//! 2. jarvis.stop_sequence.action 的 step/action/childAlive/graceElapsed 必须与
//!    next_stop_action 完全一致（跳步/提前杀树会被标出）。
//!
//! 退出码：0 = 全部通过；1 = 存在违规；2 = 文件无法读取。

use jarvis_codex_lib::{
    next_stop_action, voice_state_transition, StopAction, StopStep, VoiceEvent, VoiceState,
};
use serde_json::Value;

fn main() {
    let path = std::env::args()
        .nth(1)
        .or_else(|| std::env::var("JARVIS_LOG_PATH").ok())
        .unwrap_or_else(|| "jarvis-runtime.jsonl".to_owned());
    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) => {
            eprintln!("无法读取 {path}: {error}");
            std::process::exit(2);
        }
    };
    let mut voice_lines = 0usize;
    let mut stop_lines = 0usize;
    let mut violations = 0usize;
    for (index, line) in content.lines().enumerate() {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(event_name) = record.get("event").and_then(Value::as_str) else {
            continue;
        };
        match event_name {
            "jarvis.voice.state_transition" => {
                voice_lines += 1;
                let Some(trigger) = record.get("trigger").and_then(Value::as_str) else {
                    continue;
                };
                let Some(event) = VoiceEvent::from_trigger(trigger) else {
                    violations += 1;
                    println!("第 {} 行：未知 trigger `{trigger}`", index + 1);
                    continue;
                };
                let from = record
                    .get("from")
                    .and_then(|value| serde_json::from_value::<VoiceState>(value.clone()).ok())
                    .unwrap_or(VoiceState::Booting);
                let to = record
                    .get("to")
                    .and_then(|value| serde_json::from_value::<VoiceState>(value.clone()).ok())
                    .unwrap_or(VoiceState::Booting);
                let expected = voice_state_transition(from, event);
                if expected != to {
                    violations += 1;
                    println!(
                        "第 {} 行：非法 Voice 迁移 {from:?} --{event:?}--> 记录为 {to:?}，应为 {expected:?}",
                        index + 1
                    );
                }
            }
            "jarvis.stop_sequence.action" => {
                stop_lines += 1;
                let step = record
                    .get("step")
                    .and_then(|value| serde_json::from_value::<StopStep>(value.clone()).ok())
                    .unwrap_or(StopStep::Start);
                let action = record
                    .get("action")
                    .and_then(|value| serde_json::from_value::<StopAction>(value.clone()).ok())
                    .unwrap_or(StopAction::Done);
                let child_alive = record
                    .get("childAlive")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let grace_elapsed = record
                    .get("graceElapsed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let expected = next_stop_action(step, child_alive, grace_elapsed);
                if expected != action {
                    violations += 1;
                    println!(
                        "第 {} 行：非法 STOP 动作 step={step:?} alive={child_alive} grace={grace_elapsed} 记录为 {action:?}，应为 {expected:?}",
                        index + 1
                    );
                }
            }
            _ => {}
        }
    }
    println!("Voice 迁移 {voice_lines} 条，STOP 动作 {stop_lines} 条，违规 {violations} 条。");
    if violations > 0 {
        std::process::exit(1);
    }
}
