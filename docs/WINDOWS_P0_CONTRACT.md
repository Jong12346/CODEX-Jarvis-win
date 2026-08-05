# Jarvis Codex — 阶段 0 交付：P0 核验清单与实现契约

- 核验基线：`43b1121`（`agent/windows-voice-polish`），工作树仅含 `docs/WINDOWS.md` 未提交修改与未跟踪的 `docs/WINDOWS_OPTIMIZATION_PLAN.md`，均未改动。
- 核验环境：Windows 11 家庭中文版 `10.0.26100.7171` AMD64，`rustc 1.97.1`。
- 本文档不含生产代码改动。定位一律按符号名，不按行号。
- 分工模式 (b)：纯函数提取由 Codex 完成，本文档只提出建议签名。

---

## 1. 核验结果清单

| 编号 | 报告结论 | 核验判定 | 说明 |
|---|---|---|---|
| P0-1 | 路径规范化导致 thread 孤立 | **成立，且触发路径比报告更确定** | 主因不是 Codex 侧 resume 失败，而是前端 localStorage key 分裂。已获得确定性复现。 |
| P0-2 | app-server 死亡未被检测 | **成立，严重度维持 P0** | 完全无监控。附带 90 秒挂起，比报告描述更糟。 |
| P0-3 | 自动批准下默认工作区为用户主目录 | **成立，严重度维持 P0，但成因需修正** | 报告归因于默认工作区；实际是"主目录默认"＋"auto 为前端默认值"＋"UI 标注为推荐且文案失真"三者叠加。 |
| P1-9 | 测试基线是源码正则 | **成立，建议提升优先级** | 不只是低价值，它会直接判定三个 P0 修复为失败。 |

### 1.1 P0-1 成立，触发路径需修正

实测（`std::fs::canonicalize`，本机）：

```
C:\Users\DELL          -> \\?\C:\Users\DELL
c:\Users\DELL          -> \\?\C:\Users\DELL     （盘符大小写已归一）
C:\Users\DELL\         -> \\?\C:\Users\DELL     （尾分隔符已剥离）
C:/Users/DELL          -> \\?\C:\Users\DELL     （正斜杠已归一）
C:\Users\DELL\.        -> \\?\C:\Users\DELL     （点段已归一）
\\?\C:\Users\DELL      -> \\?\C:\Users\DELL     （幂等成立）
C:\PROGRA~1            -> \\?\C:\Program Files  （8.3 短名已展开）
//localhost/C$/Users   -> \\?\UNC\localhost\C$\Users
C:/                    -> \\?\C:\               （注意：驱动器根保留尾分隔符）
```

关键测量结果：**`canonicalize(x) != x`**，即 `\\?\C:\Users\DELL` ≠ `C:\Users\DELL`。

`canonicalize` 本身是自洽且幂等的，所以报告中"规范化不一致"的表述需要修正为：**规范化只被应用在部分入口**。

- `default_workspace`（`lib.rs`）：`JARVIS_WORKSPACE` 分支调用 `canonicalize`，而 `USERPROFILE`/`HOME` 回退分支**只做 `to_string_lossy()`，不规范化**。同一个命令返回两种表示。
- `validate_workspace` → `validated_workspace`：始终返回 `\\?\` 形式。
- 前端 `WORKSPACE_KEY` 存的就是上面两者之一，thread key 由它拼接：`` `${THREAD_KEY_PREFIX}${workspace}` ``。

因此 thread key 在同一台机器、同一个目录下存在两个值：

```
jarvis.threadId:C:\Users\DELL          ← 首次启动，来自 default_workspace
jarvis.threadId:\\?\C:\Users\DELL      ← 保存设置之后，来自 validate_workspace
```

**确定性复现（不依赖 Codex 内部行为）**

1. 全新安装（`localStorage` 为空），启动 Jarvis。`workspace` = `C:\Users\DELL`。
2. 发一条文字任务，产生 thread A，写入 `jarvis.threadId:C:\Users\DELL`。
3. 打开设置。工作目录输入框已预填 `C:\Users\DELL`。
4. **什么都不改，直接点"保存"。**
5. `validate_workspace` 返回 `\\?\C:\Users\DELL`；前端 `workspaceChanged` 判定为 `true`（字符串不等），`runtimeChanged` 随之为 `true`。
6. 结果：运行时被 `shutdown` 重建；`WORKSPACE_KEY` 改写为 `\\?\` 形式；`savedThreadId()` 在新 key 下为 `null`。
7. 下一次任务以 `threadId: null` 启动 → **全新 thread，thread A 被静默孤立。**

修复前预期失败表现：点"保存"而不做任何修改，会中断正在进行的任务并丢弃历史线程；设置面板中的 thread id 显示为 `Not started`。
该缺陷每次全新安装只触发一次（此后 key 已是 `\\?\` 形式，幂等），这使它极易在测试中被漏掉。

**同一编号下的三个独立子缺陷**（修复需全部覆盖）

- (a) `default_workspace` 的主目录回退分支不规范化 → 表示分裂。上述复现的直接成因。
- (b) `ensure_runtime` 中 `thread/resume` 失败被 `Err(_) =>` 吞掉并静默回退到 `thread/start`。第二条孤立路径，且用户永远不会被告知。
- (c) `start_jarvis` 返回的 `SessionInfo.cwd` 是**未经校验的原始入参**，不是 `validated_workspace` 的结果。前端把它显示在设置面板里，与后端 `runtime.workspace` 不是同一个字符串。

附带影响：`\\?\` 形式会作为 thread 的 `cwd` 与沙箱根发给 Codex app-server，并被 Codex 持久化。是否被下游正确处理**未验证**，属实机项（见 §3）。

### 1.2 P0-2 成立

- `CodexRuntime::spawn` 起两个读取任务。stdout 任务在 `while let Ok(Some(line))` 上循环，EOF 后**直接结束，不做任何事**：不改状态、不发事件、不清理 `AppState.runtime`。
- `CodexRuntime` 持有 `child: Mutex<Child>`，但全仓库**没有任何一处对该 child 调用 `try_wait`/`wait`**。`try_wait` 仅出现在唤醒监听器的监督循环中，与 Codex 子进程无关。
- 全仓库 `#[cfg(test)]` / `#[test]` 数量：**0**。

后果链：

1. `AppState.runtime` 永远保持 `Some(...)` → `runtime()` 继续返回 `Ok`。
2. `direct_voice_status` 报告 `codexConnected: true` —— **对已死进程报告已连接**。
3. `pending` 表中的 oneshot sender 永不被 resolve → 每个在途请求走满 `timeout(Duration::from_secs(90))` 才返回"响应超时"。这是用户可见的主要症状：**90 秒无响应挂起**。
4. 新请求写入已死 stdin，返回原始 io 错误字符串，与真实原因无关。
5. `kill_on_drop(true)` 只在 `Arc` 析构时生效，而 `AppState.runtime` 永久持有它 → 已死未回收的子进程长期滞留。
6. 前端没有任何"运行时消失"的处理路径：`handle()` 只对 `thread/realtime/*` 与 `turn/*` 方法反应。

修复前预期失败表现：从任务管理器结束 `codex.exe` 后，Jarvis 界面无任何变化，设置面板仍显示已连接；下一条指令挂起约 90 秒后报超时。

### 1.3 P0-3 成立，成因需修正

三个因素叠加，缺一不可，报告只记录了第一个：

1. `default_workspace` 在 Windows 上优先返回 `USERPROFILE`，即 `C:\Users\DELL` —— 整个用户配置目录。
2. 前端 `storedPermissionMode()` 在无存储值时**默认返回 `"auto"`**。
3. `PermissionMode::Auto` → `approval_policy: "never"` + `sandbox: "workspace-write"`。

全新安装的首次状态即为：**工作区 = 整个 `%USERPROFILE%`，审批 = 从不询问**。可无提示写入范围包括 `.ssh`、`.aws`、`.gitconfig`、`.codex/config.toml` 本身、`AppData\Roaming`（浏览器配置、令牌缓存）、Desktop、Documents。

UI 层加重了这一点，属于同一编号下必须一并修复的部分：

- `permissionLabels.auto` = `"自动办公 · 当前目录自主执行"`；单选项副文案 `"当前目录内自主执行，越界操作直接阻止"`。当"当前目录"就是整个用户配置目录时，"越界直接阻止"字面为真而实际无意义 —— **文案失真**。
- 该选项带 `class="recommended"` 与 `<em>推荐</em>` 标记。**风险最高的可用默认值同时被标为推荐值。**

修复前预期失败表现：全新安装后不做任何设置，权限面板显示"自动办公"被选中并标注"推荐"，而工作目录为 `C:\Users\DELL`，且不会出现任何审批弹窗。

附带（同类，不新增任务）：`default_workspace` 在所有 home 变量都不可用时回退到 `std::env::current_dir()`。GUI 从资源管理器启动时该值可能是安装目录或系统目录。

### 1.4 P1-9 成立，建议提升优先级

`tests/wav.test.mjs` 共 189 行，全部为对源码文本的 `assert.match` / `assert.doesNotMatch`。**没有任何一行执行被测代码**：无 import、无函数调用。文件名为 `wav.test.mjs`，内容与 WAV 无关。

断言标的包含：注释、中文 UI 文案、字面循环上界、精确 Rust 表达式。例如断言 `AVAudioEngine releases the input device asynchronously`（注释）、`原线程仍保留在 Codex 历史记录中`（UI 文案）、`for _ in 0..6`（循环上界）、`existing.permission_mode == permission_mode`（表达式）。

**与三个 P0 修复的直接冲突**（这是提升优先级的理由）：

| 现有断言 | 冲突的修复 |
|---|---|
| `assert.doesNotMatch(backend, /taskkill\|Stop-Process/)` | P0-2 若在恢复/进程树清理中出现 `Stop-Process` 字样即失败 |
| `assert.match(backend, /validated_workspace/)`、`/fn validate_workspace\(cwd: String\)/` | P0-1 一旦重命名或改签名即失败 |
| `assert.match(backend, /existing\.permission_mode == permission_mode/)` | P0-1/P0-2 修改运行时复用判据即失败 |
| `assert.match(backend, /"app-server",\s*"--enable",\s*"realtime_conversation",\s*"--stdio"/)` | P0-2 若需追加启动参数即失败 |
| `assert.doesNotMatch(frontend, /...\|hotkey/i)` | 禁止 `hotkey` 作为任意标识符出现在前端 |

结论：现有测试基线不保护重构，而是**否决重构**。它必须在 P0 实现合入前被替换，否则 CI 结果无法用于判断修复是否正确。

---

## 2. 接口与状态契约

以下为建议契约。签名为提案，名称可议；**语义与可测试性要求不可议**。

### 2.1 建议的纯函数、所在层级与导出方式

| 建议名称 | 层级 | 导出方式 | 职责 |
|---|---|---|---|
| `normalize_workspace_path(real_path: &str, platform: Platform) -> String` | Rust，`src-tauri/src/workspace.rs`（新模块） | `#[doc(hidden)] pub` | **真正的纯函数层**：对已解析的 real path 做形态归一 |
| `canonicalize_workspace(input: &str, platform: Platform, probe: &dyn PathProbe) -> Result<ResolvedWorkspace, WorkspaceError>` | 同上 | `#[doc(hidden)] pub` | 唯一的外部入口：经 `PathProbe` 取得 real path，再调用纯函数层 |
| `workspace_display(id: &WorkspaceId) -> String` | 同上 | `#[doc(hidden)] pub` | 面向用户展示的形式（去 `\\?\`），**不得**用于任何比较或 key |
| `permission_profile(mode: PermissionMode) -> PermissionProfile` | Rust，现有 `lib.rs` 或新 `permission.rs` | `#[doc(hidden)] pub`，`const` 数据表优先 | 权限模式 → 后端参数 |
| `runtime_state_transition(current: RuntimeState, event: RuntimeEvent) -> RuntimeState` | Rust，`src-tauri/src/runtime_state.rs`（新模块） | `#[doc(hidden)] pub` | 纯状态迁移函数，不含 IO |

约束：

- `normalize_workspace_path`、`permission_profile`、`runtime_state_transition` **必须不含 IO、不读环境变量、不读 `cfg!(windows)`**。
- `canonicalize_workspace` 是唯一允许触达文件系统的路径函数，且只能通过注入的 `PathProbe`。
  > **修订（同步点 0.5）**：本文档初版把 8.3 短名展开、磁盘真实大小写、`NotFound` 判定都放进一个 `(input, platform)` 纯函数，这在逻辑上不可能成立——这三件事都需要 IO。已改为上表的两层结构。
- 由于分工 (b)，Node 测试无法直接调用 Rust，且 integration test 无法访问 `pub(crate)`。因此被 `src-tauri/tests/` 调用的契约类型与纯函数以 **`#[doc(hidden)] pub`** 暴露，生产模块内不内嵌由本侧编写的测试。Node 测试只覆盖 §2.7 中可跨进程观测的部分。

### 2.2 输入、输出、错误语义与显式 platform 参数

```rust
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Platform { Windows, Unix }

/// 规范化后的工作区标识。内部字符串是唯一比较基准。
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct WorkspaceId(String);

#[derive(Debug, PartialEq, Eq)]
pub enum WorkspaceError {
    Empty,
    NotFound,        // 路径不存在
    NotADirectory,   // 存在但不是目录
    Unreadable,      // 存在但无法打开/解析
}
```

- `platform` **必须是显式参数**，不得在函数内读 `cfg!(windows)` 或 `std::env::consts::OS`。调用方在边界处决定一次。
- 文件系统访问必须通过注入的探测接口，使纯逻辑可在任一平台测试：

```rust
pub trait PathProbe {
    fn is_dir(&self, path: &str) -> bool;
    /// 返回操作系统最终路径（Windows 上即 \\?\ 形式）
    fn real_path(&self, path: &str) -> Result<String, WorkspaceError>;
}
```

- 错误语义：**必须返回上表中的结构化枚举，不得返回 OS 错误字符串**。实测本机 `os error 2` 的消息文本是中文本地化的（`系统找不到指定的文件。`），因此任何对 OS 错误文本的断言都会随机器语言变化而失败。面向用户的中文文案在 UI 层由枚举映射产生。
- `Err` 时**不得**回退到任何默认目录。当前 `default_workspace` 的多级回退是 P0-3 的成因之一。

### 2.3 Windows 路径形态的预期行为

`platform = Windows` 时，`canonicalize_workspace` 的**输出必须是不带 `\\?\` 前缀的规范形式**，而非 `canonicalize` 的原始返回值。理由：`\\?\` 形式会泄漏到 Codex 协议载荷、被 Codex 持久化、并显示给用户；同时它是 P0-1 表示分裂的载体。

| 输入形态 | 预期输出 | 说明 |
|---|---|---|
| `C:\Users\DELL` | `C:\Users\DELL` | 基准形式 |
| `c:\Users\DELL` | `C:\Users\DELL` | 盘符统一大写 |
| `C:\Users\DELL\` | `C:\Users\DELL` | 剥离尾分隔符 |
| `C:/Users/DELL` | `C:\Users\DELL` | 统一为反斜杠 |
| `C:\Users\DELL\.` / `...\Documents\..` | `C:\Users\DELL` | 归一点段 |
| `\\?\C:\Users\DELL` | `C:\Users\DELL` | **剥离 `\\?\` 前缀** |
| `C:\PROGRA~1` | `C:\Program Files` | 8.3 短名展开为长名（`canonicalize` 已实现，需在契约中固化为预期而非偶然） |
| `\\localhost\C$\Users` | `\\localhost\C$\Users` | UNC 保留双反斜杠前导；`\\?\UNC\` 前缀须转回 `\\` |
| `C:\` | `C:\` | **驱动器根是唯一保留尾分隔符的形态**，须显式测试 |
| 混合大小写目录名 | 保留磁盘上的真实大小写 | 仅盘符强制大写；其余大小写由 `real_path` 决定，不得自行 `to_lowercase` |
| 不存在的路径 | `Err(NotFound)` | 不得回退 |

`platform = Unix` 时不得进行盘符或反斜杠处理；`\` 是合法文件名字符。

### 2.4 幂等性与等价性用例

必须作为 Rust 单测固化：

- **幂等**：对上表每个输入 `x`，`f(f(x)) == f(x)`。
- **等价类**：以下输入必须产出**完全相同**的 `WorkspaceId`：
  `C:\Users\DELL`、`c:\Users\DELL`、`C:\Users\DELL\`、`C:/Users/DELL`、`C:\Users\DELL\.`、`C:\Users\DELL\Documents\..`、`\\?\C:\Users\DELL`、`C:\USERS\DELL`（若磁盘真实大小写为 `Users`）。
- **反等价**：`C:\Users\DELL` 与 `C:\Users\DELL2`、`D:\Users\DELL` 必须不等。
- **展示不参与比较**：`workspace_display(f(x))` 的结果**不得**被任何等价性测试用作 key。

### 2.5 thread / session key 的唯一计算入口

契约：

1. 后端存在唯一函数 `workspace_thread_key(id: &WorkspaceId) -> String`，是**所有** thread 持久化 key 的唯一来源。
2. **前端不得再自行拼接 thread key。** 当前 `` `${THREAD_KEY_PREFIX}${workspace}` `` 出现在多处（`savedThreadId` 及若干 `localStorage.setItem`），必须全部改为使用后端返回的 key。
3. `default_workspace` 与 `validate_workspace` **必须返回同一结构**，至少包含：

```ts
type WorkspaceInfo = {
  id: string;        // 规范化标识，唯一比较与 key 基准
  display: string;   // 面向用户展示
  threadKey: string; // 由后端计算
};
```

4. `start_jarvis` 返回的 `SessionInfo.cwd` **必须是 `WorkspaceId`，不得是原始入参**。这是子缺陷 (c)。
5. 前端 `workspaceChanged` 必须以 `id` 比较，不得以 `display` 比较。
6. 升级路径：现有用户的 `localStorage` 中可能已存在 `jarvis.threadId:\\?\C:\...` 与 `jarvis.threadId:C:\...` 两个 key。**必须给出一次性迁移**，把旧 key 归并到新 key，否则修复本身会再孤立一次已有 thread。迁移策略请在同步点 0.5 说明。
7. `thread/resume` 失败**不得静默回退**到 `thread/start`。必须区分"线程不存在"（可新建，须告知用户）与"其他错误"（须报错并保留原 thread id）。

### 2.6 权限模式映射契约

以数据表形式固化，逐模式断言：

| mode | approval_policy | sandbox | 默认工作区约束 | UI 要求 |
|---|---|---|---|---|
| `safe` | `on-request` | `workspace-write` | 无额外约束 | 应为**新安装的默认值** |
| `auto` | `never` | `workspace-write` | **工作区为用户主目录或其直接父级时必须拒绝进入该模式**，或强制降级为 `safe` 并说明 | 移除 `推荐` 标记；文案须显示实际工作区绝对路径 |
| `full` | `never` | `danger-full-access` | 需显式二次确认，不得由 `localStorage` 静默恢复 | 保留 `danger` 样式 |

附加契约：

- 前端默认权限模式改为 `safe`。当前 `storedPermissionMode()` 的 `?: "auto"` 是 P0-3 的第二成因。
- `default_workspace` **不得**返回 `%USERPROFILE%`。建议返回 `%USERPROFILE%\Jarvis`（不存在则创建，创建失败则返回 `Err` 并要求用户选择），具体取值请在 0.5 确认。
- 权限文案不得使用"当前目录"这类相对表述，必须内联实际路径。
- 映射必须是纯数据，使"给定 mode 断言三元组"成为一行测试。

### 2.7 可注入进程接口与运行时状态观察接口

**状态机**（`runtime_state_transition` 的定义域）：

```rust
pub enum RuntimeState {
    Absent,      // 从未启动
    Starting,    // 已 spawn，initialize 未完成
    Ready,       // initialize + thread 就绪
    Degraded,    // 子进程存活但握手/线程失败
    Dead,        // 子进程已退出，尚未清理
    Restarting,  // 退避等待中
    Failed,      // 超过重启上限，终态，需用户干预
}

pub enum RuntimeEvent {
    SpawnOk, SpawnErr,
    InitializeOk, InitializeErr,
    ThreadReady,
    StdoutEof,                  // 必须触发 Dead
    ChildExited { code: Option<i32> },
    RestartScheduled, RestartExhausted,
    ShutdownRequested,
}
```

必须满足的恢复契约（自动化测试的断言目标）：

1. `StdoutEof` 或 `ChildExited` **必须**使状态离开 `Ready`。当前实现在此处无任何动作，这是 P0-2 的核心。
2. 进入 `Dead` 时，`pending` 表中所有 oneshot **必须立即以错误 resolve**，不得等待 90 秒超时。错误须可区分于真实超时。
3. 进入 `Dead` 时 `AppState.runtime` 必须被清空，使 `direct_voice_status` 报告 `codexConnected: false`。
4. `Failed` 是终态：不得继续自动重启，必须要求用户干预。
5. 重启退避与上限须为常量并可在测试中覆盖；`Restarting` 期间的新请求必须立即失败或排队，二者择一并写明。

**可注入进程接口**（使上述可在无真实 codex.exe 的情况下测试）：

> **修订（同步点 0.5）**：本文档初版给出的是同步阻塞签名，并让 `wait()` 持有 child 锁——那会让主动 shutdown 被监视任务阻塞。已改为下面与 Tokio 相容的形状：stdio 与进程控制分离，控制面只暴露非阻塞的 `try_wait` 与 `start_kill`。

```rust
pub struct ProcessSpec { /* binary, args, env, creation flags */ }

pub trait ProcessSpawner: Send + Sync {
    fn spawn(&self, spec: ProcessSpec) -> Result<SpawnedCodexProcess, String>;
}

pub struct SpawnedCodexProcess {
    pub stdin:   Box<dyn AsyncWrite + Send + Unpin>,
    pub stdout:  Box<dyn AsyncRead  + Send + Unpin>,
    pub stderr:  Box<dyn AsyncRead  + Send + Unpin>,
    pub control: Box<dyn ProcessControl>,
}

pub trait ProcessControl: Send + Sync {
    fn pid(&self) -> Option<u32>;
    /// 非阻塞。不得持有会阻塞 shutdown 的锁。
    fn try_wait(&self) -> Result<Option<i32>, String>;
    /// 只发送终止信号，不等待回收。
    fn start_kill(&self) -> Result<(), String>;
}
```

`CodexRuntime` 必须持有 `Arc<dyn ProcessSpawner>` 而非直接调用 `Command::new`。fake spawner 用内存流即可模拟"spawn 后立即 EOF""写入成功但进程已死""指定退出码"等场景。

**进程树回收**：M-2 的通过标准（无孤儿子进程）无法仅靠观测达成，因此 Windows Job Object 作为 P0-2 的清理机制纳入本阶段，范围限定为 Jarvis 自己创建的 app-server 进程树，不做按镜像名清理。

**状态观察接口**（前端与测试共用，不得只打印到 stderr）：

- 新增 Tauri 命令 `runtime_state() -> RuntimeStateInfo`，至少含 `state`、`restartAttempts`、`lastExitCode`、`lastError`。
- 每次状态迁移发出 Tauri 事件 `jarvis-runtime-state`，载荷同上。
- 结构化日志：每次迁移一行 JSON，字段 `event`、`from`、`to`、`pid`、`exitCode`、`attempt`。**字段名请在 0.5 确认后固定**，Node 侧实机验收脚本将按字段名解析。
- `direct_voice_status.codexConnected` 必须由 `RuntimeState` 派生，不得由 `AppState.runtime.is_some()` 派生。

**唤醒 sidecar JSONL 协议**（Node 侧可直接测，无需 Rust 接缝）：

`JarvisWakeListener.exe --event-file <path>` 以 UTF-8 无 BOM 追加写入，每行一个 JSON 对象，必含 `type`：

| `type` | 附加字段 | 语义 |
|---|---|---|
| `authorization` | `status`: `authorized` \| `denied` | 麦克风授权结果 |
| `ready` | `culture`（可选） | 识别器就绪 |
| `wake` | `phrase` | 命中唤醒词 |
| `error` | `message` | 不可恢复错误 |

现有 Rust 侧消费逻辑对未知 `type` 静默忽略、对非法 JSON 行静默跳过 —— 这两条行为请在 0.5 确认是保留还是改为记录后忽略。`--test-wake` 会依次发出 `authorization` / `ready` / `wake`，Node 测试可直接以此断言协议，前提是 `npm run wake:build` 已产出该 exe。

---

## 3. 仍需 Windows 11 实机验收的清单

以下项无法用上述接口自动化，须由实现侧在实机执行并附观测证据。

| 编号 | 验收项 | 观测方式 | 通过标准 |
|---|---|---|---|
| M-1 | Codex app-server 是否接受规范化后的 `cwd`，以及是否接受 `\\?\` 形式 | 分别以两种形式启动 thread，抓 `codex rpc` 日志 | 规范形式成功；若 `\\?\` 形式也成功，仍应改为规范形式，理由记录在案 |
| M-2 | Job Object / 进程树回收 | 结束 Jarvis 后用 `Get-Process`、进程树快照核对 | 无 `codex.exe`、`JarvisWakeListener.exe` 残留；无孤儿子进程 |
| M-3 | 子进程被外部强杀后的恢复 | 任务管理器结束 `codex.exe`，观察 `jarvis-runtime-state` 事件与 UI | 状态在数秒内离开 `Ready`；在途请求立即失败而非等 90 秒；UI 显示断开 |
| M-4 | 重启上限与终态 | 反复强杀直到超过上限 | 进入 `Failed` 并停止重启，UI 提示需用户干预 |
| M-5 | WebView2 安装模式 | 检查当前 `downloadBootstrapper` 配置在离线机器上的行为 | 明确记录离线安装是否可行，决定是否改为 fixed-version |
| M-6 | 沙箱边界实际生效性 | 在 `auto` 模式下尝试写工作区外文件 | 被阻止且有可见提示 |
| M-7 | 8.3 短名与 UNC 工作区端到端 | 以 `C:\PROGRA~1` 形式和 UNC 路径各建一次会话 | thread key 与规范形式一致，不产生第二个 thread |
| M-8 | 首次安装权限默认值 | 清空 `localStorage` 后全新启动 | 权限为 `safe`；工作区非 `%USERPROFILE%`；无"推荐"标记指向 `auto` |
| M-9 | 唤醒助手在中文语言包缺失时的降级 | 卸载/禁用中文语音包后启动 | 发出 `error` JSONL 且 UI 显示可读原因 |

---

## 4. 同步点 0.5 决议（已关闭）

八项全部裁定，均已并入上文。此处只记录结论与差异。

| # | 决议 |
|---|---|
| 1 | `WorkspaceId` **剥离** `\\?\`；`\\?\UNC\server\share` → `\\server\share`。id／thread key／Codex `cwd`／界面展示统一用普通绝对路径。extended path 仅可存于 `ResolvedWorkspace.native_path`，且不得参与比较、持久化 key 或协议载荷。 |
| 2 | 默认工作区 `%USERPROFILE%\Jarvis`，不存在则由后端创建；同名非目录／创建失败／无法规范化则返回结构化错误并要求用户选择。`JARVIS_WORKSPACE` 仍优先但须过同一入口。**删除 `current_dir()` 静默回退。** |
| 3 | 前端默认权限改 `safe`；移除 `auto` 的"推荐"标记；相对文案改为显示实际绝对工作区。 |
| 4 | 组合策略：显式选 `auto` 且工作区为主目录或其祖先 → **拒绝保存**并说明；启动时发现旧配置为该组合 → **降级 `safe`**、写回存储、显示一次安全迁移提示。不允许静默以 `auto` 继续。`full` 需独立二次确认且不跨重启恢复。 |
| 5 | 日志与事件契约固定，见 §4.1。 |
| 6 | localStorage 迁移策略固定，见 §4.2。**绝不删除旧 key。** |
| 7 | 未知 wake `type` 与非法 JSON 均"记录后忽略"，不终止 supervisor、不改状态；事件名 `wake.protocol.unknown_type` / `wake.protocol.invalid_json`；**不写入原始整行**，避免记录用户话语。 |
| 8 | 接受 `PathProbe`；`CodexProcess` 同步签名被否，改用 §2.7 的 Tokio 相容形状。路径层改为两层（§2.1／§2.2）。契约符号以 `#[doc(hidden)] pub` 暴露。 |

### 4.1 日志与事件契约（已固定）

日志文件：Tauri `app_log_dir()` 下的 `jarvis-runtime.jsonl`。状态迁移事件名 `jarvis.runtime.state_transition`。每行字段固定为：

`schemaVersion`(=1)、`timestampMs`(UTC ms)、`event`、`runtimeId`、`from`、`to`、`trigger`、`pid`、`exitCode`、`signal`、`restartAttempt`、`errorCode`、`errorMessage`

不适用字段**保留并写 `null`**。**不记录工作区路径、命令参数或用户内容。**

Tauri 事件名 `jarvis-runtime-state`，前端载荷固定为：`runtimeId`、`state`、`restartAttempts`、`lastExitCode`、`lastErrorCode`、`lastError`。

### 4.2 localStorage 迁移策略（已固定）

原则：**先备份、再选择当前活动 key、绝不删除旧 key。**

1. 后端 `WorkspaceInfo` 增加 `legacyThreadKeys`。
2. 前端先读迁移前的 `jarvis.workspace`，收集规范 key、普通路径旧 key、`\\?\` 旧 key 对应的全部非空 thread id。
3. 写入备份 `jarvis.threadMigrationBackup.v1:<workspaceId>`。
4. 选值优先级：与迁移前 `jarvis.workspace` 精确对应者 → 规范 key → 唯一剩余候选。
5. 选中值写入新的规范 `threadKey`。
6. 若多个 key 指向**不同** thread id：保留全部备份与旧 key，显示一次冲突提示。**不假装多个 Codex thread 可以自动合并。**
7. 成功后再写 workspace 级迁移标记。
8. 不删除或覆盖唯一可恢复副本。

### 4.3 P0-2 恢复策略（已固定）

- 意外 EOF／退出：在途请求立即以 `runtime_exited` 失败。
- 迁移链 `Ready → Dead → Restarting → Starting`。
- 连续自动重启上限 3 次，退避 1s／2s／4s。
- 连续稳定 `Ready` 60 秒后清零重启计数。
- `Restarting` 期间新请求立即以 `runtime_restarting` 失败，**不排队**。
- 超限进入 `Failed`，停止自动重启。
- 用户再次点击文字执行、Voice 或明确重试 = 人工干预，可开启新一轮。
- 主动 shutdown 直达 `Absent`，必须用 runtime generation／cancellation 阻止旧监视任务触发重启。
- stdout EOF 与 child exit 对同一 runtime **只清理一次**。

### 4.4 已定级但不在本阶段的项

- `codex_executable_usable` 在探测阶段执行候选可执行文件：定为 **P2 安全加固**，不纳入三个 P0。理由：PATH 本身即当前产品选择 Codex 可执行文件的信任边界，未形成提权；但依次执行多个失败候选确实扩大探测面。后续单独决定是否只信任显式路径、环境变量与受控安装位置。
- WebView2 现状已静态确认为 `downloadBootstrapper`（Evergreen 在线引导），非 fixed-version。离线干净安装的实际表现留 M-5。

---

## 5. 本次核验中发现、报告未记录的问题

- **`codex_executable_usable` 在候选路径探测阶段执行候选可执行文件**（`--version`）。`PATH` 上任何名为 `codex.exe` 的文件会在无用户确认的情况下被运行。→ **已于 0.5 定级为 P2 安全加固**，见 §4.4，不纳入三个 P0。
- `default_workspace` 在所有 home 变量缺失时回退 `current_dir()`（§1.3 附带）。→ **已纳入决议 2，删除该回退。**
- `tests/wav.test.mjs` 文件名与内容无关。→ **已于阶段 1 删除，见 §6。**
- 仓库根存在两个被 `.gitignore` 忽略的 `.codex-publish-work-*` 目录副本，属发布流程残留。**仍未处理，无人认领。**

---

## 6. 阶段 1 交付：测试基线替换

### 6.1 新增与删除

| 文件 | 类型 | 当前状态 |
|---|---|---|
| `tests/fixtures/workspace-path-vectors.json` | 语言中立测试向量 | 数据；Windows 映射为本机实测结果 |
| `tests/wake-protocol.test.mjs` | Node 行为测试，8 项 | **通过**（执行真实 `JarvisWakeListener.exe`） |
| `tests/packaging.test.mjs` | Node 配置一致性测试，7 项 | **通过** |
| `tests/contract/workspace_path.rs` | Rust 契约测试，10 项（P0-1） | 暂存，未进 cargo 编译范围 |
| `tests/contract/permission_profile.rs` | Rust 契约测试，11 项（P0-3） | 暂存，未进 cargo 编译范围 |
| `tests/contract/runtime_state.rs` | Rust 契约测试，24 项（P0-2） | 暂存，未进 cargo 编译范围 |
| `tests/contract/README.md` | 激活说明 | — |

已删除：`tests/wav.test.mjs`（15 项源码正则断言）。
`package.json` 的 `test` 脚本由单文件改为 `node --test "tests/**/*.test.mjs"`。

**实测**：上述改动后 `npm run check` 退出码 0（`wake:build` → 15 项 Node 测试 → `web:build` → `cargo fmt --check` → `cargo clippy --all-targets -D warnings` 全绿）。

### 6.2 为什么 Rust 契约测试不放 `src-tauri/tests/`

`npm run check` 含 `cargo clippy --all-targets`，而 `--all-targets` 会编译 `src-tauri/tests/`。在契约符号落地前把文件放进去，会让**整个构建**失败而非仅测试失败，连带 fmt 与 clippy 的结果一并不可用。已实测确认：

```
error[E0433]: cannot find `Platform` in `jarvis_codex_lib`
error: could not compile `jarvis-codex` (test "...") due to 2 previous errors
```

### 6.3 门禁切换顺序

1. **（已完成）** 删除源码正则基线，新 Node 测试进门禁。此后三个 P0 的实现不再被测试否决。
2. 实现侧每落地一组契约符号，就在**同一个提交**里 `git mv tests/contract/<file>.rs src-tauri/tests/`。**逐个搬**——三组分属三个 P0，提前搬入会阻塞其余两个。
3. 三个文件全部搬完后，再把 `cargo test --manifest-path src-tauri/Cargo.toml` 加入 `npm run check`。在那之前不加：此刻 `cargo test` 没有任何测试可跑，加进去只会制造"绿色即已验证"的假象。

### 6.4 被删除的 15 项断言的覆盖归属

逐条交代，不做静默丢弃。

| 原测试关切 | 现在的覆盖 |
|---|---|
| workspace 持久化与 thread 续接 | **更强**：`tests/contract/workspace_path.rs`，真实等价类与幂等性，而非 grep 函数名 |
| 权限模式映射 | **更强**：`tests/contract/permission_profile.rs`，逐模式三元组＋危险工作区拒绝／降级 |
| Windows 唤醒监听器与 NSIS 打包 | **更强**：`tests/packaging.test.mjs` ＋ `tests/wake-protocol.test.mjs`，解析真实配置、执行真实二进制 |
| release 为 GUI 子系统 | 保留于 `tests/packaging.test.mjs`，并在注释中说明它为何仍是源码级断言 |
| Windows 关闭只杀自有子进程 | **故意删除**：与决议 8 的 Job Object 工作直接冲突。真实关切转为实机项 M-2。 |
| Voice 走 app-server V3 WebRTC、STOP 抑制 tail handoff | **暂无覆盖**。需要 `ProcessSpawner` fake 才能断言发给 Codex 的 `initialize`／`thread/start`／`thread/realtime/start` 载荷。列为阶段 2。 |
| Windows 发现／选择 `codex.exe` | **暂无覆盖**。与 §4.4 的 P2 安全项是同一处代码，建议一并处理。 |
| 唤醒词打开同一 Voice 路径、文字注入会话、新开线程、语音风格、有界重连、单实例、macOS 激活窗口 | **暂无覆盖**：均为 `src/main.ts` 的前端行为。 |

### 6.5 必须明说的覆盖缺口

**前端 `src/main.ts`（1153 行）现在的自动化覆盖为零。**

此前也并非真有覆盖——旧断言只 grep 源码文本，任何逻辑破坏都能通过，而无害的改名会失败。所以这不是覆盖回退，而是把虚假覆盖换成了诚实的空缺。但空缺是真实的：`devDependencies` 中没有任何测试运行器或 DOM 环境（仅 `vite`、`typescript`、`@tauri-apps/cli`）。

引入前端测试环境属阶段 2 提案，不在本阶段范围。在此之前，前端相关验收只能依赖 §3 的实机清单，尤其 M-8。

### 6.6 契约测试与实现的对齐风险

这些 Rust 测试是照契约写的，**尚未对任何实现编译过**。首次 `git mv` 时大概率出现签名细节不符（参数顺序、`&dyn` vs 泛型、`Debug`／`PartialEq` derive 缺失等）。这属预期，不是实现错误。

处理约定：若差异纯属形式，实现侧直接改测试的 `use` 与调用形式并在提交信息说明；若差异触及**语义**（等价类、错误变体、状态迁移、退避数值、拒绝码字符串），不要改测试，回到同步点讨论。
