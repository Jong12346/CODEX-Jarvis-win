# Jarvis → DSH 语音插件：阶段一设计

- 状态：DSH UI 插件 v0.6（Host relay、浏览器控制、最终转写 Agent 投递与 Agent 结果语音回流已组装，离线唤醒待完成）
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
5. **AgentBackend 衔接**：最终用户 transcript 通过现有 scope 会话入口进入同一 Agent；豆包自主回复会被取消，工具开始/完成/失败与最终 Agent 文本通过指定文本播报按序回流。
6. **记忆可移植验收**：换 provider，记忆/会话/thread 不丢（`ctx.storage` 已保障，验证即可）。

## 5. 与旧 Rust 契约的关系

`tests/contract/voice_provider.rs`（17 项，已影子自证）保留为**语义参考**，不再 `git mv` 入门禁；其 17 项断言逐一平移到步骤 1 的 vitest 契约。`.tmp/contract-check/` 影子设施停用。

## 6. 已确认决策（2026-08 用户拍板）

1. **唤醒词直接上**：纯前端 PoC 用 sherpa-onnx-wasm 浏览器内关键词识别（对齐方案 §8 阶段四方向）；System.Speech C# sidecar 作为后续宿主侧备选。
2. **迁移现有粒子界面**：把 Jarvis 现有 main.ts 的粒子/装甲视觉逻辑迁移进客户端插件，不重做极简风。
3. **先纯前端最小 PoC（含本地 relay）**：语音链路 getUserMedia→本地 relay→豆包 WebSocket；因浏览器 WebSocket 无法设自定义头、豆包鉴权靠头，故必须经本地 relay，不先建宿主 ctx.voice seam；链路验证后再提升为正式 seam。

## 7. 豆包 Realtime 协议核实（修正此前假设）

- 豆包语音存在两代协议。旧 S2S 端点 `wss://openspeech.bytedance.com/api/v3/realtime/dialogue` 使用自定义二进制帧和多鉴权头，兼容实现继续保留。
- 当前 PoC 采用实时语音模型 3.0（Seeduplex）的 Duplex 端点 `wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue`：文本 JSON WebSocket、单 `X-Api-Key`、PCM16/16kHz 输入和 PCM16/24kHz 输出。
- Duplex 适配器已覆盖函数调用事件与工具结果回传，真实工具调用仍待在线验收；WAV 输入的 ASR→回复文本→TTS 回路已经实跑成功。
- **修正**：协议与 codec 仍是厂商定制层，provider 只能共享统一事件和生命周期语义，不能假设各家 Realtime API 高度同构。
- **浏览器约束**：浏览器 WebSocket API 无法设置鉴权头。本地 relay 已实现为可启动服务，只监听回环地址、限制本地 Origin，并在服务端向上游注入 Key；真实 WebSocket 集成测试覆盖文本与二进制帧转发。

## 8. 客户端插件形态（packages/client/*，已核对）

- 每个客户端插件一个包：node 半边 `src/index.ts`（`apply`，可为空，仅为出现在 host cordis.yml）、浏览器半边 `src/client/index.ts`、package.json 声明 `dsh.client` + `exports["./client"]`。
- 注册进 `packages/bundle/web-app/cordis.patch.yml` 的 `dsh.client` roster；`__DSH_BOOT__` 入口图由 `apps/web/vite.config.ts` 注入。
- 参考实现：`packages/client/ui-workspace`、`ui-goal`、`ui-input-trigger`。
- 相邻 DSH 工作区已新增 `@deepseek-ai/dsh-client-ui-voice`：Host 半边通过 `webServer` 和 `credentials` 托管同源 relay，浏览器半边完成 getUserMedia→PCM16/16kHz/20ms 分帧、24kHz 连续回放，并注册输入区按钮与活动状态条。最终用户转写固定投递到启动语音的 session，经该 scope 的 `conversation.send()` 进入现有 Agent、工具、记忆和持久历史；中间转写与豆包助手文本不进入 Agent，页面切换也不会改变本次语音目标。完整转写到达时会取消豆包自主回复；固定会话的工具开始、工具完成/失败和最终 Agent 文本通过串行 `speech_text_buffer.commit` 回流语音，原始工具输出不会朗读。自动化验证覆盖上述编排；真实 DSH Web 已验收麦克风转写、当前会话 Agent 回答及最终回答语音播放。静音显式提交 ASR 缓冲区，并在上游缺少最终转写事件时提交最后的完整识别假设。Jarvis 粒子界面及 sherpa-onnx 唤醒/麦克风互斥协调层尚未平移，仍需模型资产、真实关键词和工具进度实机播报验收。
