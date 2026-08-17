# 语音与 Agent Provider 可插拔设计（国人友好版）

- 状态：设计草案 v0.1，先评审后写码
- 上游依据：`docs/WINDOWS_OPTIMIZATION_PLAN.md` §11 阶段七
- 方法论：契约先行（同 §5.4）；未经明确要求不 commit/push/merge/release

## 1. 背景与问题

| 层 | 现状 | 国内用户的问题 |
|---|---|---|
| 语音交互 | 前端 `RTCPeerConnection` 直连 `codex app-server` realtime（WebRTC/SDP/ICE） | app-server 需 OpenAI 登录态且网络不可达 |
| Agent 执行 | 后端 `CodexRuntime` JSON-RPC（thread/resume、thread/start、realtime/stop） | 同上；无账号即无 thread |
| 认证 | 复用本机 Codex 登录 | 无 |
| 代理 | 系统代理仅传给 Codex 子进程 | 国内直连需适配各家 endpoint |

结论：语音模块无通用性不是 UI 问题，而是 **provider 硬编码** 问题。解法是把语音与 Agent 各收敛为一个对外契约，Codex 降级为其中一个适配器。

## 2. 决策记录

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 对外一层、对内三层：核心只依赖 `VoiceProvider` 一个 trait；实现内部按 transport/protocol/codec 私有模块组织 | 接口风险最小；避免第一版猜错三层公共 trait 的切法 |
| D2 | 运行时配置，非编译期选死：编译期 enum 注册表 + settings 驱动实例化；新厂商 = 新版本 | 用户装完在设置里自由切换；不上动态 dylib（签名/诊断/审计成本） |
| D3 | 语音厂商与 LLM/Agent 厂商是 **两个独立维度**，settings 存两个独立字段；「套餐」只是 UI 层预设展开，不进入 schema 事实源 | Codex 是语音与大脑焊死的特例；国内生态两者可分离，组合是乘法 |
| D4 | `workspace→thread` 映射归 AgentBackend 所有；切换语音厂商不丢任务进度 | 纯语音厂商没有 thread 概念，对话记忆必须在大脑一侧 |

## 3. 目标与非目标

目标：

1. `VoiceProvider` 单一对外契约，核心（唤醒、麦克风所有权状态机、STOP、Job Object、诊断、持久化）不感知厂商。
2. 国内厂商适配器：豆包 Realtime（首选 PoC，WebSocket + PCM16，国内直连）；Qwen-Omni（次选）；管线降级（ASR→LLM→TTS）兜底任意文本 API。
3. 国内构建变体：`tauri.cn.conf.json` 切换产品名/标识符/图标/默认 provider 预设，不复制代码库。
4. 合规：BYOK（Key 只存本机，不进日志不内置）、AI 合成内容标识、不自建中转。

非目标（首版）：

- 不做动态 dylib 插件加载。
- 不做第三方插件市场/生态分发。
- 不把管线降级模式设为阶段门禁。
- 不改核心资源管理语义；provider 只是状态机中的一个「会话执行者」。

## 4. 架构决策：对外一层，对内三层

### 4.1 层职责

| 层 | 职责 | 不负责 |
|---|---|---|
| transport | 建连/断线/重连/心跳/代理；WebRTC 或 WebSocket 或 stdio | 事件语义 |
| protocol | 各家事件 → 统一事件枚举；字段映射；错误分类 | 网络状态 |
| codec | 上行采集 PCM16 16kHz；下行 PCM/Opus → 可播放帧 | 会话状态 |

### 4.2 三次法则（提升公共 trait 的触发条件）

- 同一层被两个以上厂商 **原样复用** 时，才把该私有模块提升为公共 trait。
- 预期豆包落地后 `transport` 与 `codec` 先触发（豆包与 Qwen-Omni 同为 WebSocket+PCM16）。
- 协议层差异被高估：国内 realtime API 高度同构（豆包官方文档即「使用 Realtime API 调用 Doubao」，Qwen-Omni 同流派），第一版不为它建公共抽象。

## 5. VoiceProvider 契约（草案）

```rust
/// 对外唯一契约。核心与 UI 只依赖它。
pub trait VoiceProvider: Send + Sync {
    /// 建立会话（transport/protocol/codec 由实现内部组合）
    async fn connect(&mut self, session: &SessionConfig) -> Result<(), ProviderError>;
    /// 打断当前回复
    async fn interrupt(&mut self) -> Result<(), ProviderError>;
    /// 会话中插入文字
    async fn send_text(&mut self, text: &str) -> Result<(), ProviderError>;
    /// 有序关闭（与 StopSequence 配合）
    async fn stop(&mut self) -> Result<(), ProviderError>;
    /// 声明能力位，核心与 UI 据此渲染
    fn capabilities(&self) -> ProviderCapabilities;
    /// 拉取下一个统一事件（或由内部线程 emit）
    async fn next_event(&mut self) -> Option<UnifiedVoiceEvent>;
}

pub struct ProviderCapabilities {
    pub realtime: bool,      // 真实时 vs 管线
    pub tool_events: bool,   // 语音中能否执行工具
    pub interruptable: bool,
    pub audio_format: AudioFormat, // Pcm16 | Opus | None
}

pub enum UnifiedVoiceEvent {
    TranscriptDelta { role: Role, text: String },
    TranscriptFinal { role: Role, text: String },
    AudioFrame { samples: Vec<u8> },       // 解码后统一 PCM16
    TurnStarted,
    TurnCompleted,
    ToolEvent { kind: String, summary: String },
    SessionEnded { reason: String },
    Error(ProviderError),
}

pub struct ProviderError {
    pub code: &'static str,        // 稳定错误码，进诊断
    pub category: ErrorCategory,   // Network | Auth | Mic | Codec | Protocol | Rate
    pub recoverable: bool,
    pub advice_zh: &'static str,   // 中文恢复建议，进一键诊断
}
```

### 5.1 与核心的关系

- 状态机（`voice_state.rs`）不变：`VoiceAcquiringMicrophone → VoiceConnecting → VoiceListening…` 仍是唯一事实源。
- `VoiceConnecting` 内部调用 `provider.connect()`；`StopRequested` 调用 `provider.stop()` 后走既有 `stop_sequence` 动作链。
- provider 事件经统一枚举映射为现有前端事件（`jarvis-voice-state`、`codex-event` 语义兼容），前端渲染路径不动。
- 错误统一进 `Degraded`，携带 `ErrorCategory` 与 `advice_zh`，直接喂一键诊断。

### 5.2 与 Agent 层的关系

- `AgentBackend` 是第二个对外契约（thread 生命周期、文本任务、工具执行、对话记忆），设计随步骤 4 细化，首版先冻结接口形状。
- `workspace→thread` 映射与迁移逻辑归 AgentBackend（D4）；语音层不感知 thread。
- 一体化模式（Codex、豆包带工具）下两者联动；分离模式（豆包语音 + DeepSeek 大脑）下经桥接层回流：语音 transcript → Agent 输入，Agent 工具进度 → 语音播报。
- 待实机验证（决定 PoC 第一步）：豆包 Realtime 会话内工具调用是否可用；分离模式的桥接体验是否可接受。

## 6. settings schema v3（草案）

`settings_store.rs` 现为 `SETTINGS_SCHEMA_VERSION: u32 = 2`。升级要点：

- 新增两个 **独立字段**（D3）：
  - `voiceProvider: { kind: "codex" | "doubao" | "qwen" | "pipeline", endpoint?, model?, apiKeyRef? }`
  - `agentBackend: { kind: "codex" | "deepseek" | "qwen" | "kimi" | …, endpoint?, model?, apiKeyRef? }`
- 「套餐」只是 UI 预设展开（豆包全家桶 = doubao 语音 + deepseek 大脑 等），**不落 schema**。
- `apiKeyRef` 只存引用/占位，真实 Key 由本机凭据区保存，**绝不进 `settings.json` 与日志**。
- v2→v3 迁移：两字段缺省 `codex`，行为与现状完全一致。
- 切换 `voiceProvider` 与切换 `agentBackend` 走各自的有序关闭前缀（复用 `WorkspaceSwitch` 同款），互不牵连；切换语音厂商不影响 thread。

### 6.1 设置页形态（D3 落地）

- 首次向导：普通用户只选「套餐」（豆包全家桶 / 通义全家桶 / 海外 Codex / 自定义）。
- 设置页高级折叠区：两个独立选择器（语音厂商、LLM/Agent 厂商），可自由跨家组合。
- capability flags 驱动 UI：`toolEvents=false` 时隐藏语音内任务按钮，提示降级到文字任务。

## 7. 国内构建变体（草案）

- `src-tauri/tauri.cn.conf.json`（Tauri 2 配置合并，构建时 `--config` 覆盖）：产品名、`identifier`、图标、窗口标题、默认套餐预设。
- 构建命令示例：`tauri build --bundles nsis --config src-tauri/tauri.cn.conf.json`。
- 代码共享：同一 Rust/TS 代码库，无复制；CI 可双包产出（海外版 + 国人友好版）。

## 8. 合规清单

- [ ] 不内置任何厂商 API Key；BYOK，Key 本机加密存储。
- [ ] 日志/诊断脱敏覆盖 provider 请求（URL 脱敏、无 Authorization、无 Key）。
- [ ] 若公开分发：AI 合成内容按《人工智能生成合成内容标识办法》标注。
- [ ] 不自建 API 中转（避免 ICP/增值电信许可问题）；仅直连各家官方 endpoint。
- [ ] 发布说明标注各厂商协议实验性、模型许可证与价格说明。

## 9. 测试与验收计划

契约先行（仿 §5.4）：

1. `tests/contract/voice_provider.rs`（暂存，符号就位后 `git mv` 入门禁）：注入假件驱动；断言统一事件映射、错误分类、capability 渲染、provider 切换的有序关闭前缀、语音切换不碰 thread。
2. 搬迁验收：Codex 链路行为零变化，157 项现有契约 + `npm run check` 全绿。
3. 豆包验收：契约测试绿；实机 20 次「唤醒→Voice→STOP→重布防」循环（同 §5.3 标准）；麦克风交接、STOP、诊断同 Codex 模式。
4. 实机留项：真实语音质量、打断体验、各厂商错误恢复路径、蓝牙切换、分离模式桥接体验。

## 10. 实施顺序与回退

1. 本设计文档评审（当前所处步骤）。
2. 契约测试暂存 → 评审。
3. Codex 适配器搬迁（行为零变化，门禁绿）。
4. 豆包 PoC：先验证会话内工具调用能力，再定一体化/分离模式实现（契约绿 + 实机）。
5. schema v3 + 构建变体 + 合规清单核对。

每步独立可回退：步骤 3 若破坏任何门禁，直接还原该步骤改动；步骤 4 失败不影响 Codex 链路（适配器未注册即不可选）。

## 11. 待评审问题（评审时逐条确认）

1. D3 的「套餐预设清单」初始值（豆包全家桶的具体组合：豆包语音 + 哪个大脑？）。
2. AgentBackend 国内替代路线：自研轻量 loop（DeepSeek/Qwen Responses + function calling）vs 接入 OpenClaw/通义灵码。
3. `apiKeyRef` 的落盘位置与加密方案（Tauri 凭据区 vs 独立文件）。
4. 分离模式桥接层归属：Rust 后端 vs 前端。
5. 豆包 Realtime 协议细节核验（鉴权、音频格式、事件名）——需实机/官方文档双重确认。
