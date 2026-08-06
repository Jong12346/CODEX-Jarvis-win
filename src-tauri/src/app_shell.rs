use crate::diagnostics::{classify, ProbeResult, VerdictLevel};
use crate::runtime_state::RuntimeState;
use crate::voice_state::{mic_owner, MicOwner, VoiceEvent, VoiceState};

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WizardStep {
    pub id: &'static str,
    pub status: VerdictLevel,
    pub blocking: bool,
}

const WIZARD_ORDER: [&str; 7] = [
    "windows",
    "webview2",
    "microphone",
    "speech_pack",
    "codex",
    "workspace",
    "network",
];

/// 向导步骤：复用 §7 classify，不重造分类；红阻塞、黄不阻塞、顺序稳定。
#[doc(hidden)]
pub fn wizard_steps(results: &[(&'static str, ProbeResult)]) -> Vec<WizardStep> {
    let mut steps: Vec<WizardStep> = results
        .iter()
        .map(|(id, result)| {
            let verdict = classify(*result);
            WizardStep {
                id,
                status: verdict.level,
                blocking: verdict.level == VerdictLevel::Red,
            }
        })
        .collect();
    steps.sort_by_key(|step| {
        WIZARD_ORDER
            .iter()
            .position(|id| *id == step.id)
            .unwrap_or(usize::MAX)
    });
    steps
}

#[doc(hidden)]
pub fn can_proceed(steps: &[WizardStep]) -> bool {
    !steps.iter().any(|step| step.blocking)
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MenuItemSpec {
    pub id: &'static str,
    pub enabled: bool,
}

/// 托盘菜单：状态到可用动作的纯映射；id 稳定互异。
#[doc(hidden)]
pub fn tray_menu(runtime_state: RuntimeState, voice_state: VoiceState) -> Vec<MenuItemSpec> {
    let voice_live = mic_owner(voice_state) == MicOwner::Voice;
    vec![
        MenuItemSpec {
            id: "show",
            enabled: true,
        },
        MenuItemSpec {
            id: "hide",
            enabled: true,
        },
        MenuItemSpec {
            id: "wake",
            enabled: !voice_live,
        },
        MenuItemSpec {
            id: "textMode",
            enabled: true,
        },
        MenuItemSpec {
            id: "stop",
            enabled: runtime_state == RuntimeState::Ready && voice_live,
        },
        MenuItemSpec {
            id: "diagnostics",
            enabled: true,
        },
        MenuItemSpec {
            id: "exit",
            enabled: true,
        },
    ]
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Modifier {
    Alt,
    Control,
    Shift,
    Super,
}

#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Accelerator {
    pub modifiers: Vec<Modifier>,
    pub key: String,
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AcceleratorError {
    Empty,
    MissingModifier,
    InvalidKey,
    TooManyKeys,
}

fn canonical_key(part: &str) -> Option<String> {
    let lower = part.to_ascii_lowercase();
    if part.len() == 1 {
        let ch = part.chars().next()?;
        if ch.is_ascii_alphanumeric() {
            return Some(ch.to_ascii_uppercase().to_string());
        }
        return None;
    }
    let named = [
        "space",
        "enter",
        "esc",
        "tab",
        "up",
        "down",
        "left",
        "right",
        "backspace",
        "delete",
    ];
    if named.contains(&lower.as_str()) {
        let mut chars = lower.chars();
        let first = chars.next().unwrap().to_ascii_uppercase();
        return Some(format!("{first}{}", chars.as_str()));
    }
    if lower.starts_with('f') && lower.len() >= 2 && lower.len() <= 3 {
        let number = lower[1..].parse::<u32>().ok()?;
        if (1..=12).contains(&number) {
            return Some(lower.to_ascii_uppercase());
        }
    }
    None
}

/// 解析 "Alt+Shift+J" 形式的快捷键；非法组合返回结构化错误。
#[doc(hidden)]
pub fn parse_accelerator(input: &str) -> Result<Accelerator, AcceleratorError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AcceleratorError::Empty);
    }
    let mut modifiers = Vec::new();
    let mut key: Option<String> = None;
    for part in trimmed.split('+') {
        let part = part.trim();
        if part.is_empty() {
            return Err(AcceleratorError::Empty);
        }
        let modifier = match part.to_ascii_lowercase().as_str() {
            "alt" => Some(Modifier::Alt),
            "ctrl" | "control" => Some(Modifier::Control),
            "shift" => Some(Modifier::Shift),
            "super" | "win" | "cmd" | "meta" => Some(Modifier::Super),
            _ => None,
        };
        if let Some(modifier) = modifier {
            if !modifiers.contains(&modifier) {
                modifiers.push(modifier);
            }
            continue;
        }
        if key.is_some() {
            return Err(AcceleratorError::TooManyKeys);
        }
        let Some(canonical) = canonical_key(part) else {
            return Err(AcceleratorError::InvalidKey);
        };
        key = Some(canonical);
    }
    if modifiers.is_empty() {
        return Err(AcceleratorError::MissingModifier);
    }
    let key = key.ok_or(AcceleratorError::Empty)?;
    modifiers.sort_unstable();
    Ok(Accelerator { modifiers, key })
}

#[doc(hidden)]
pub fn format_accelerator(accel: &Accelerator) -> String {
    let mut parts: Vec<String> = accel
        .modifiers
        .iter()
        .map(|modifier| match modifier {
            Modifier::Alt => "Alt",
            Modifier::Control => "Ctrl",
            Modifier::Shift => "Shift",
            Modifier::Super => "Super",
        })
        .map(str::to_owned)
        .collect();
    parts.push(accel.key.clone());
    parts.join("+")
}

#[doc(hidden)]
pub fn has_conflict(accel: &Accelerator, reserved: &[Accelerator]) -> bool {
    reserved.iter().any(|candidate| {
        candidate.key.eq_ignore_ascii_case(&accel.key) && candidate.modifiers == accel.modifiers
    })
}

/// Windows 系统保留快捷键（不可注册），用于冲突校验。
#[doc(hidden)]
pub fn reserved_accelerators() -> Vec<Accelerator> {
    ["Ctrl+Alt+Del", "Alt+F4", "Super+L"]
        .iter()
        .filter_map(|sample| parse_accelerator(sample).ok())
        .collect()
}

/// 托盘"唤醒"与全局快捷键共用的单一入口（与按钮一致）。
#[doc(hidden)]
pub fn wake_entry() -> VoiceEvent {
    VoiceEvent::WakeDetected
}
