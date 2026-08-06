# Jarvis Windows 实机验收清单

本清单覆盖阶段 1-6 中明确留给"实机/用户手测"的项。自动化契约测试见
`src-tauri/tests/`；本目录只做真实 Windows 11 机器上的行为验收。

记录约定：每个用例一行 `编号 | 通过/失败 | 证据 | 备注`，证据可以是截图、
`jarvis-runtime.jsonl` 片段或本目录脚本的输出。失败项请连同证据贴回给实现侧。

运行取证脚本：`powershell -ExecutionPolicy Bypass -File tests/acceptance/jarvis-audit.ps1`

## A. 阶段 2 — 麦克风确定性交接（最高优先）

| 编号 | 操作 | 通过标准 | 证据 |
|---|---|---|---|
| A-1 | 说"嗨 Jarvis"→ Voice listening → STOP → 回到 ready，连续 20 次 | 每轮都回到 ready；麦克风按钮仅 Voice 期间点亮；无卡死/无重复 Voice | 每 5 轮截图；日志中每轮状态链为 WakeReady→…→VoiceListening→VoiceStopping→WakeRearming→WakeReady |
| A-2 | Voice 中插拔蓝牙耳机 / 切换默认麦克风 | UI 出现可读提示，不卡死、可恢复 | 截图 + 日志 |
| A-3 | 用录音机等先占用麦克风再唤醒 | 出现"麦克风被占用/权限"类提示（黄/红），不静默失败 | 截图 + 日志 |
| A-4 | 冷启动、后台启动、窗口关闭后再唤醒 | 都走同一状态机，最终进入 Voice | 截图 + 日志 |

## B. 阶段 3 — STOP 进程树有序兜底

| 编号 | 操作 | 通过标准 | 证据 |
|---|---|---|---|
| B-1 | 文字任务让 Codex 启动长驻子进程（如 `Start-Process cmd -ArgumentList '/c ping -t 127.0.0.1'`）后 STOP | 5 秒后本 runtime 子树无残留 | STOP 前后进程树快照 |
| B-2 | 同时运行另一套 Codex / 终端，STOP | 它们继续存活 | 快照 + 日志 |
| B-3 | 连续快速 STOP 5 次 | 不报错、不重复杀、Voice 不复活 | 日志 stop_sequence 只有一条完整序列 |
| B-4 | 任务管理器强关 Jarvis 主进程 | kill-on-close 数秒内清理子进程 | 快照 |
| B-5 | 日志核对 | 出现 sendRealtimeStop→sendTurnInterrupt→waitGrace→killJobTree(或自退跳杀)→rebuild→done | 日志片段 |

## C. 阶段 4 — 一键诊断与脱敏

| 编号 | 操作 | 通过标准 | 证据 |
|---|---|---|---|
| C-1 | 设置 → 一键检查 | 7 项全部有绿/黄/红结果 | 截图 |
| C-2 | 断网后重跑；系统设置禁用麦克风后重跑 | 网络/麦克风分别给不同码与中文建议 | 截图 |
| C-3 | 复制诊断 → 粘贴到记事本 | 全文无 Bearer/sk-/代理密码/用户名段；路径保留结构 | 粘贴文本 |

## D. 阶段 5 — 后端版本化持久化

| 编号 | 操作 | 通过标准 | 证据 |
|---|---|---|---|
| D-1 | 旧版 localStorage 用户升级 | workspace 规范落盘、threads 含同一 threadId | settings.json 片段 |
| D-2 | 工作目录改大小写后重启 | 仍续接同一 thread | 截图 + settings.json |
| D-3 | 手动损坏 settings.json 后重启 | 从 .bak 回退并重写有效配置 | settings.json + 日志 |
| D-4 | 权限设 full → 重启 | 读回为 safe（存储态降级） | 截图 + settings.json |

## E. 阶段 6 — 首次启动向导 / 托盘 / 全局快捷键

| 编号 | 操作 | 通过标准 | 证据 |
|---|---|---|---|
| E-1 | 删除 settings.json 后启动 | 出现向导；阻塞项（如不可读工作目录）为红且"继续"置灰 | 截图 |
| E-2 | 托盘逐项：显示/隐藏/唤醒/文字模式/STOP/诊断/退出 | 行为正确；Voice 未连接时 STOP 置灰 | 截图 |
| E-3 | 设置 Alt+Shift+J 保存 | 前台/后台/窗口关闭后按下均能唤醒 | 截图 + 日志 |
| E-4 | 设置 Ctrl+Alt+Del | 保存时报"与系统保留快捷键冲突" | 截图 |

## 验收顺序建议

A（20 次循环）→ B → C → D → E。A 是后续所有阶段的地基。
