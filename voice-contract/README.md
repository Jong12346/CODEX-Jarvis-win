# voice-contract — 贾维斯豆包实时语音 PoC

把 Jarvis 演进为 DSH 生态语音插件的第一阶段实现：语音 provider 契约、豆包协议适配、本地 WebSocket relay、浏览器麦克风采集、PCM 回放、Jarvis 粒子状态视觉和 sherpa-onnx 浏览器唤醒接入层。纯逻辑核心保持零依赖；relay 使用 `ws`，当前 106 项测试全绿。

## 这是什么

- 可离线验证的核心：类型 + 纯函数 + 状态机，`node --test` 直接运行；relay 集成测试只连接本地伪上游。
- 对应旧 Rust 契约 tests/contract/voice_provider.rs 的 TS 平译（语义逐条对齐）。
- 本目录继续作为可独立验证的参考实现；正式 DSH 落地已在相邻 monorepo 中形成 `@deepseek-ai/dsh-client-ui-voice` 包。

## 模块

| 文件 | 职责 | 测试 |
|---|---|---|
| voice-events.ts | 契约：统一事件(type 判别+camelCase)、错误分类、capability 控制面、厂商事件映射、切换有序关闭、D4 无 thread、BYOK 仅 Ref、provider 生命周期义务 | 17 |
| doubao-codec.ts | 豆包二进制帧编解码：header 位域 + 可选字段 + payload（大端）、事件号常量全表 | 7 |
| doubao-map.ts | 豆包 ServerEvent → UnifiedVoiceEvent（ASR→transcript、TTS→audioFrame、CHAT→transcript、错误→ProviderError） | 9 |
| doubao-session.ts | 会话驱动状态机：connecting→starting→active→closed 握手、送音频/文字、有序关闭；socket/emit 全注入可测 | 6 |
| voice-client.ts | 顶层编排：把会话、麦克风、扬声器、WebSocket 生命周期、握手超时、STOP 串起来；socket/mic/speaker/clock 全注入可测 | 6 |
| relay.ts | 本地 relay 双向转发核心：保持 JSON 文本帧和二进制帧类型 | 5 |
| relay-server.mjs | 可启动的 localhost WebSocket 服务：注入单 `X-Api-Key`、限制回环监听和本地 Origin、连接真实上游 | 3 |
| pcm.ts | 音频格式转换：float32→int16、线性重采样（浏览器麦克风→豆包 24kHz） | 7 |
| wav-audio.mjs | 自检 WAV 严格解析、PCM16 转换、响度测量与 WAV 输出 | 4 |
| browser-adapters.ts | 浏览器薄胶水：Duplex relay、getUserMedia→PCM16/16kHz/20ms 分帧、24kHz 连续 WebAudio 播放 | 7 |
| doubao-duplex.ts | 新版实时语音对话 3.0（Seeduplex/2549778）：JSON 会话 + 事件映射 + 函数调用 + 静音保活 + 优雅关闭；单 X-Api-Key 鉴权 | 12 |
| doubao-duplex-client.ts | Duplex 浏览器编排：连接、握手门禁、麦克风/扬声器路由、mute/unmute、优雅关闭和错误收口 | 8 |
| particle-visualizer.ts | 从现有 Jarvis 界面迁移的粒子核心：连接成形、状态配色、麦克风/扬声器电平响应 | 浏览器构建 |
| wake-coordinator.ts | 唤醒与实时对话的麦克风互斥：释放确认、重复命中抑制、STOP 后重布防 | 8 |
| sherpa-kws-browser.ts | 官方 sherpa-onnx WASM KWS 装载、浏览器采集、16kHz 重采样与关键词事件 | 6 |

## 跑测试

    node --test voice-events.test.ts doubao-codec.test.ts doubao-map.test.ts doubao-session.test.ts
    # 或
    npm test

要求 Node >= 22（用原生 TypeScript type-stripping 跑 .ts，无需构建）。

## 真实服务自检

1. 双击 `run-conversation.bat`，掩码输入 API Key。该脚本走官方“打招呼/指定文本播报”路径，只有在收到有效幅度的 PCM 音频并完成优雅关闭后才返回成功，音频写到 `.tmp/reply.wav`；此路径不要求模型回复文本事件。
2. 人工试听 `.tmp/reply.wav`；自动响度检查只能排除静音，不能判断内容和听感。
3. 双击 `run-audio-input.bat`，验证输入音频经过 ASR 后能收到转写、文本回复和有效幅度的音频回复。

文件音频发送完毕后，自检会依次发送 `input_audio_buffer.commit`（结束 ASR）和 `input_audio_mute.commit`（关闭麦克风后的全双工保活）。

也可离线检查任意 WAV：`node voice-contract/inspect-audio.mjs <文件路径>`。该命令不读取凭据、不联网、不播放音频。

## 浏览器联调

1. 先在 `voice-contract` 目录运行 `npm install`，再双击 `voice-contract/run-relay.bat`，掩码输入豆包 API Key。relay 只监听 `127.0.0.1:8787`，Key 只存在于该进程的环境变量中。
2. 保持 relay 终端运行，双击 `voice-contract/run-browser-poc.bat`。浏览器会打开 `http://127.0.0.1:1421/browser-poc.html`。
3. 点击“开始对话”，允许麦克风权限，确认页面出现用户转写、模型回复且能听到声音；最后点击“停止”，确认状态变为“已停止”。

可先执行 `npm run voice:build` 做无设备构建校验。真实麦克风、扬声器、浏览器权限和豆包在线链路仍属于人工验收。

## 离线唤醒资产

页面会检查 `/wake/sherpa-kws-manifest.json`。资产缺失时显示“离线唤醒模型未安装”，不会影响“开始对话”手动入口。WASM 与模型文件的目录格式、清单样例和分发约束见 `public/wake/README.md`。

当前代码已实现官方 `createKws` 包装器的加载、16kHz 输入、关键词结果处理，以及“唤醒先释放麦克风 → 豆包获取麦克风 → STOP 后重新布防”的有序交接。仓库没有内置模型二进制；正式打包前仍需完成模型版本、许可证、校验值和中英文唤醒实测。

## 豆包 S2S 协议事实（已核实）

- 端点：wss://openspeech.bytedance.com/api/v3/realtime/dialogue（自定义**二进制** WS，非 OpenAI 兼容 JSON）。
- 鉴权头：X-Api-App-ID、X-Api-Access-Key、X-Api-Resource-Id(=volc.speech.dialog)、X-Api-App-Key、X-Api-Connect-Id。
- 帧结构：Header(4B) + 可选字段(error_code/sequence/event_id/connect_id/session_id) + payload_size(4B) + payload；大端。
- 事件号 >=100 为 session 级；音频走 AUDIO_ONLY_REQUEST + TASK_REQUEST(200) 原始 PCM16（s16le@24kHz）。
- 载荷字段（取自官方 demo）：ASR_RESPONSE 的 results[].text/is_interim、CHAT_RESPONSE 的 content、DIALOG_COMMON_ERROR 的 message。
- **结论**：旧版 S2S 事件表不含工具/函数调用 → 分离模式。
- **新版 duplex（2549778，主路径）**：/api/v3/duplex/realtime/dialogue、WebSocket 文本 JSON、单 X-Api-Key、model 固定 1.2.6.1、输入 16kHz PCM、输出默认 OGG-Opus（要 PCM 在 extension.tts.audio_config 配 24000Hz）、**支持函数调用**（session.tools + call_id 配对回传）、关麦须发 input_audio_mute.commit 保活、优雅关闭须等 session.closed。
- **结论更新**：新版支持函数调用 → 可走「一体化模式」（语音会话内直接调工具）；AgentBackend 仍归 DSH/上层，按 call_id 执行并回传。

## 契约语义来源

- docs/cn-friendly/PROVIDER_DESIGN.md §5 / §5.3（D1–D4 决策 + 契约冻结的纯函数）。
- tests/contract/voice_provider.rs（Rust 版契约，17 项，保留为语义参考）。

## 下一步（需浏览器/实机）

1. 构建并放入官方 sherpa-onnx WASM KWS 与模型资产，实测中英文唤醒词。
2. 在真实 DSH Agent 与豆包链路上验收工具进度播报；最终回复语音回流已通过真实浏览器验收，自动化组装测试覆盖取消豆包自主回复及指定文本播报请求。
3. 将当前已通过的两轮 STOP/重连扩展到 20 轮压力验收。
