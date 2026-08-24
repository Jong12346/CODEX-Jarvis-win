# Jarvis → DSH 语音插件：阶段一设计

- 状态：设计草案 v0.1（待评审）
- 上游依据：docs/cn-friendly/PROVIDER_DESIGN.md 的 D1–D4 决策，载体从 Rust trait 平移为 DSH 插件接口
- 目标：把 Jarvis 演进为 DSH 生态的语音插件，记忆与 provider 解耦，语音交互优先

## 1. 定位

Jarvis 从独立 Tauri app 演进为 DSH 生态插件，分两层：

- **宿主侧（host）**：新增 `ctx.voice` seam —— realtime 语音 provider 注册表 + 统一事件 + 错误分类 + capability。
- **客户端侧（client）**：`dsh.client` UI 插件 —— 唤醒/麦克风采集/粒子或极简界面/字幕渲染。

## 2. 复用 DSH 既有 seam（已核对 docs/capability-seams.zh.md）

| ctx 键 | 用途 | 对应我们之前的决策 |
|---|---|---|
| `ctx.clientModules`（modules 包） | 客户端插件图（`__DSH_BOOT__` 入口） | 语音 UI 插件挂载点 |
| `ctx.llm` / `ctx.agents` / `ctx.agentLoop` | 模型与 agent 已可插拔 | AgentBackend（D3/D4 的"大脑"侧） |
| `ctx.credentials` / `ctx.settings` | Key 引用 + 脱敏视图 + 分层设置 | D3 的 `apiKeyRef`（BYOK） |
| `ctx.storage` / `ctx.sessionPersistence` / `ctx.workspaceRegistry` | 记忆/会话/工作区本地持久化 | 换 provider 不丢记忆（用户核心痛点） |
| `ctx.attachments` | 已接受的图片（会话事件前提交） | 语音里截图送视觉 |
| `ctx.subprocess` / `ctx.shell` | 子进程 spawn | 唤醒 sidecar（System.Speech/sherpa-onnx） |
| `ctx.typert`（zod 运行时类型） | 类型注册 | voice seam 接口用 zod 描述 |
| `ctx.approval` | 一次性权限瀑布 | 语音触发的危险操作仍走审批 |

## 3. 缺口：DSH 没有语音 seam

现有 seam 里没有语音/realtime/麦克风。需要新建 `ctx.voice`：

- 接口 = 之前定稿的 VoiceProvider 契约语义：connect/interrupt/send_text/stop + 统一事件（transcriptDelta/turnStarted/audioFrame/toolEvent/…）+ 错误分类（Network/Auth/Mic/Codec/Protocol/Rate）+ capability flags。
- 载体从 Rust trait → TypeScript 接口 + zod schema（DSH 用 `ctx.typert` 做运行时类型）。
- adapter：doubao（WS+PCM16，首选 PoC）、qwen（WS）、codex（app-server WebRTC，保持现状可用）。
- 切换有序关闭、thread 归 AgentBackend、语音不碰 thread —— 三条语义原样保留。

## 4. 阶段一步骤（契约先行）

1. **voice seam 契约**：TS 接口 + zod schema + 统一事件，写可执行契约（vitest），镜像 `tests/contract/voice_provider.rs` 的 17 项断言。
2. **doubao realtime adapter**：WebSocket + PCM16，官方 Realtime API；先实机验证"会话内工具调用"再定一体化/分离模式。
3. **客户端 UI 插件**：getUserMedia 采集 + 音频播放 + 唤醒/麦克风按钮 + 事件渲染。
4. **豆包 PoC 跑通**：唤醒→豆包→对话→STOP。
5. **AgentBackend 衔接**：语音 transcript → `ctx.agents`；工具进度回流语音。
6. **记忆可移植验收**：换 provider，记忆/会话/thread 不丢（`ctx.storage` 已保障，验证即可）。

## 5. 与旧 Rust 契约的关系

`tests/contract/voice_provider.rs`（17 项，已影子自证）保留为**语义参考**，不再 `git mv` 入门禁；其 17 项断言逐一平移到步骤 1 的 vitest 契约。`.tmp/contract-check/` 影子设施停用。

## 6. 已确认决策（2026-08 用户拍板）

1. **唤醒词直接上**：纯前端 PoC 用 sherpa-onnx-wasm 浏览器内关键词识别（对齐方案 §8 阶段四方向）；System.Speech C# sidecar 作为后续宿主侧备选。
2. **迁移现有粒子界面**：把 Jarvis 现有 main.ts 的粒子/装甲视觉逻辑迁移进客户端插件，不重做极简风。
3. **先纯前端最小 PoC**：语音链路 getUserMedia→豆包 WebSocket 全在浏览器侧完成，不先建宿主 ctx.voice seam；链路验证后再提升为正式 seam。

## 7. 豆包 Realtime 协议核实（修正此前假设）

- 豆包**语音**（S2S 语音大模型）走**自定义二进制 WebSocket 协议**：`wss://openspeech.bytedance.com/api/v3/realtime/dialogue`，鉴权用 Volcengine APP_ID + AccessKey，resource_id `volc.speech.dialog`，帧格式为自定义 binary（audio frame / event frame），**不是** OpenAI 兼容 JSON。
- 豆包另有一套 OpenAI 兼容 Realtime API（Ark 平台，文本/多模态）——与语音 PoC 无关，待需要时再核实。
- **修正**：设计文档 docs/cn-friendly §4.2「国内 realtime API 高度同构、协议层差异小」的假设对豆包**语音**不成立；语音 adapter 的 protocol/codec 层是定制活，不是薄映射。
- 会话内工具调用（function call）能力：S2S 语音 API 是否支持仍需实机验证（官方文档与 demo 未在 README 层明示）。

## 8. 客户端插件形态（packages/client/*，已核对）

- 每个客户端插件一个包：node 半边 `src/index.ts`（`apply`，可为空，仅为出现在 host cordis.yml）、浏览器半边 `src/client/index.ts`、package.json 声明 `dsh.client` + `exports["./client"]`。
- 注册进 `packages/bundle/web-app/cordis.patch.yml` 的 `dsh.client` roster；`__DSH_BOOT__` 入口图由 `apps/web/vite.config.ts` 注入。
- 参考实现：`packages/client/ui-workspace`、`ui-goal`、`ui-input-trigger`。
- **缺口确认**：apps/web 无任何 getUserMedia/AudioContext/WebSocket/RTCPeerConnection 代码——语音采集与播放需从零在客户端插件里建。
