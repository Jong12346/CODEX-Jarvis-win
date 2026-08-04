# Windows 11 开发与验证

本文说明如何在 Windows 11 x64 上查看、开发、构建和安装 Jarvis × Codex。

> 如果命令报错，请先查看 [Windows 常见问题排查](WINDOWS_TROUBLESHOOTING.md)。
> 已完成与仍需人工确认的项目记录在 [Windows 移植验证状态](WINDOWS_STATUS.md)。

## 选择部署方式

- **普通使用者**：安装维护者构建并签名的 NSIS `setup.exe`，不需要 Node.js、Rust
  或 Visual Studio Build Tools。
- **开发者或当前源码使用者**：按本文安装完整构建环境，从源码生成 NSIS 安装包。

本仓库当前重点提供可复现的源码构建流程。公开分发安装包前，应完成代码签名和
本文末尾的实机验收，不应把本地未签名的测试包描述成正式发行版。

## 当前 Windows 实现

- Tauri 2 透明无边框窗口；关闭窗口时隐藏到后台。
- 桌面单实例保护；重复启动只显示并聚焦现有窗口，不创建第二套 Codex/Voice runtime。
- `tauri-plugin-autostart` 登录自启动。
- 本机 `System.Speech` 唤醒 sidecar，不把待机音频发送给 Codex。
- 唤醒后退出 sidecar、释放麦克风，再启动 Codex Voice WebRTC。
- Codex 可执行文件支持环境变量、`PATH`、WindowsApps 别名和设置面板手动选择。
- 工作目录、thread 和三档权限模式沿用跨平台实现。
- STOP 只终止当前应用持有的子进程，不调用全局 `taskkill`。
- Voice 网络瞬断最多自动重连三次；用户 STOP、权限错误和非网络错误不会触发无限重试。
- release 主程序和唤醒器使用 Windows GUI 子系统；Codex app-server 子进程使用 `CREATE_NO_WINDOW`，不显示 Windows Terminal 日志窗口。
- Windows 安装包使用 NSIS。

Windows Voice 与唤醒词仍必须在真实麦克风、已登录的 Codex 和支持 realtime conversation 的 Codex 版本上验证。自动化构建不能代替这些实机项目。

## 在 VS Code 中打开

安装 VS Code 后选择“文件 → 打开文件夹”，打开克隆后的仓库目录，例如：

```text
C:\path\to\jarvis-codex
```

建议安装官方 Rust Analyzer 扩展。TypeScript、Rust、C# 唤醒器、测试、CI 和 Windows 文档都在同一个项目目录内。

仓库已提供 VS Code 任务。重新打开 VS Code 后，可在“终端 → 运行任务”中选择：

- `Jarvis: 开发运行`
- `Jarvis: 完整检查`
- `Jarvis: 构建 Windows NSIS`

## 开发环境

- Windows 11 x64
- Node.js 20 或更高版本
- Rust stable（MSVC toolchain）
- Visual Studio 2022 Build Tools，包含“使用 C++ 的桌面开发”和 Windows SDK
- Microsoft Edge WebView2 Runtime
- 已安装并登录的 Codex，且其 `codex.exe` 支持 app-server realtime conversation
- Windows 语音识别语言包（中文或英文）

检查 WebView2 Runtime：

```powershell
Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F1E7E5D3-44A0-4A15-9A7F-54DB9A9F4A46}' -ErrorAction SilentlyContinue
```

Windows 11 通常已经随系统安装 Evergreen WebView2 Runtime。若缺失，请从微软官方 WebView2 下载页安装 Evergreen Runtime。

## 开发运行

首次获取源码时，在 PowerShell 中执行：

```powershell
git clone https://github.com/Jong12346/CODEX-Jarvis-win.git
cd CODEX-Jarvis-win
npm ci
npm run check
npm run dev
```

已经下载或解压源码时，直接进入包含 `package.json` 的目录，再从 `npm ci` 开始。
项目不要求单独填写 OpenAI API Key；认证复用本机已有的 Codex 登录。

可通过环境变量明确指定 Codex：

```powershell
$env:JARVIS_CODEX_BIN = 'C:\完整路径\codex.exe'
npm run dev
```

也可启动应用后，在设置面板的“Codex 可执行文件”中选择完整路径。路径可以包含空格、中文或其他非 ASCII 字符，不要选择 `.cmd` 或 `.bat` 包装脚本。

Windows 自动发现会检查 `PATH`、npm 全局安装的 `@openai/codex` 原生 x64 程序，以及 WindowsApps Codex 别名；不可读取的候选会被跳过，不硬编码 Codex 版本号。

若 Windows 已启用当前用户的系统代理，而 `HTTP_PROXY` / `HTTPS_PROXY` 未显式设置，Jarvis 会把该代理仅传给自己启动的 Codex 子进程。这可让 Codex realtime WebSocket 与浏览器/VPN 使用相同网络出口；Jarvis 不修改系统代理设置。

唤醒识别器默认优先使用当前 Windows 界面语言，然后尝试已安装的中文、英文识别器。可强制指定：

```powershell
$env:JARVIS_WAKE_CULTURE = 'zh-CN'
npm run dev
```

## 生产构建与 NSIS

```powershell
cd 'C:\path\to\CODEX-Jarvis-win'
npm ci
npm run check
npm run build:windows
```

预期安装包位置：

```text
src-tauri\target\release\bundle\nsis\Jarvis Codex_0.2.0_x64-setup.exe
```

本地构建默认不含可验证的发布者签名。对外分发需要 Windows 代码签名证书；证书和密码不得提交到仓库。MSI 暂未启用，当前优先保证 NSIS 链路。

## 安装、升级和卸载验证

Windows 实机已用 `/S` 完成安装、同版本覆盖升级、卸载和最终重装。卸载器返回成功后，安装目录不存在；最终重装后主程序、唤醒器和卸载器均存在。以下步骤仍可用于发布前的可视化验收：

1. 运行 NSIS 安装包并使用默认安装目录。
2. 从开始菜单启动 Jarvis Codex，确认透明无边框窗口可见。
3. 关闭窗口，确认应用仍在后台；再次启动应重新显示窗口而不是丢失状态。
4. 在设置中选择一个带空格或中文的测试项目目录，并选择有效的 `codex.exe`。
5. 重新登录 Windows，确认应用后台自启动。
6. 用同版本安装包执行覆盖安装，再确认工作目录和 thread 仍能续接。
7. 从“设置 → 应用 → 已安装的应用”卸载，确认应用程序文件已删除且应用不再登录启动。

卸载验证不得删除用户项目目录或 Codex 历史记录。

## Windows 实机验收

在“设置 → 隐私和安全性 → 麦克风”中打开麦克风访问和“允许桌面应用访问麦克风”。安装所需的 Windows 语音语言包后逐项验证：

1. 冷启动、后台启动、窗口隐藏和重新显示。
2. 分别说“Hey Jarvis”和当前识别语言支持的中文唤醒词。
3. 确认唤醒前没有 WebRTC 会话；唤醒后监听器退出，窗口到前台，WebView2 请求麦克风。
4. 说出任务，确认实时字幕、音频回复和工具事件进入同一个 Codex thread。
5. 在 Voice 期间提交文字，确认仍进入当前 thread。
6. 在不同工作目录间切换并保存，确认新目录立即生效，且各自续接自己的 thread。
7. 分别检查安全、自动办公和完全访问模式。
8. 让任务启动一个可辨识的后台子进程，按 STOP，确认 Voice、turn 和该子进程均停止；其他 Codex 或终端进程必须保持运行。

若提示没有语音识别器，请在 Windows 的语言设置中安装对应语言的“语音”组件。`System.Speech` 使用本机桌面识别器；在没有匹配语言包的电脑上不能声称唤醒词已经通过验证。

## 已知限制

- Codex realtime conversation 是实验性 app-server 能力，必须以当前机器上 `codex.exe --help` 和实际 JSON-RPC 握手为准。
- `System.Speech` 一次使用一个已安装的识别文化。中英文同时可靠唤醒仍需双语离线关键词模型或经过实机验证的多语言引擎；当前版本可用 `JARVIS_WAKE_CULTURE` 切换语言。
- Windows 代码签名和真实麦克风/扬声器测试不能在无证书、无交互音频的 CI 中完成。

遇到环境或运行错误时，请查看 [Windows 常见问题排查](WINDOWS_TROUBLESHOOTING.md)。
