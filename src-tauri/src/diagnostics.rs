use serde::Serialize;

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VerdictLevel {
    Green,
    Yellow,
    Red,
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    pub level: VerdictLevel,
    pub code: &'static str,
    pub message_zh: &'static str,
    pub suggested_action_zh: &'static str,
}

#[doc(hidden)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeResult {
    Ok,
    CodexMissing,
    CodexNotLoggedIn,
    ProxyUnreachable,
    TlsError,
    NetworkTimeout,
    MicDenied,
    SpeechPackMissing,
    WebView2Missing,
    WorkspaceUnreadable,
}

/// 每类故障映射到稳定且互异的 code，前端与复审按字符串匹配。
#[doc(hidden)]
pub fn classify(result: ProbeResult) -> Verdict {
    match result {
        ProbeResult::Ok => Verdict {
            level: VerdictLevel::Green,
            code: "ok",
            message_zh: "环境检查正常",
            suggested_action_zh: "无需处理",
        },
        ProbeResult::CodexMissing => Verdict {
            level: VerdictLevel::Red,
            code: "codex_missing",
            message_zh: "未找到 Codex 可执行文件",
            suggested_action_zh: "安装 Codex，或在设置中手动选择 codex.exe 的完整路径",
        },
        ProbeResult::CodexNotLoggedIn => Verdict {
            level: VerdictLevel::Red,
            code: "codex_not_logged_in",
            message_zh: "Codex 未登录或登录已失效",
            suggested_action_zh: "在官方 Codex 中重新登录后重试",
        },
        ProbeResult::ProxyUnreachable => Verdict {
            level: VerdictLevel::Yellow,
            code: "proxy_unreachable",
            message_zh: "系统代理不可达",
            suggested_action_zh:
                "检查代理地址与端口，或临时关闭代理后重试；可直接降级到同 thread 文字任务",
        },
        ProbeResult::TlsError => Verdict {
            level: VerdictLevel::Yellow,
            code: "tls_error",
            message_zh: "网络 TLS 握手失败",
            suggested_action_zh:
                "检查代理、防火墙或 VPN 对 HTTPS 的影响；可直接降级到同 thread 文字任务",
        },
        ProbeResult::NetworkTimeout => Verdict {
            level: VerdictLevel::Yellow,
            code: "network_timeout",
            message_zh: "网络连接超时",
            suggested_action_zh: "检查网络与 VPN；可直接降级到同 thread 文字任务",
        },
        ProbeResult::MicDenied => Verdict {
            level: VerdictLevel::Yellow,
            code: "mic_denied",
            message_zh: "系统未授予 Jarvis 麦克风权限",
            suggested_action_zh:
                "在 设置 → 隐私 → 麦克风 中允许 Jarvis；可直接降级到同 thread 文字任务",
        },
        ProbeResult::SpeechPackMissing => Verdict {
            level: VerdictLevel::Yellow,
            code: "speech_pack_missing",
            message_zh: "缺少 Windows 语音识别语言包",
            suggested_action_zh: "安装中文或英文语音识别语言包；可直接降级到同 thread 文字任务",
        },
        ProbeResult::WebView2Missing => Verdict {
            level: VerdictLevel::Red,
            code: "webview2_missing",
            message_zh: "缺少 WebView2 Runtime",
            suggested_action_zh: "安装 WebView2 Runtime，或使用安装包附带的引导程序",
        },
        ProbeResult::WorkspaceUnreadable => Verdict {
            level: VerdictLevel::Red,
            code: "workspace_unreadable",
            message_zh: "工作目录不存在或不可读",
            suggested_action_zh: "在设置中选择一个可读的工作目录",
        },
    }
}

/// Windows microphone privacy decision: denied when the master
/// switch, the desktop-apps switch, or a Jarvis-specific entry is Deny.
/// Pure function: inputs are injected by the integration layer so the
/// decision is testable on any platform.
#[doc(hidden)]
pub fn mic_consent_denied(
    master: Option<&str>,
    non_packaged: Option<&str>,
    jarvis_entries: &[(&str, Option<&str>)],
) -> bool {
    let denied = |value: Option<&str>| value.is_some_and(|text| text.eq_ignore_ascii_case("Deny"));
    denied(master)
        || denied(non_packaged)
        || jarvis_entries
            .iter()
            .any(|(name, value)| name.to_ascii_lowercase().contains("jarvis") && denied(*value))
}

/// 脱敏：登录令牌、代理口令、敏感环境变量值、绝对路径中的用户名段。
#[doc(hidden)]
pub fn redact(text: &str) -> String {
    let mut out = redact_bearer(text);
    out = redact_openai_keys(&out);
    out = redact_url_userinfo(&out);
    out = redact_sensitive_env(&out);
    redact_user_segments(&out)
}

fn token_end(text: &str, from: usize) -> usize {
    let mut end = from;
    for (idx, ch) in text[from..].char_indices() {
        if matches!(
            ch,
            ' ' | '\t' | '\r' | '\n' | ',' | ';' | '"' | '\'' | '<' | '>' | '&' | '=' | '@'
        ) {
            break;
        }
        end = from + idx + ch.len_utf8();
    }
    end
}

fn redact_bearer(text: &str) -> String {
    let mut out = text.to_owned();
    let mut search = 0usize;
    while let Some(rel) = out[search..].to_ascii_lowercase().find("bearer ") {
        let token_start = search + rel + 7;
        let end = token_end(&out, token_start);
        if end > token_start {
            out.replace_range(token_start..end, "<redacted>");
            search = token_start + "<redacted>".len();
        } else {
            search = token_start;
        }
        if search >= out.len() {
            break;
        }
    }
    out
}

fn redact_openai_keys(text: &str) -> String {
    let mut out = text.to_owned();
    let mut search = 0usize;
    while let Some(rel) = out[search..].find("sk-") {
        let key_start = search + rel;
        let preceded_by_word = key_start > 0
            && out[..key_start]
                .chars()
                .next_back()
                .is_some_and(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-');
        if preceded_by_word {
            search = key_start + 3;
            continue;
        }
        let end = token_end(&out, key_start);
        if end > key_start + 3 {
            out.replace_range(key_start + 3..end, "<redacted>");
            search = key_start + 3 + "<redacted>".len();
        } else {
            search = key_start + 3;
        }
        if search >= out.len() {
            break;
        }
    }
    out
}

fn redact_url_userinfo(text: &str) -> String {
    let mut out = text.to_owned();
    let mut search = 0usize;
    while let Some(rel) = out[search..].find("://") {
        let scheme_end = search + rel + 3;
        let mut at = None;
        let mut colon = None;
        for (idx, ch) in out[scheme_end..].char_indices() {
            let abs = scheme_end + idx;
            match ch {
                '/' | '?' | '#' | ' ' | '\t' | '\r' | '\n' | ';' | '"' | '\'' => break,
                '@' => {
                    at = Some(abs);
                    break;
                }
                ':' if colon.is_none() => colon = Some(abs),
                _ => {}
            }
        }
        if let (Some(at), Some(colon)) = (at, colon) {
            if colon < at {
                out.replace_range(scheme_end..at, "<redacted>");
                search = scheme_end + "<redacted>".len() + 1;
                continue;
            }
        }
        search = scheme_end;
        if search >= out.len() {
            break;
        }
    }
    out
}

fn redact_sensitive_env(text: &str) -> String {
    const MARKERS: [&str; 7] = [
        "TOKEN",
        "PASSWORD",
        "PASSWD",
        "SECRET",
        "API_KEY",
        "CREDENTIAL",
        "AUTH",
    ];
    let mut out = text.to_owned();
    let mut search = 0usize;
    while let Some(rel) = out[search..].find('=') {
        let eq = search + rel;
        let mut name_start = eq;
        while name_start > 0 {
            let prev = out[..name_start].chars().next_back().unwrap();
            if prev.is_ascii_alphanumeric() || prev == '_' {
                name_start -= prev.len_utf8();
            } else {
                break;
            }
        }
        let upper = out[name_start..eq].to_ascii_uppercase();
        if MARKERS.iter().any(|marker| upper.contains(marker)) {
            let value_start = eq + 1;
            let value_end = token_end(&out, value_start);
            if value_end > value_start {
                out.replace_range(value_start..value_end, "<redacted>");
                search = value_start + "<redacted>".len();
                continue;
            }
        }
        search = eq + 1;
        if search >= out.len() {
            break;
        }
    }
    out
}

fn redact_user_segments(text: &str) -> String {
    let mut out = text.to_owned();
    let mut search = 0usize;
    loop {
        let lower = out[search..].to_ascii_lowercase();
        let candidates = [
            (lower.find("\\users\\"), 7usize),
            (lower.find("/users/"), 7usize),
            (lower.find("/home/"), 6usize),
        ];
        let Some((rel, prefix_len)) = candidates
            .into_iter()
            .filter_map(|(pos, len)| pos.map(|pos| (pos, len)))
            .min_by_key(|(pos, _)| *pos)
        else {
            break;
        };
        let seg_start = search + rel + prefix_len;
        let mut seg_end = seg_start;
        for (idx, ch) in out[seg_start..].char_indices() {
            if ch == '\\' || ch == '/' {
                break;
            }
            seg_end = seg_start + idx + ch.len_utf8();
        }
        if seg_end > seg_start {
            out.replace_range(seg_start..seg_end, "<user>");
            search = seg_start + "<user>".len();
        } else {
            search = seg_start;
        }
        if search >= out.len() {
            break;
        }
    }
    out
}

/// 日志轮转计划：保留最新文件（永不被删），从新到旧累计直到 max_bytes 上限，
/// 其余最旧文件进入删除列表。
#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LogFileInfo {
    pub name: String,
    pub size_bytes: u64,
    pub modified_ms: u64,
}

#[doc(hidden)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RotatePlan {
    pub keep: Vec<String>,
    pub delete: Vec<String>,
}

#[doc(hidden)]
pub fn rotate_plan(files: Vec<LogFileInfo>, max_bytes: u64) -> RotatePlan {
    let mut sorted = files;
    sorted.sort_by(|a, b| {
        a.modified_ms
            .cmp(&b.modified_ms)
            .then_with(|| a.name.cmp(&b.name))
    });
    let mut keep = Vec::new();
    let mut total = 0u64;
    for file in sorted.iter().rev() {
        if keep.is_empty() || total.saturating_add(file.size_bytes) <= max_bytes {
            keep.push(file.name.clone());
            total = total.saturating_add(file.size_bytes);
        } else {
            break;
        }
    }
    let delete = sorted
        .into_iter()
        .map(|file| file.name)
        .filter(|name| !keep.contains(name))
        .collect();
    RotatePlan { keep, delete }
}
