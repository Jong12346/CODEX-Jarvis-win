# Windows 移植验证状态

验证环境：Windows 11 x64，Node.js 20+，Rust stable MSVC，Tauri 2，WebView2。

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
