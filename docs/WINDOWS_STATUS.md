# Windows 移植验证状态

验证环境：Windows 11 x64，Node.js 20+，Rust stable MSVC，Tauri 2，WebView2。

## 当前未提交豆包 PoC 验证（2026-09-08）

- `voice-contract` 当前脏树执行 `npm test`：106/106 通过；覆盖 WAV 严格解析与响度测量、指定文本播报、“结束 ASR → 静音保活”、Duplex 浏览器编排、本地 relay 鉴权转发、浏览器音频分帧/回放调度，以及唤醒/实时对话麦克风交接。
- 当前脏树已实跑 `run-conversation.bat`：收到 PCM16/24kHz/单声道音频，时长 2671ms，peak 27566、RMS 5024.467、无削波，随后收到 `session.closed`；PCM 输出配置和指定文本播报链路通过，内容与听感仍需人工试听。
- 本次服务端没有发 `response.output_text`。官方将 `speech_text_buffer.commit` 定义为“打招呼/指定文本播报”，只要求 TTS 音频；原自检把 Chat 文本列为必需条件属于假失败，当前脏树已修正。
- 三个 `run-*.bat` 原有 PowerShell 路径包含隐藏回车字符；当前脏树已改为真实反斜杠，并通过字节级检查。两个在线脚本均已通过用户掩码输入豆包 Key 实跑。
- 播报自检仅在有效幅度 PCM 音频和 `session.closed` 均出现时成功；音频输入自检要求非空 ASR 转写、模型文本回复、有效幅度音频和优雅关闭。两者与 `DoubaoDuplexSession` 共用会话载荷，避免配置漂移。
- 音频输入复测已通过完整回路：输入 WAV 转成 PCM16/16kHz/单声道后，服务端确认音频提交，最终 ASR 为“你好，请介绍一下你自己。”，随后收到模型文本、PCM16/24kHz/单声道回复音频和 `response.done`，并优雅关闭会话。输出音频时长 12892ms，peak 30557、RMS 5655.945、无削波；内容与听感仍需人工试听。
- 本地 relay 已落成可启动服务：仅监听回环地址、限制本地浏览器 Origin、从进程环境注入单 `X-Api-Key`，并用本地伪上游验证文本/二进制帧类型和拒绝远程 Origin。
- 用户已在真实 Chrome 中完成浏览器联调：页面通过 `127.0.0.1:1421` 连接本地 relay 与 Doubao Duplex，浏览器麦克风权限、在线 relay、回复事件、mute 控制和粒子界面均正常。随后连续完成两轮“建立会话 → 模型回复 → STOP”，页面两次回到“已停止”，没有旧会话或自动重连复活；20 轮压力验收仍待执行。
- 现有 Jarvis 头盔与粒子视觉已迁入联调页，语音状态驱动成形、监听、回复、静音、关闭和错误配色，麦克风/扬声器电平驱动粒子强度；`npm run voice:build` 构建 13 个模块成功，并用独立本地端口完成无凭据截图检查。
- 浏览器唤醒接入层已实现：探测本地 sherpa-onnx 资产、加载官方 WASM KWS 包装器、16kHz 采集与重采样、重复命中抑制，并确保唤醒引擎释放麦克风后才启动豆包、豆包停止后才重新布防。仓库未内置模型/WASM 二进制；真实关键词命中仍待完成官方资产构建、许可证记录和实机测试。
- DSH 相邻工作区已实现 `@deepseek-ai/dsh-client-ui-voice`：Host 使用 `webServer` + `credentials` 提供同源配置与鉴权 relay，浏览器在会话输入区注册语音按钮和活动状态条。API Key 只在每次上游连接时由 Host 解析。每条最终用户转写通过 scope 固定的 `conversation.send()` 进入启动语音的同一 DSH session，沿用该会话的 Agent、模型、工具、记忆和持久历史，并且不会覆盖输入框草稿。最终转写会先取消豆包自主回复；DSH 工具开始、完成/失败与最终 Agent 回复会按序通过指定文本播报回流 Duplex。插件 17 项包内测试、Host/Client 类型检查、包构建、Web 前端生产构建及 2 项 Playwright 组装测试均通过；真实豆包听感和离线唤醒平移仍待人工验收。
- 用户已在真实 DSH Web 与豆包 Duplex 链路完成“浏览器麦克风 → 实时转写 → 当前 DSH session → Agent 最终回复 → 指定文本语音播放”验收。实机暴露的静音结束语音问题已修复：静音先发送 `input_audio_buffer.commit` 再发送 `input_audio_mute.commit`，并在服务端缺少 `transcription.completed` 时用最后的完整 ASR 假设提交一次、抑制迟到的重复完成事件。语音包测试 17/17、Client 类型检查和相关 oxlint 均通过；工具进度播报仍只有自动化证据。

## 已通过

- `npm ci`
- `npm test`：14/14
- `npm run web:build`
- `cargo fmt --manifest-path src-tauri/Cargo.toml --check`
- `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- `npm run check`
- `npm run build:windows`
- release 应用冷启动、透明无边框窗口和 WebView2 加载
- 登录启动项写入当前用户 Run 项，使用 `--background`
- Windows 本机唤醒器构建、无控制台 PE 验证、`zh-CN` 识别器和麦克风 ready
- 自动跳过不可启动的 WindowsApps Codex，选择可运行的 npm 原生 `codex.exe`
- Codex app-server initialize、thread 创建和 realtime V3 SDP 握手
- Windows 系统代理仅传递给 Jarvis 启动的 Codex 子进程
- WebRTC realtime transcript 事件和 Codex turn 完成事件
- STOP 关闭 realtime、抑制 transcript tail、等待晚到 turn 收尾，并只清理当前 runtime 持有的后台终端
- NSIS 静默安装、同版本覆盖升级、静默卸载和最终重装；卸载后程序目录已移除
- Windows“已安装的应用”注册项指向用户安装目录及其卸载器
- 已安装版本从用户安装目录冷启动，窗口标题、前台句柄和响应状态正常
- 单实例实机验证：第二次启动自动退出并唤起原窗口，只保留一个 Jarvis runtime
- 主程序和 Windows 唤醒器均为 Windows GUI PE；npm Codex app-server 使用 `CREATE_NO_WINDOW`，release/Voice 启动不再出现 Windows Terminal 日志窗口
- Voice 对连接重置、缺少 TLS closing handshake 和超时进行最多三次递增退避重连；STOP 会抑制重连
- 目标中文路径立即生效；文字任务在该目录读取 `package.json` 并返回项目名 `jarvis-codex`
- Voice transcript、Voice 内文字任务、工具调用和完成事件进入同一个 Codex thread
- 当前用户登录启动项指向最终安装目录，并带有 `--background`

## 产物

```text
src-tauri\target\release\jarvis-codex.exe
src-tauri\target\release\bundle\nsis\Jarvis Codex_0.2.0_x64-setup.exe
```

## 仍需人工实机确认

- 分别说出 “Hey Jarvis” 和中文唤醒词，观察窗口前台唤起。
- 确认扬声器能听到 Voice 回复。
- 关闭窗口后确认应用留在后台，并用唤醒词重新显示。
- 注销或重启 Windows 后确认登录启动项能在真实登录流程中后台启动。

## 发布限制

- 本地产物未使用 Windows 代码签名证书；对外发布前必须签名。
- Codex realtime conversation 是实验接口，已按本机 app-server Schema 和实际握手验证，但上游协议仍可能变化。
- `System.Speech` 一次使用一个识别文化；中英文同时可靠唤醒需要后续双语离线关键词模型实机验证。
