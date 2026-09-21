# Jarvis Codex Windows 最终优化方案

本文是 Jarvis Codex Windows 版本后续优化工作的长期依据。后续对话即使被压缩或中断，也应先读取本文，再根据“当前进度”继续，不重新猜测目标，不把已通过项目当成未完成项目。

## 1. 最终目标

面向 Windows 11 x64，交付一个可以长期日常使用的 Jarvis Codex 桌面助手：

1. 登录 Windows 后可靠地在后台启动，保持单实例，窗口可以隐藏、显示并获得前台焦点。
2. 唤醒前只在本机识别“嗨 Jarvis / Hey Jarvis / 贾维斯”等关键词，不持续上传待机音频。
3. 唤醒监听器与 Codex Voice 对麦克风实行确定性的互斥交接，不依赖固定延时碰运气。
4. 唤醒后通过 Codex app-server V3 和 WebRTC 进入官方 Voice 链路，支持实时字幕、语音回复和 Voice 中插入文字。
5. 语音、文字、工具事件和实际项目任务进入同一个 Codex thread；每个工作目录保存并恢复自己的 thread。
6. Codex 在用户选定的 Windows 工作目录中执行真实任务，并继续保留安全、自动办公、完全访问三档权限。
7. STOP 停止 Voice、抑制 transcript tail、打断晚到 turn，并精确清理当前 Jarvis runtime 启动的进程树，不影响其他 Codex、VS Code、终端或用户程序。
8. 对 Codex、麦克风、Windows 语音组件、WebView2、代理/VPN和 realtime 链路提供非技术化的一键诊断。
9. 使用 NSIS 生成可安装、覆盖升级和卸载的 Windows 安装包；发布时支持代码签名和自动更新演进。
10. 自动化检查、实机证据、已知限制和发布产物都有可追溯记录，不把未执行的 Voice 或硬件测试描述为通过。

## 2. 固定原则与边界

- Windows 11 x64 是当前唯一 CI 发布目标。保留 macOS 源码以便同步上游，但 macOS CI 和 macOS 功能优化不阻塞 Windows 交付。
- 不使用模拟鼠标、模拟键盘或控制 ChatGPT/Codex 窗口。
- 不读取、保存或输出用户登录凭据；认证复用本机 Codex 登录。
- 不硬编码用户名、盘符、个人目录、Codex 版本号、代理地址或证书密码。
- 不使用无所属关系检查的 `taskkill`、`pkill` 或按进程名全局结束程序。
- 不降低现有沙箱和审批策略；完全访问模式也必须保留破坏性操作边界。
- 所有状态变化都要可恢复；切换工作目录、权限、Codex 路径或语音风格时，应有明确的 runtime 重建行为。
- 大规模重构必须分阶段进行，每阶段保持可构建、可安装和可回退。
- 未经明确要求，不提交、推送、合并或发布新版本。

## 3. 当前可用基线

当前版本已经具备：

- Tauri 2 透明无边框窗口、后台隐藏、单实例和登录自启动。
- Windows `System.Speech` 本地唤醒 sidecar，安装包分发为 GUI `.exe`。
- Codex 可执行文件自动发现和手动选择，支持空格、中文和非 ASCII 路径。
- `codex app-server --enable realtime_conversation --stdio` JSON-RPC 链路。
- Codex Voice V3 WebRTC、实时字幕、音频回复、Voice 内文字和同 thread 工具事件。
- 每个工作目录续接自己的 thread，三档权限模式和语音风格设置。
- STOP 的 realtime/turn 中断、transcript tail 抑制和当前 runtime 子进程清理。
- Windows 系统代理向 Jarvis 自己启动的 Codex 子进程传递。
- NSIS 构建、静默安装、覆盖升级、卸载和重装验证。
- Windows CI、15 项源代码契约测试、前端构建、Rust 格式与 Clippy。

当前主要不足：

- `System.Speech` 使用单个识别文化，中英文混合唤醒的可靠性有限。
- 麦克风交接仍包含固定等待和重试，缺少统一的资源所有权状态机。
- realtime 网络错误虽然有有限重试，但诊断信息仍偏技术化，缺少登录、代理、TLS 和服务状态分类。
- STOP 主要依赖 Codex RPC 和 runtime 子进程持有关系，尚未用 Windows Job Object 对整棵任务进程树提供操作系统级兜底。
- 设置和 workspace/thread 映射主要保存在前端，需要迁移到后端的版本化持久化存储。
- TypeScript 和 Rust 主文件体积较大，状态逻辑需要模块化。
- 语音与 Agent 执行层绑定 Codex 专有链路（OpenAI 账号、网络与登录态），国内用户不可达，语音模块无通用性。
- 未完成发布代码签名、自动更新和真实登录重启后的全套回归。

## 4. 目标架构

```text
Windows 登录启动 / 托盘 / 全局快捷键
                 │
                 ▼
        Jarvis Runtime Coordinator
        ├─ Wake State Machine
        ├─ Voice State Machine
        ├─ Codex Thread Manager
        ├─ Permission Manager
        ├─ Process Ownership / Job Object
        ├─ Diagnostics and Structured Logs
        └─ Versioned Settings Store
                 │
       ┌─────────┴──────────┐
       ▼                    ▼
本地关键词监听器       Codex app-server 子进程
只处理唤醒词          JSON-RPC / thread / tools
       │                    │
       └────麦克风互斥──────┤
                            ▼
                   WebRTC Codex Voice
```

前端负责界面、WebRTC peer、字幕和用户输入；Rust 后端负责平台资源、Codex runtime、进程所有权、持久化、诊断和安全边界。前端不直接猜测进程或麦克风状态，所有关键状态由后端事件驱动。

## 5. 阶段一：语音和麦克风确定性状态机

### 5.1 目标状态

```text
Booting
→ WakeArming
→ WakeReady
→ WakeDetected
→ WakeReleasingMicrophone
→ VoiceAcquiringMicrophone
→ VoiceConnecting
→ VoiceListening / VoiceSpeaking / Working
→ VoiceStopping
→ WakeRearming
→ WakeReady
```

错误进入 `Degraded`，必须携带错误类别、可恢复性、建议动作和资源所有者。STOP 可以从任何 Voice/Working 状态进入 `Stopping`，且必须具备幂等性。

### 5.2 实施内容

- 定义共享状态、状态转换和事件类型，替代前端分散的布尔值组合。
- 唤醒 sidecar 增加 `ready`、`wake`、`stopping`、`microphoneReleased`、`error` 明确事件。
- Rust 后端只在收到 sidecar 退出和麦克风释放确认后发出 `voiceMayAcquireMicrophone`。
- WebRTC 关闭后等待所有本地音轨进入 `ended`，再允许重新布防唤醒。
- 保留有限超时作为异常兜底，但超时必须产生明确错误，不作为正常同步方式。
- 支持按钮唤醒和全局快捷键走同一状态机。
- Voice 网络自动重连不得与 STOP、目录切换或重新布防竞争。

### 5.3 验收标准

- 连续执行至少 20 次“唤醒 → Voice → STOP → 重新布防”，不出现麦克风占用和重复 Voice。
- 冷启动、后台唤醒、窗口关闭后再唤醒均走同一状态机。
- 蓝牙耳机切换、默认麦克风变化或麦克风被其他应用占用时显示可理解错误。
- STOP 后没有 transcript tail 触发新 turn，也没有自动重连复活 Voice。

### 5.4 本阶段执行细则（契约先行，CODEX 指令）

沿用 P0 阶段验证有效的方法论：先写可执行契约，再落地实现，最后并入门禁。**本轮只做这一项**，不捎带 §6 的 Job Object 主动杀树、不做诊断 UI、不做持久化。

**复用、不另起炉灶**

- 纯状态机范式照抄 `src-tauri/src/runtime_state.rs`（`RuntimeState` / `RuntimeEvent` / 纯函数 `runtime_state_transition` + `tests/runtime_state.rs` 24 项契约）。新纯模块落 `src-tauri/src/voice_state.rs`。
- 状态迁移复用日志通道 `append_runtime_log` → `jarvis-runtime.jsonl`，事件名 `jarvis.voice.state_transition`，沿用 `schemaVersion/timestampMs/from/to/trigger` 并加 `micOwner`；另 `emit` `jarvis-voice-state` 供前端渲染。不记录音频内容、凭据、完整环境变量。
- 前端 `main.ts` 退化为**从后端事件渲染**，删除分散的麦克风/语音布尔组合（`voiceStartInFlight`、`recoverableColdStartError`、`realtimeReconnectAttempts`、`pendingRealtimeReconnect`、`realtimeStableTimer` 等）。麦克风/连接状态的唯一事实来源在后端。

**契约落地方式**

1. 契约暂存 `tests/contract/voice_state.rs`（非 `src-tauri/tests/`，避免符号未存在时连带 fmt/clippy 编译失败）；用注入的假件（fake sidecar / fake track set）驱动，纯逻辑须能在任意平台运行，不依赖真实麦克风。
2. 实现落地时一次 `git mv` 移入 `src-tauri/tests/`，与引入符号的提交同一 commit。`cargo test` 已在门禁内，无需再改 `package.json`。

**必须固化为纯函数并断言的契约点**（状态集与实机验收沿用 §5.1、§5.3，不重复）

- `mic_owner(state) -> {None, Wake, Voice}`：任一状态所有者唯一；遍历所有 `(state, event)` 断言不产生 Wake 与 Voice 双持有。
- 释放先于获取：`WakeReleasingMicrophone → VoiceAcquiringMicrophone` 只能由 `MicrophoneReleased` 确认事件触发，**计时器不得触发**。
- 重新布防先于命中：只有 `AllTracksEnded`（本地音轨全部 `ended`）才允许 `WakeRearming → WakeReady`。
- STOP 幂等：任意 `Voice*`/`Working`/`VoiceConnecting` + `StopRequested → VoiceStopping`，重复 `StopRequested` 不改状态、不报错（仿 `terminal_observations_are_idempotent`）。
- 竞态丢弃：`is_reconnect_allowed(state)` 在 `VoiceStopping`/`WakeRearming`/`WakeReleasingMicrophone`/目录切换进行中对 `ReconnectRequested` 返回 false，不得复活 Voice；`WorkspaceSwitch` 与 `StopRequested` 走同一有序关闭前缀。
- 超时只兜底：`Timeout{stage}` 一律进入 `Degraded`，不作为正常同步；`Degraded` 携带错误类别、可恢复性、建议动作、当前资源所有者。
- 单入口：按钮、全局快捷键、sidecar 命中走同一 `WakeDetected` 入口，断言三者同迁移。

**sidecar 协议补齐**：`ready` / `wake` / `stopping` / `microphoneReleased` / `error` 明确事件；后端只在收到 sidecar 退出**且**麦克风释放确认后发 `voiceMayAcquireMicrophone`。

**边界**（§2）：不用固定 delay 当同步、不模拟输入、不按名杀进程、不降沙箱/审批、IPC 兼容或提供迁移层、每步可构建可回退、未经要求不 commit/push/merge/release。

**验收边界**

- CODEX 自证（本阶段必须绿）：`voice_state.rs` 契约测试并入门禁；`npm run check` 退出 0；`git status` 只含应有改动。
- 留给独立复审 / 用户实机（**不得声称已通过**）：§5.3 的 20 次循环、设备切换错误提示、STOP 后无 tail 新 turn、无重连复活——纯逻辑覆盖不到，明确标注待人工验收。

**交付**：契约暂存一提交、实现+`git mv` 激活一提交（或按状态机 / sidecar / 前端拆多个独立提交）、门禁并入一提交；完成后停下等独立复审，附一致性说明、`jarvis-voice-state` 字段清单、实机验收清单。

## 6. 阶段二：Windows Job Object 与 STOP

### 6.1 实施内容

- 在 Rust Windows 平台模块中封装 Job Object，不在前端执行进程终止。
- 每个 Codex runtime 创建独立 Job Object，将 Jarvis 启动的 app-server 及其可继承子进程纳入所有权范围。
- STOP 首先发送 `thread/realtime/stop` 和 `turn/interrupt`，等待短暂宽限期。
- 若当前 runtime 的子进程仍存活，使用 Job Object 精确终止该 runtime 的进程树；随后按原 thread 重建 app-server。
- 切换工作目录、Codex 路径或权限模式时，先完成同样的有序关闭。
- 记录 PID、父子关系、runtime id、thread id 和启动时间，但不记录命令中的凭据或敏感环境变量。
- 禁止按镜像名杀进程，禁止影响不属于当前 runtime 的 Codex、PowerShell、终端和 VS Code。

### 6.2 验收标准

- 任务启动一个长期运行的子进程及其孙进程后，STOP 能全部清理。
- 同时手动启动另一套 Codex 和终端，STOP 后它们继续运行。
- 重复按 STOP 不报错、不误杀、不遗留 Voice 或自动重连。
- 强制关闭 Jarvis 时，Job Object 的 kill-on-close 能清理所属进程树。

## 7. 阶段三：一键诊断与日志

### 7.1 诊断项目

- Windows 版本、架构和 WebView2 Runtime。
- 麦克风隐私开关、默认输入设备和 WebView2 `getUserMedia` 结果。
- 已安装 Windows 语音识别文化和当前唤醒文化。
- Codex 路径、可执行性、版本、app-server initialize 和 realtime capability。
- 当前工作目录是否存在、可读、包含空格或非 ASCII 时是否能规范化。
- 当前权限模式、thread id 和 runtime 状态。
- 系统代理、环境代理和网络错误分类；代理凭据必须脱敏。
- 最近一次 wake、WebRTC、JSON-RPC、turn 和 STOP 的状态链。

### 7.2 用户体验

- 设置页提供“一键检查”，使用绿、黄、红状态和中文建议。
- 对登录失效、VPN/代理、TLS、超时、麦克风拒绝、语言包缺失、Codex 不可执行分别提示。
- Voice 不可用时允许直接降级到同 thread 的文字任务。
- 结构化日志写入应用数据目录，保留轮转上限，并提供“一键复制脱敏诊断”。

### 7.3 验收标准

- 常见故障不需要打开开发终端即可定位。
- 日志不包含登录令牌、代理密码、完整环境变量或用户项目内容。
- 网络断开、VPN切换、Codex 未登录和麦克风关闭都有不同错误代码和恢复建议。

## 8. 阶段四：本地唤醒质量

### 8.1 两步演进

第一步先稳定现有 `System.Speech`：

- 可选择识别语言、麦克风和阈值。
- 对连续命中、冷却时间和误触发进行统计。
- 提供按钮和全局快捷键回退。
- 当语言包缺失时在诊断页直接引导，而不是仅返回 sidecar 错误。

第二步引入可分发的离线关键词引擎，优先评估 `sherpa-onnx` keyword spotting：

- Windows x64 可重复构建，模型和运行库随安装包分发。
- 同时支持中英文关键词和自定义唤醒词。
- 使用 VAD、阈值、冷却时间和去抖减少误唤醒。
- 待机音频不离开本机，唤醒后立即释放音频设备。
- 模型许可证、体积、来源和校验值写入发布文档。

如果模型体积、许可证或真实中文效果不满足要求，保留 `System.Speech + 快捷键/按钮` 为稳定回退，不虚假宣称双语离线唤醒完成。

### 8.2 验收标准

- 安静和普通办公噪声环境分别进行实机测试。
- “嗨 Jarvis / Hey Jarvis / 贾维斯”各测试至少 20 次，并记录命中、漏检、误触发。
- 连续背景播放普通中文和英文语音时，不出现不可接受的误唤醒。
- 离线断网状态可以唤醒，但正式 Codex Voice 明确提示需要网络。

## 9. 阶段五：持久化、界面和可维护性

### 9.1 持久化

- 将工作目录、thread 映射、权限、Codex 路径、语言、麦克风和自启动设置迁移到 Rust 后端的版本化配置。
- 使用规范化目录路径作为 workspace id，兼容空格、中文、大小写和目录移动后的重新关联。
- 原子写入并保留可恢复备份；配置升级必须有 schema version。
- 前端 `localStorage` 只做迁移来源或非关键界面偏好，不再作为 thread 唯一事实来源。

### 9.2 首次启动与日常界面

- 首次启动向导一次检查麦克风、语音组件、Codex、登录、网络、工作目录和权限模式。
- 托盘菜单提供显示、隐藏、唤醒、文字模式、STOP、诊断和退出。
- 始终显示当前麦克风所有者、Voice 上传状态、工作目录和权限模式。
- 支持全局快捷键、按住说话和 Voice 失败后的文字回退。

### 9.3 模块化

目标目录可以逐步演进为：

```text
src/
├─ voice/
├─ wake/
├─ thread/
├─ settings/
├─ diagnostics/
├─ permissions/
├─ stop/
└─ ui/

src-tauri/src/
├─ codex/
├─ platform/windows/
├─ process/
├─ wake/
├─ voice/
├─ settings/
├─ diagnostics/
└─ commands/
```

拆分时保持 IPC 命令兼容或提供迁移层，不用一次大规模重写替代逐轮验证。

## 10. 阶段六：发布、测试和运维

### 10.1 自动化验证

每轮运行与修改相关的检查，发布候选至少运行：

```text
npm ci
npm test
npm run web:build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
npm run check
npm run build:windows
```

逐步增加：

- 状态机单元测试和非法转换测试。
- wake sidecar 协议测试与 `--test-wake` 集成测试。
- Codex JSON-RPC 契约测试和 app-server 版本兼容提示。
- 带空格、中文、非 ASCII 和长路径工作目录测试。
- Job Object 子进程/孙进程清理测试。
- NSIS 静默安装、覆盖升级、卸载和残留检查。
- Windows CI 产物上传和校验值生成。

### 10.2 人工实机验证

以下项目不能仅凭 CI 声称通过：

- 真实中文、英文唤醒率和误触发率。
- 麦克风、蓝牙耳机和扬声器的获取、释放和切换。
- Codex Voice 实际音频、实时字幕和插话打断。
- Windows 注销/重启后的登录启动。
- 安装、升级、卸载的可视化体验。
- 代码签名后的 SmartScreen 表现。

### 10.3 发布要求

- NSIS 为必须产物；MSI 仅在企业部署需求明确时增加。
- 正式公开分发前使用 Windows 代码签名证书，证书和密码不进入仓库。
- 发布说明包含 Codex realtime 实验接口限制、模型许可证、系统要求和人工验收记录。
- 自动更新必须支持签名校验和失败回滚，不静默替换未签名二进制。

## 11. 阶段七（扩展）：语音与 Agent Provider 可插拔（国人友好版）

### 11.1 背景与目标

现有语音链路与 Agent 执行层绑定 OpenAI 专有设施：前端 WebRTC 直连 `codex app-server` realtime、后端 JSON-RPC thread 体系、认证复用本机 Codex 登录。国内用户缺少账号、支付与网络条件，该链路不可达，语音模块不具备通用性。

目标（借鉴 DSH/Cordis“一切皆是插件”思想，裁剪为 Rust trait + 注册表 + 配置驱动的静态装配）：

1. 语音与 Agent 各收敛为一个对外契约；Codex 从唯一后端降级为其中一个适配器。
2. 新增国内厂商适配器：优先豆包 Realtime（火山方舟，WebSocket + PCM16，国内直连）；其次 Qwen-Omni（百炼）；管线降级模式（ASR→LLM→TTS）作为任意文本 API 的兜底。
3. 提供国内构建变体（`tauri.cn.conf.json`：产品名、标识符、默认 provider），不复制代码库。
4. 核心资源管理（唤醒、麦克风所有权、STOP、Job Object、诊断、持久化）保持厂商无关，不因 provider 切换改变行为。

### 11.2 架构决策：对外一层，对内三层

- 对外唯一契约：`VoiceProvider` trait（`connect` / `interrupt` / `send_text` / `stop` + 统一事件）。核心（状态机、STOP、UI）只依赖该契约，接口风险最小。
- 对内私有模块按三层组织：`transport`（WebRTC / WebSocket / stdio）、`protocol`（各家事件语义映射）、`codec`（PCM16 / Opus）。复用先发生在实现内部，不先建公共 trait。
- 三层提升为公共 trait 的触发条件（三次法则）：同一层被两个以上厂商原样复用，且切法经实践验证（预期豆包落地后 `transport` 与 `codec` 层先触发）。
- 首版不做动态加载（代码签名、诊断确定性、供应链审计成本高）；采用编译期注册 + settings 配置驱动。
- capability flags（`realtime` / `toolEvents` / `interruptable` / `audioFormat`）由适配器声明，UI 与核心据此渲染，不猜测厂商协议。

### 11.3 实施顺序

1. `docs/cn-friendly/PROVIDER_DESIGN.md` 设计文档与契约（事件枚举、capability flags、错误分类、合规清单）先评审后写码。
2. 契约测试先行：仿 §5.4 方法暂存 `tests/contract/`，注入假件驱动，不依赖真实麦克风或网络。
3. Codex 适配器搬迁：把 `main.ts` 的 WebRTC 与 `lib.rs` 的 realtime 调用收敛进 `src-tauri/src/voice/providers/codex/`，行为零变化；157 项契约测试与现有门禁全绿。
4. 豆包 Realtime PoC 适配器（WebSocket + PCM16，官方 Realtime API），契约测试绿。
5. settings 增加 provider 配置段（schema v3 迁移），capability flags 驱动 UI；Key 只存本机、不进日志（沿用现有脱敏要求）。
6. 国内构建变体 `tauri.cn.conf.json` + 发布文档（合规清单：BYOK、AI 合成内容标识、不做中转服务）。
7. 管线降级模式（ASR→LLM→TTS）视需要排期，不作为本阶段门禁。

### 11.4 验收标准

- 步骤 3 完成后：Codex 链路行为与搬迁前一致，`npm run check` 全绿，`git status` 只含应有改动。
- 步骤 4 完成后：豆包适配器契约测试绿；实机执行 §5.3 的 20 次“唤醒→Voice→STOP→重布防”循环，麦克风交接、STOP、诊断与 Codex 模式同标准。
- settings schema 升级无损迁移；切换 provider 后 STOP、麦克风所有权、错误分类均正常。
- 合规核对：不内置任何厂商 Key；日志无凭据；若公开分发，标注 AI 合成内容并完成所需合规事项。
- 留给独立复审 / 用户实机：真实语音质量、打断体验、各厂商错误恢复路径。

## 12. LOOP 实施规则

每轮只处理一个可验证问题：

### L — Locate

- 读取本文和 `WINDOWS_STATUS.md`。
- 检查 Git 状态并保留用户已有改动。
- 找到当前失败或未完成目标的完整调用链。

### O — Outline

- 选择最小、安全、可回退的修改。
- 明确本轮输入、输出、状态转换和验收命令。
- 不用“理论可行”代替可执行证据。

### O — Operate

- 直接修改代码和测试。
- 不硬编码个人环境，不读取凭据，不降低权限，不全局杀进程。
- 如果修改会影响安装包或状态迁移，同时更新文档和兼容逻辑。

### P — Prove

- 运行相关测试、静态检查、构建或实机步骤。
- 失败时读取完整错误，定位根因后重试。
- 通过后更新本文“当前进度”和 `WINDOWS_STATUS.md`，再进入下一轮。

只在以下外部阻塞下暂停：代码签名证书、许可证选择、大型模型的授权或来源、系统级管理员权限、Codex 当前版本不存在所需实验接口、真实音频必须由用户听取确认，或继续操作会影响工作区外数据。

## 13. 当前实施顺序与进度

| 顺序 | 工作项 | 状态 | 完成证据 |
|---|---|---|---|
| 0 | Windows 可运行基线、NSIS、Codex Voice、同 thread、现有 STOP | 已完成 | `WINDOWS_STATUS.md` |
| P0 | 工作区标识规范化、runtime 死亡监控与恢复、安全权限默认（含 Job Object `KILL_ON_JOB_CLOSE` 基础与结构化 runtime 日志 `jarvis-runtime.jsonl`） | 已完成 | 提交 68b41d9 / 319ca1c / 392e84e / 161751f；独立复审通过；45 项 Rust 契约测试 + fmt + clippy `-D warnings` 门禁绿 |
| 1 | 语音/麦克风确定性状态机（执行细则见 §5.4） | 进行中 | 提交 a7b87bc/b181d27/e212ec0：157 项 Rust 契约测试 + fmt + clippy `-D warnings` + 17 项 Node 测试门禁绿；20 次实机循环待验收 |
| 2 | Windows Job Object 与 STOP 进程树兜底 | 待开始 | 子进程/孙进程清理测试 |
| 3 | 一键诊断和脱敏结构化日志 | 待开始 | 故障分类测试 + UI 验证 |
| 4 | 现有唤醒增强和离线关键词引擎评估/接入 | 待开始 | 中英文实机命中记录 |
| 5 | 后端持久化、首次启动向导、托盘和快捷键 | 待开始 | 升级迁移和恢复测试 |
| 6 | 模块化、安装回归、签名和发布收尾 | 待开始 | Windows 发布验收报告 |
| 7 | 语音与 Agent Provider 可插拔（国人友好版，设计见 §11 与 `docs/cn-friendly/PROVIDER_DESIGN.md`） | DSH 语音 UI、最终转写 Agent 衔接及 Agent 结果语音回流已实现 | `voice-contract/` 已含统一事件、豆包旧版/duplex 会话、浏览器编排、可启动 relay、粒子联调页、PCM/WAV 工具，以及 sherpa-onnx WASM 装载与麦克风互斥协调层，当前脏树 106 项测试与浏览器构建全绿；WAV 完整回路及真实 Chrome 的在线 relay、麦克风、回复事件、静音控制和两轮 STOP/重连已通过。相邻 DSH 工作区的 `@deepseek-ai/dsh-client-ui-voice` 已让最终用户转写进入启动语音的同一 DSH session，取消豆包自主回复，并将工具生命周期和最终 Agent 文本按序送回 Duplex 指定文本语音；自动化验证通过，真实 DSH Web 的麦克风转写、Agent 回答及最终回答语音播放也已验收。20 轮压力测试、sherpa 模型资产/真实唤醒及工具进度实机播报仍待验收 |

## 14. 最终完成定义

只有同时满足以下条件，才将本方案标记为完成：

- Windows 冷启动、后台启动、隐藏、唤醒、Voice、文字任务和退出稳定。
- 本地唤醒与 Voice 麦克风互斥，不上传唤醒前持续音频。
- 中英文唤醒达到记录过的可接受命中率，或明确保留快捷键回退并标注限制。
- Codex 在选定目录执行真实任务，每个目录正确续接 thread。
- 三档权限行为与文档一致，没有权限降级。
- STOP 不产生晚到 turn，不恢复已停止 Voice，不遗留当前 runtime 的后台进程树。
- 非技术用户可以通过设置页完成环境检查和常见故障恢复。
- 自动化检查和 Windows CI 通过，NSIS 安装包成功生成。
- 安装、覆盖升级、卸载、登录启动和真实 Voice 完成实机验收。
- 发布文件不包含个人绝对路径、凭据、私密信息或未说明的第三方模型。
- 最终报告列出改动、测试证据、人工验证、已知限制、签名状态和产物位置。
- 若面向国内分发：语音与 Agent 的 Provider 契约落地（对外一层、对内三层），Codex 适配器搬迁零回归，至少一个国内厂商适配器通过契约测试与实机验收。
