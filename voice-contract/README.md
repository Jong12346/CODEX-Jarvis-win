# voice-contract — 贾维斯语音插件纯逻辑层

把 Jarvis 演进为 DSH 生态语音插件的「可离线验证」部分：语音 provider 契约 + 豆包 S2S 二进制协议 codec/map/session。零依赖、契约先行、68 项测试全绿。

## 这是什么

- 与浏览器/DSH 无关的纯逻辑：类型 + 纯函数 + 状态机，node --test 直接跑，不碰 DOM、网络、麦克风。
- 对应旧 Rust 契约 tests/contract/voice_provider.rs 的 TS 平译（语义逐条对齐）。
- 落地形态为「独立包」（不污染 DSH monorepo），后续打包成 dsh-plugin bundle 挂进 DSH。

## 模块

| 文件 | 职责 | 测试 |
|---|---|---|
| voice-events.ts | 契约：统一事件(type 判别+camelCase)、错误分类、capability 控制面、厂商事件映射、切换有序关闭、D4 无 thread、BYOK 仅 Ref、provider 生命周期义务 | 17 |
| doubao-codec.ts | 豆包二进制帧编解码：header 位域 + 可选字段 + payload（大端）、事件号常量全表 | 7 |
| doubao-map.ts | 豆包 ServerEvent → UnifiedVoiceEvent（ASR→transcript、TTS→audioFrame、CHAT→transcript、错误→ProviderError） | 9 |
| doubao-session.ts | 会话驱动状态机：connecting→starting→active→closed 握手、送音频/文字、有序关闭；socket/emit 全注入可测 | 6 |
| voice-client.ts | 顶层编排：把会话、麦克风、扬声器、WebSocket 生命周期、握手超时、STOP 串起来；socket/mic/speaker/clock 全注入可测 | 6 |
| relay.ts | 本地 relay 双向转发核心：承载豆包鉴权头，浏览器只连本地（因浏览器 WebSocket 无法设自定义头） | 4 |
| pcm.ts | 音频格式转换：float32→int16、线性重采样（浏览器麦克风→豆包 24kHz） | 7 |
| browser-adapters.ts | 浏览器薄胶水：本地 relay WebSocket 工厂、getUserMedia 采集、WebAudio 播放；浏览器行为留实机联调 | 3 |
| doubao-duplex.ts | 新版实时语音对话（Seeduplex/2549778）：JSON 会话 + 事件映射 + 函数调用；单 X-Api-Key 鉴权 | 9 |

## 跑测试

    node --test voice-events.test.ts doubao-codec.test.ts doubao-map.test.ts doubao-session.test.ts
    # 或
    npm test

要求 Node >= 22（用原生 TypeScript type-stripping 跑 .ts，无需构建）。

## 豆包 S2S 协议事实（已核实）

- 端点：wss://openspeech.bytedance.com/api/v3/realtime/dialogue（自定义**二进制** WS，非 OpenAI 兼容 JSON）。
- 鉴权头：X-Api-App-ID、X-Api-Access-Key、X-Api-Resource-Id(=volc.speech.dialog)、X-Api-App-Key、X-Api-Connect-Id。
- 帧结构：Header(4B) + 可选字段(error_code/sequence/event_id/connect_id/session_id) + payload_size(4B) + payload；大端。
- 事件号 >=100 为 session 级；音频走 AUDIO_ONLY_REQUEST + TASK_REQUEST(200) 原始 PCM16（s16le@24kHz）。
- 载荷字段（取自官方 demo）：ASR_RESPONSE 的 results[].text/is_interim、CHAT_RESPONSE 的 content、DIALOG_COMMON_ERROR 的 message。
- **结论**：豆包 S2S 事件表不含工具/函数调用事件 → 走「分离模式」：语音转写 → DSH agent 执行 → 文本回流语音；AgentBackend 归 DSH 自身。

## 契约语义来源

- docs/cn-friendly/PROVIDER_DESIGN.md §5 / §5.3（D1–D4 决策 + 契约冻结的纯函数）。
- tests/contract/voice_provider.rs（Rust 版契约，17 项，保留为语义参考）。

## 下一步（需浏览器/实机）

1. 浏览器胶水：getUserMedia 采集 + 真实 WebSocket + AudioContext 播放，薄薄包一层 DoubaoSession。
2. DSH 客户端插件骨架（packages/client/ui-voice 或独立 dsh-plugin bundle）。
3. 粒子界面迁移 + sherpa-onnx-wasm 唤醒词。
4. 豆包实机联调（需 AppID + Access Key）。
