//! VoiceProvider 契约测试（暂存，不参与 cargo 编译）。
//!
//! 本文件是阶段七步骤②的可执行规格（docs/cn-friendly/PROVIDER_DESIGN.md §9）。
//! 暂存于 tests/contract/ 的原因见 tests/contract/README.md：符号未就位前进入
//! src-tauri/tests/ 会让 fmt/clippy 连带编译失败。实现落地时与引入符号的提交
//! 一起 git mv 至 src-tauri/tests/voice_provider.rs。
//!
//! 依赖符号（须以 #[doc(hidden)] pub 暴露于 jarvis_codex_lib::voice_provider）：
//! - trait VoiceProvider（connect/interrupt/send_text/stop/capabilities/next_event）
//! - struct VoiceSessionConfig::new(&str, Value)
//! - struct ProviderCapabilities、enum AudioFormat { Pcm16, Opus, None }
//! - enum UnifiedVoiceEvent、enum Role { User, Assistant }
//! - struct ProviderError::new(code, category, recoverable, advice_zh)、enum ErrorCategory
//! - struct ControlSurface + fn control_surface_for(&ProviderCapabilities) -> ControlSurface
//! - fn validate_audio_frame(&[u8]) -> bool
//! - fn map_vendor_event(&str, &Value) -> Result<UnifiedVoiceEvent, ProviderError>
//! - enum SwitchStep、struct SwitchPlan + fn provider_switch_prelude(VoiceState) -> SwitchPlan
//! 已存在符号：jarvis_codex_lib::voice_state::VoiceState。
//!
//! 序列化约定（契约断言，实现必须遵守）：
//! - UnifiedVoiceEvent 内部标记 #[serde(tag = "type", rename_all = "camelCase")]，
//!   每条事件带 type 判别（transcriptDelta/turnStarted/...），与项目既有事件风格一致；
//! - 错误、控制面与配置均 serde rename_all = "camelCase"；
//! - ErrorCategory 与 Role 序列化为小写（"network"、"user"）；
//! - 配置 JSON 不得出现 thread 键（D4），Key 相关键只能以 Ref 结尾（BYOK）。
//! 平台无关：全部注入假件，不依赖真实麦克风、网络或 Windows API。

use std::collections::VecDeque;

use jarvis_codex_lib::voice_provider::{
    control_surface_for, map_vendor_event, provider_switch_prelude, validate_audio_frame,
    AudioFormat, ControlSurface, ErrorCategory, ProviderCapabilities, ProviderError, Role,
    SwitchPlan, SwitchStep, UnifiedVoiceEvent, VoiceProvider, VoiceSessionConfig,
};
use jarvis_codex_lib::voice_state::VoiceState;
use serde_json::{json, Value};

// ---------- 编解码层：音频帧不变量 ----------

#[test]
fn audio_frames_must_be_non_empty_and_byte_aligned_pcm16() {
    assert!(validate_audio_frame(&[0u8; 640]), "320 样本 × 2 字节合法");
    assert!(!validate_audio_frame(&[0u8; 639]), "奇数长度非法");
    assert!(!validate_audio_frame(&[]), "空帧非法");
}

// ---------- 错误分类：稳定码 + 分类 + 恢复建议 ----------

#[test]
fn errors_always_carry_stable_code_category_and_advice() {
    let err = ProviderError::new(
        "network.tls",
        ErrorCategory::Network,
        true,
        "请检查系统代理或 VPN 后重试",
    );
    assert_eq!(err.code, "network.tls");
    assert_eq!(err.category, ErrorCategory::Network);
    assert!(err.recoverable);
    assert!(!err.advice_zh.is_empty());

    // 序列化进诊断数据：camelCase 键、分类小写、稳定码原样
    let v = serde_json::to_value(&err).expect("serialize");
    assert_eq!(v["code"], "network.tls");
    assert_eq!(v["category"], "network");
    assert_eq!(v["recoverable"], true);
    assert!(v.get("adviceZh").is_some());
}

#[test]
fn provider_error_categories_cover_all_planned_fault_domains() {
    // 设计文档 §5：Network | Auth | Mic | Codec | Protocol | Rate
    for (code, category) in [
        ("network.timeout", ErrorCategory::Network),
        ("auth.expired", ErrorCategory::Auth),
        ("mic.denied", ErrorCategory::Mic),
        ("codec.decode", ErrorCategory::Codec),
        ("protocol.unknownEvent", ErrorCategory::Protocol),
        ("rate.limited", ErrorCategory::Rate),
    ] {
        let err = ProviderError::new(code, category, false, "建议");
        assert_eq!(err.category, category);
        assert!(!err.code.is_empty());
        assert!(!err.advice_zh.is_empty());
    }
}

// ---------- capability flags 驱动的 UI 控制面（纯函数） ----------

#[test]
fn control_surface_is_a_pure_function_of_capabilities() {
    let full = ProviderCapabilities {
        realtime: true,
        tool_events: true,
        interruptable: true,
        audio_format: AudioFormat::Pcm16,
    };
    let s = control_surface_for(&full);
    assert!(s.show_interrupt);
    assert!(s.show_task_tools);
    assert!(s.show_realtime_badge);
    assert!(!s.pipeline_only);

    let voice_only = ProviderCapabilities {
        realtime: true,
        tool_events: false,
        interruptable: false,
        audio_format: AudioFormat::Pcm16,
    };
    let s2 = control_surface_for(&voice_only);
    assert!(!s2.show_interrupt);
    assert!(!s2.show_task_tools);
    assert!(s2.show_realtime_badge);
    assert!(!s2.pipeline_only);

    let pipeline = ProviderCapabilities {
        realtime: false,
        tool_events: false,
        interruptable: false,
        audio_format: AudioFormat::None,
    };
    let s3 = control_surface_for(&pipeline);
    assert!(!s3.show_realtime_badge);
    assert!(s3.pipeline_only);
    assert!(
        !s3.degraded_copy_hint.is_empty(),
        "管线模式必须给出非实时能力的说明文案"
    );
}

#[test]
fn control_surface_serializes_for_the_frontend() {
    let caps = ProviderCapabilities {
        realtime: true,
        tool_events: false,
        interruptable: true,
        audio_format: AudioFormat::Opus,
    };
    let v = serde_json::to_value(control_surface_for(&caps)).expect("serialize");
    assert_eq!(v["showInterrupt"], true);
    assert_eq!(v["showTaskTools"], false);
    assert_eq!(v["showRealtimeBadge"], true);
    assert_eq!(v["pipelineOnly"], false);
}

// ---------- 协议层：统一事件映射（OpenAI 兼容流派共享纯函数） ----------

#[test]
fn vendor_event_mapping_is_total_and_typed() {
    let events: &[(&str, Value, UnifiedVoiceEvent)] = &[
        (
            "transcript.delta",
            json!({ "role": "user", "text": "你好" }),
            UnifiedVoiceEvent::TranscriptDelta {
                role: Role::User,
                text: "你好".into(),
            },
        ),
        (
            "transcript.final",
            json!({ "role": "assistant", "text": "收到" }),
            UnifiedVoiceEvent::TranscriptFinal {
                role: Role::Assistant,
                text: "收到".into(),
            },
        ),
        ("turn.started", json!({}), UnifiedVoiceEvent::TurnStarted),
        (
            "turn.completed",
            json!({}),
            UnifiedVoiceEvent::TurnCompleted,
        ),
        (
            "session.ended",
            json!({ "reason": "stop" }),
            UnifiedVoiceEvent::SessionEnded {
                reason: "stop".into(),
            },
        ),
        (
            "tool.event",
            json!({ "kind": "command", "summary": "运行测试" }),
            UnifiedVoiceEvent::ToolEvent {
                kind: "command".into(),
                summary: "运行测试".into(),
            },
        ),
    ];
    for (kind, payload, expected) in events {
        let mapped = map_vendor_event(kind, payload).expect("known event maps");
        assert_eq!(&mapped, expected, "kind={kind}");
    }
}

#[test]
fn unknown_vendor_events_classify_as_protocol_errors() {
    let err = map_vendor_event("vendor.private", &json!({})).expect_err("unknown kind rejected");
    assert_eq!(err.category, ErrorCategory::Protocol);
    assert!(!err.recoverable);
    assert!(!err.advice_zh.is_empty());
    // 错误码是诊断数据的稳定标识，进入契约冻结
    assert_eq!(err.code, "protocol.unknownEvent");
}

#[test]
fn malformed_vendor_events_classify_as_protocol_errors() {
    // 缺 text
    let e1 =
        map_vendor_event("transcript.delta", &json!({ "role": "user" })).expect_err("missing text");
    assert_eq!(e1.category, ErrorCategory::Protocol);
    // 未知 role
    let e2 = map_vendor_event("transcript.delta", &json!({ "role": "robot", "text": "x" }))
        .expect_err("unknown role");
    assert_eq!(e2.category, ErrorCategory::Protocol);
    // 空载荷
    let e3 = map_vendor_event("transcript.delta", &Value::Null).expect_err("null payload");
    assert_eq!(e3.category, ErrorCategory::Protocol);
    // text 类型错误
    let e4 = map_vendor_event("transcript.delta", &json!({ "role": "user", "text": 42 }))
        .expect_err("text must be a string");
    assert_eq!(e4.category, ErrorCategory::Protocol);
}

#[test]
fn audio_frames_never_travel_the_json_event_path() {
    // 音频帧走二进制/编解码路径；JSON 事件路径出现 audio 必须拒绝，
    // 防止把 base64 大帧混进文本事件流。
    let err = map_vendor_event("audio.frame", &json!({ "samples": "AAAA" }))
        .expect_err("audio is a binary concern");
    assert_eq!(err.category, ErrorCategory::Protocol);
    assert_eq!(err.code, "protocol.audioOnJsonPath");
}

#[test]
fn session_end_events_require_a_reason() {
    let e1 = map_vendor_event("session.ended", &json!({})).expect_err("missing reason is rejected");
    assert_eq!(e1.category, ErrorCategory::Protocol);
    let e2 = map_vendor_event("session.ended", &json!({ "reason": 7 }))
        .expect_err("non-string reason is rejected");
    assert_eq!(e2.category, ErrorCategory::Protocol);
}

#[test]
fn tool_events_require_kind_and_summary() {
    let e1 = map_vendor_event("tool.event", &json!({ "summary": "x" }))
        .expect_err("missing kind is rejected");
    assert_eq!(e1.category, ErrorCategory::Protocol);
    let e2 = map_vendor_event("tool.event", &json!({ "kind": "command" }))
        .expect_err("missing summary is rejected");
    assert_eq!(e2.category, ErrorCategory::Protocol);
}

#[test]
fn unified_events_serialize_with_type_tag_and_camel_case() {
    // 内部标记：前端靠 type 判别 + camelCase 字段渲染，不猜测变体形状。
    let v = serde_json::to_value(UnifiedVoiceEvent::TranscriptDelta {
        role: Role::User,
        text: "你好".into(),
    })
    .expect("serialize");
    assert_eq!(v["type"], "transcriptDelta");
    assert_eq!(v["role"], "user");
    assert_eq!(v["text"], "你好");

    let t = serde_json::to_value(UnifiedVoiceEvent::TurnStarted).expect("serialize");
    assert_eq!(t["type"], "turnStarted");

    let a = serde_json::to_value(UnifiedVoiceEvent::SessionEnded {
        reason: "stop".into(),
    })
    .expect("serialize");
    assert_eq!(a["type"], "sessionEnded");
    assert_eq!(a["reason"], "stop");
}

// ---------- 切换：有序关闭前缀 + D4 边界 ----------

#[test]
fn provider_switch_uses_the_ordered_shutdown_prefix() {
    // 活跃语音会话：先请求停止并等待确认，再实例化新 provider
    for state in [
        VoiceState::VoiceConnecting,
        VoiceState::VoiceListening,
        VoiceState::VoiceSpeaking,
        VoiceState::Working,
    ] {
        let plan = provider_switch_prelude(state);
        assert_eq!(
            plan.steps,
            vec![
                SwitchStep::RequestVoiceStop,
                SwitchStep::AwaitVoiceStopped,
                SwitchStep::Instantiate
            ],
            "state={state:?}"
        );
    }
    // 待机与降级（无活跃会话）：直接实例化
    for state in [VoiceState::WakeReady, VoiceState::Degraded] {
        assert_eq!(
            provider_switch_prelude(state).steps,
            vec![SwitchStep::Instantiate],
            "state={state:?}"
        );
    }
    // 交接/停止进行中：拒绝切换（与重连竞态同规则，不得复活或打断序列）
    for state in [
        VoiceState::Booting,
        VoiceState::WakeArming,
        VoiceState::WakeDetected,
        VoiceState::WakeReleasingMicrophone,
        VoiceState::VoiceAcquiringMicrophone,
        VoiceState::VoiceStopping,
        VoiceState::WakeRearming,
        VoiceState::Stopping,
    ] {
        assert_eq!(
            provider_switch_prelude(state).steps,
            vec![SwitchStep::Reject],
            "state={state:?}"
        );
    }
}

#[test]
fn switch_plan_never_touches_the_agent_backend() {
    // D4：切换语音厂商不碰 thread。计划内不存在任何 Agent 步骤，
    // 且序列化后不含 thread 键。
    for state in [
        VoiceState::VoiceListening,
        VoiceState::WakeReady,
        VoiceState::Stopping,
    ] {
        let plan: SwitchPlan = provider_switch_prelude(state);
        let v = serde_json::to_value(&plan).expect("serialize");
        let keys: Vec<String> = v.as_object().expect("object").keys().cloned().collect();
        assert!(
            !keys
                .iter()
                .any(|k| k.to_ascii_lowercase().contains("thread")),
            "switch plan must not reference threads"
        );
    }
}

// ---------- 会话配置：D4 + BYOK 边界 ----------

fn collect_keys(value: &Value, out: &mut Vec<String>) {
    if let Some(obj) = value.as_object() {
        for (key, child) in obj {
            out.push(key.clone());
            collect_keys(child, out);
        }
    } else if let Some(items) = value.as_array() {
        for item in items {
            collect_keys(item, out);
        }
    }
}

#[test]
fn voice_session_config_never_carries_thread_identity() {
    let cfg = VoiceSessionConfig::new(
        "E:/project",
        json!({ "model": "doubao-realtime", "apiKeyRef": "cred.volcengine" }),
    );
    let v = serde_json::to_value(&cfg).expect("serialize");
    // 递归扫描整棵配置树（顶层与嵌套），两条边界全树生效：
    let mut keys = Vec::new();
    collect_keys(&v, &mut keys);
    assert!(
        !keys
            .iter()
            .any(|k| k.to_ascii_lowercase().contains("thread")),
        "语音层配置不得携带 thread（D4：thread 归 AgentBackend）"
    );
    for k in &keys {
        if k.to_ascii_lowercase().contains("key") {
            assert!(k.ends_with("Ref"), "只能出现 Key 引用，禁止明文 Key：{k}");
        }
    }
}

// ---------- trait 实现义务：假件驱动的生命周期契约 ----------

struct FakeProvider {
    events: VecDeque<UnifiedVoiceEvent>,
    connected: bool,
    calls: Vec<&'static str>,
}

impl FakeProvider {
    fn new(events: Vec<UnifiedVoiceEvent>) -> Self {
        Self {
            events: events.into(),
            connected: false,
            calls: Vec::new(),
        }
    }
}

impl VoiceProvider for FakeProvider {
    async fn connect(&mut self, _config: &VoiceSessionConfig) -> Result<(), ProviderError> {
        self.connected = true;
        self.calls.push("connect");
        Ok(())
    }

    async fn interrupt(&mut self) -> Result<(), ProviderError> {
        if !self.connected {
            return Err(ProviderError::new(
                "voice.notConnected",
                ErrorCategory::Protocol,
                false,
                "请先建立语音会话",
            ));
        }
        self.calls.push("interrupt");
        Ok(())
    }

    async fn send_text(&mut self, _text: &str) -> Result<(), ProviderError> {
        if !self.connected {
            return Err(ProviderError::new(
                "voice.notConnected",
                ErrorCategory::Protocol,
                false,
                "请先建立语音会话",
            ));
        }
        self.calls.push("send_text");
        Ok(())
    }

    async fn stop(&mut self) -> Result<(), ProviderError> {
        self.connected = false;
        self.calls.push("stop");
        Ok(())
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            realtime: true,
            tool_events: false,
            interruptable: true,
            audio_format: AudioFormat::Pcm16,
        }
    }

    async fn next_event(&mut self) -> Option<UnifiedVoiceEvent> {
        if !self.connected {
            return None;
        }
        self.events.pop_front()
    }
}

#[tokio::test]
async fn providers_must_reject_use_before_connect() {
    let mut fake = FakeProvider::new(vec![]);
    let err = fake.send_text("你好").await.expect_err("not connected yet");
    assert_eq!(err.category, ErrorCategory::Protocol);
    let err = fake.interrupt().await.expect_err("not connected yet");
    assert_eq!(err.category, ErrorCategory::Protocol);
}

#[tokio::test]
async fn providers_emit_events_in_order_and_stop_is_idempotent() {
    let events = vec![
        UnifiedVoiceEvent::TranscriptDelta {
            role: Role::User,
            text: "嗨".into(),
        },
        UnifiedVoiceEvent::TranscriptFinal {
            role: Role::User,
            text: "嗨 Jarvis".into(),
        },
        UnifiedVoiceEvent::TurnStarted,
        UnifiedVoiceEvent::TurnCompleted,
    ];
    let mut fake = FakeProvider::new(events);
    let cfg = VoiceSessionConfig::new("E:/project", json!({ "model": "test" }));

    fake.connect(&cfg).await.expect("connect");
    assert_eq!(
        fake.next_event().await,
        Some(UnifiedVoiceEvent::TranscriptDelta {
            role: Role::User,
            text: "嗨".into()
        })
    );
    fake.interrupt().await.expect("interrupt after connect");
    assert_eq!(
        fake.next_event().await,
        Some(UnifiedVoiceEvent::TranscriptFinal {
            role: Role::User,
            text: "嗨 Jarvis".into()
        })
    );
    assert_eq!(
        fake.next_event().await,
        Some(UnifiedVoiceEvent::TurnStarted)
    );
    assert_eq!(
        fake.next_event().await,
        Some(UnifiedVoiceEvent::TurnCompleted)
    );

    // STOP 幂等：两次 stop 都成功，stop 后不再产出事件
    fake.stop().await.expect("first stop");
    fake.stop().await.expect("second stop is a no-op success");
    assert_eq!(fake.next_event().await, None);
    assert_eq!(fake.calls, vec!["connect", "interrupt", "stop", "stop"]);
}
