<p align="center">
  <img src="src-tauri/icons/icon.png" width="160" alt="Jarvis Codex icon">
</p>

<h1 align="center">Jarvis × Codex</h1>

<p align="center">
  一声“嗨 Jarvis”，让 Codex 从桌面醒来。
</p>

<p align="center">
  <a href="docs/WINDOWS.md">Windows 安装与部署指南</a>
  ·
  <a href="docs/WINDOWS_TROUBLESHOOTING.md">常见问题排查</a>
</p>

<p align="center">
  <img src="public/assets/jarvis-character-v2.png" width="520" alt="Jarvis Codex transparent avatar">
</p>

Jarvis × Codex 是一个 macOS / Windows 本地语音工作入口。说出唤醒词后，透明窗口从桌面升起，
粒子与装甲碎片聚合成 Jarvis；随后通过 Codex app-server WebRTC 进入同一个
Codex Voice 线程。你可以自然对话、打断回复、继续追问，也可以让 Codex 在当前
项目中真正执行任务。

## v0.2.0：透明粒子视觉版

第二版让 Jarvis 成为整个页面的主体，同时保留原有 Voice、线程、权限与 STOP
主链路：

- 窗口背景完全透明，桌面上只保留 Jarvis 头像与必要状态光效
- 每次唤醒时，粒子从窗口四周汇聚，并与装甲碎片、能量环共同组成头像
- 麦克风、文字输入、STOP 和设置按钮默认隐藏，鼠标移入头像区域后才显示
- 麦克风与 STOP 图标重新校正为几何居中
- 根据确认、等待授权、任务完成和异常状态触发不同的角色动作与光效
- Voice 音频电平继续驱动头像呼吸、扫描光和能量强度

视觉层只消费现有音频电平、转写和任务状态事件，不替换唤醒监听、Codex
app-server WebRTC、工作目录线程续接、权限模式或任务中断逻辑。

## 视觉演进

### 第一版（v0.1.x）：全息工作台

![Jarvis Codex v0.1.x 全息工作台](docs/images/jarvis-main-ui.png)

第一版采用完整 HUD 工作台：任务角色、对话记录、文字输入和 STOP 控制都常驻在
页面中，重点是让用户看清 Codex 正在做什么，适合观察任务执行过程与系统状态。

### 第二版（v0.2.0）：透明角色界面

第二版移除常驻面板，只留下透明桌面上的 Jarvis 主体。唤醒时，粒子和装甲碎片
从四周汇聚成完整头像；控制按钮在鼠标移入后出现，界面从“查看一个工作台”转向
“召唤一个真正出现在桌面上的 Jarvis”。

> v0.1 是一套 Jarvis 工作台，v0.2 是一个真正出现在桌面上的 Jarvis。

Codex Voice 已经不只是把语音转成一条文字提示：它支持自然轮流说话、回复中
打断、连续追问，以及在任务执行期间继续检查进度和改变方向。Jarvis × Codex
正是基于这套语音办公能力构建的 macOS 本地入口。

说“嗨 Jarvis”后，全息 GUI 自动升起，并通过 Codex app-server V3 WebRTC
进入同一个 Codex Voice 线程。它不模拟点击 Codex/ChatGPT 窗口、不绑定全局
热键，也不创建第二套 GPT-Live 会话。认证复用本机 Codex 登录；语音、文字、
任务执行和工具事件属于同一个 Codex thread。

> 当前状态：已在 macOS 26 Apple Silicon 实机验证唤醒、实时转写、语音回复和
> Codex 任务执行。Codex realtime conversation 仍是实验性 app-server 能力，
> 上游协议升级时可能需要同步适配。
>
> Windows 11 x64 移植已接入本机唤醒 sidecar、Codex 路径选择、精确子进程停止、
> 双平台 CI 与 NSIS 配置；Voice 和中英文唤醒仍需按 [Windows 验证文档](docs/WINDOWS.md)
> 在真实设备上验收，未执行的实机项目不视为通过。

## Windows 快速部署

本仓库当前提供源码构建流程。普通使用者最终只需要安装构建好的 NSIS 安装包；
从源码构建安装包的电脑需要准备以下环境：

- Windows 11 x64
- Node.js 20 或更高版本
- Rust stable（MSVC toolchain）
- Visual Studio 2022 Build Tools，并安装“使用 C++ 的桌面开发”和 Windows SDK
- Microsoft Edge WebView2 Runtime
- 已安装并登录的 Codex，且 `codex.exe` 支持 app-server realtime conversation
- 中文或英文 Windows 语音识别语言包，以及桌面应用麦克风权限

项目不需要单独填写 OpenAI API Key；认证复用本机已有的 Codex 登录。第一次部署建议
先完整阅读 [Windows 11 开发与验证](docs/WINDOWS.md)，再在 PowerShell 中执行：

```powershell
git clone https://github.com/Jong12346/CODEX-Jarvis-win.git
cd CODEX-Jarvis-win
npm ci
npm run check
npm run dev
```

确认开发模式可以启动后，生成 Windows 安装包：

```powershell
npm run build:windows
```

安装包输出到：

```text
src-tauri\target\release\bundle\nsis\Jarvis Codex_0.2.0_x64-setup.exe
```

若出现 `cargo`、MSVC、Codex 路径、WebView2、语音语言包、麦克风权限、网络代理或
未签名安装包问题，请按 [Windows 常见问题排查](docs/WINDOWS_TROUBLESHOOTING.md)
逐项检查。

## 为什么是现在

[官方 Voice 文档](https://learn.chatgpt.com/docs/features/voice)已经明确：
Voice 可以在 Chat、Work 和 Codex 中协调任务。用户可以在回复过程中打断，
继续追问；当 Codex 开始工作后，还可以继续通过语音检查进度或调整方向。

Jarvis 没有重新制造一套语音模型，而是补上了 Codex Voice 原本缺少的本地入口：

```text
Codex 全双工式语音办公
        ↓
“嗨 Jarvis”本机唤醒
        ↓
全息 GUI + 当前工作目录
        ↓
同一个 Codex thread 持续对话并执行任务
```

这意味着你面对的不是一个只能回答问题的语音助手，而是一个可以边聊、边做、
边汇报、边接受你纠正方向的 Codex 工作入口。

## macOS 三分钟上手

1. 在 Mac 上安装并登录 Codex App、ChatGPT App 或 Codex CLI。
2. 打开 DMG，把 `Jarvis Codex` 拖入“应用程序”。
3. 首次启动时允许麦克风和语音识别权限。
4. 点击右上角“设置”，选择希望 Codex 工作的项目目录。
5. 关闭窗口即可让 Jarvis 留在后台监听。
6. 对电脑说“嗨 Jarvis”，窗口升起后直接说出任务。
7. 将鼠标移到 Jarvis 头像上可显示控制按钮；点击 `STOP` 可立即中断 Voice 和正在进行的任务。

Voice 临时不可用时，可以在底部输入框发送文字任务。语音和文字会进入当前
工作目录对应的同一个 Codex thread；切换工作目录时，Jarvis 会切换到该目录
自己的任务上下文。

## 使用场景

### 全双工式语音协作

你不必等 Jarvis 说完再重新开始一轮。可以在回复中打断、补充条件、追问进度，
或者在 Codex 工作时改变方向：

> “先停一下，不要改接口，只修测试。”

> “现在做到哪一步了？有阻塞就直接告诉我。”

### 边说边改代码

> “嗨 Jarvis，检查这个项目为什么测试失败，找到原因并修复。”

Jarvis 会把任务交给当前工作目录中的 Codex，执行检查、修改和验证，再通过
Voice 回报结果。

### 研究代码库

> “嗨 Jarvis，先读一下这个仓库，告诉我认证流程从哪里进入。”

适合阅读陌生项目、追踪调用链、解释模块关系和定位配置。

### 审查与重构

> “嗨 Jarvis，检查我刚才的修改有没有安全风险，不要直接提交。”

适合代码审查、风险检查、补测试和小范围重构；高风险操作仍需要在界面确认。

### 生成项目材料

> “嗨 Jarvis，根据当前代码更新 README，再给我一份发布清单。”

适合维护说明文档、架构文档、变更记录和交付材料。

## 功能

- 本机唤醒词：嗨/嘿 Jarvis、Hi/Hey Jarvis、嗨/嘿贾维斯
- Tauri 2 + Rust + TypeScript 全息桌面 GUI
- 透明无边框头像界面与粒子/装甲聚合唤醒动画
- 头像悬停显示控制区，待机时自动隐藏外围按钮
- 确认、授权、完成和异常四类沟通动作反馈
- 原生 AVFoundation 权限预检和 Hardened Runtime 音频 entitlement
- WebRTC 麦克风输入、实时音频输出和字幕
- 普通话 / 陕西话语音风格开关；切换时重建 Voice，方言效果以实际模型输出为准
- `thread/realtime/start` V3 直连 Codex Voice
- Voice 自动调用 Codex 完成真实任务并继续语音回报
- STOP 终止 Voice、抑制 transcript tail，并中断晚到的 turn
- 文本输入可加入当前 Voice thread
- 工作目录可配置，每个目录持久化并续接自己的 Codex thread
- 安全、自动办公和完全访问三档 Codex 权限，可在 Jarvis 设置中切换
- 可随时“新开线程”：停止当前任务并创建新的 Codex thread，旧线程仍保留在 Codex 历史中
- 自动办公默认限制在当前工作目录内，越界操作不弹窗并直接失败
- 登录时后台启动，关闭窗口仅隐藏，继续监听唤醒词
- 语音唤醒会激活 macOS 应用并把 Jarvis 窗口升到最前层

## 系统要求

- macOS 13 或更高版本（当前 DMG 面向 Apple Silicon），或 Windows 11 x64
- 已安装并登录 Codex App、ChatGPT App 或 Codex CLI
- 麦克风和语音识别权限

普通安装用户不需要 Node.js 或 Rust。它们只用于源码开发和构建。

## 本地开发

开发环境需要 Node.js 20+ 和 Rust stable。

```bash
npm ci
npm run check
npm run dev
```

设置开发时默认工作目录：

```bash
JARVIS_WORKSPACE=/absolute/path npm run dev
```

也可以在 Jarvis 设置面板保存工作目录；重启后生效。

Windows 用户请查看 [Windows 11 开发、构建与实机验证](docs/WINDOWS.md)。项目可直接
用 VS Code 打开；Windows 安装包使用 NSIS。

## 构建

```bash
npm run build
```

输出：

- `src-tauri/target/release/bundle/macos/Jarvis Codex.app`
- `src-tauri/target/release/bundle/dmg/Jarvis Codex_0.2.0_aarch64.dmg`
- `src-tauri/target/release/bundle/nsis/Jarvis Codex_0.2.0_x64-setup.exe`（Windows）

构建脚本会生成并签名 `JarvisWakeListener.app`。该产物不进入 Git。

## 生产发布

当前仓库默认用 ad-hoc 身份 `-` 方便本机开发。对外分发必须使用 Apple
Developer ID Application 证书并完成 notarization；否则 macOS 无法稳定识别升级
前后的同一应用身份，用户也可能再次遇到权限提示。

安装证书后，可用 Tauri 支持的环境变量覆盖本地 ad-hoc 配置：

```bash
APPLE_SIGNING_IDENTITY="Developer ID Application: Example (TEAMID)" \
APPLE_API_ISSUER="..." \
APPLE_API_KEY="..." \
APPLE_API_KEY_PATH="/absolute/path/AuthKey_XXX.p8" \
npm run build
```

证书、私钥和 Apple 凭据不得提交到仓库。详见
[生产发布清单](docs/PRODUCTION.md)。

## 隐私与安全

- 唤醒词强制使用 `requiresOnDeviceRecognition` 在本机识别。
- 只有唤醒后，麦克风音频才进入 Codex Voice WebRTC 会话。
- 不保存原始音频，不读取或写入登录凭据。
- WebView 使用限制性 CSP，不加载第三方字体或脚本。
- 默认使用“自动办公”：`workspace-write` sandbox 和 `never` approval；
  “安全模式”保留交互审批，“完全访问”需要用户主动选择。
- Siri 不参与主链路。

架构和信任边界见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，安全问题报告方式
见 [SECURITY.md](SECURITY.md)。

## 上游与许可

本仓库基于 [Big-Guan/jarvis-codex](https://github.com/Big-Guan/jarvis-codex)
进行 Windows 适配，并保留上游 Git 历史和作者信息。仓库当前未包含许可证文件；
复制、修改、发布安装包或商业使用前，请先确认上游授权。本仓库不会擅自添加许可证。
