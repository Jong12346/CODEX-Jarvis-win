# Jarvis 实机验收（tests/acceptance）

本目录是 Windows 11 真机验收部分，与自动化契约测试（`src-tauri/tests/`）互补：

- 契约测试：纯逻辑，CI 全绿，证明状态机/脱敏/轮转/迁移等行为正确。
- 本目录：真实设备、托盘、快捷键、进程树、GUI 行为，只有人能在真机上确认。

## 结构

| 文件 | 用途 |
|---|---|
| `CHECKLIST.md` | 逐阶段验收剧本：操作、通过标准、证据约定 |
| `jarvis-audit.ps1` | 只读取证脚本：日志汇总、配置摘要（脱敏）、进程树、系统/WebView2 信息 |

## 使用

1. 启动应用（`npm run tauri dev` 或安装包）。
2. 按 `CHECKLIST.md` 逐项操作。
3. 每个用例前可运行取证脚本保存"前"状态，结束后再运行一次保存"后"状态：

```powershell
powershell -ExecutionPolicy Bypass -File tests/acceptance/jarvis-audit.ps1 -OutputPath C:\path\before.txt
```

4. 在清单里逐行记录 `通过/失败 + 证据`，失败项连同证据交回实现侧。

## 注意事项

- 脚本只读，不修改任何文件（除非你指定 `-OutputPath` 写报告）。
- 日志与配置自动定位：优先扫 `%APPDATA%` 下最新的 `jarvis-runtime.jsonl` /
  `settings.json`；也可用 `-LogPath` / `-SettingsPath` 显式指定。
- 配置摘要输出前会脱敏（Bearer / sk- / 代理口令 / 敏感环境变量 / 用户名段）。
- 本目录文件不影响 `npm test`（只匹配 `tests/**/*.test.mjs`）。
