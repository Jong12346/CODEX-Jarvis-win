# Rust 契约测试暂存区

这些 `.rs` 文件是 P0-1 / P0-2 / P0-3 的**可执行规格**。它们现在**故意不在 cargo 的编译范围内**。

## 为什么不直接放 `src-tauri/tests/`

`npm run check` 包含 `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets`。
`--all-targets` 会编译 `src-tauri/tests/`。在契约符号落地之前，把这些文件放进去会立刻让 `npm run check` 失败——不是"测试红"，而是**整个构建红**，clippy 和 fmt 的结果一并不可用。

已实测确认（2026-08-04，`43b1121`）：

```
$ cargo check --manifest-path src-tauri/Cargo.toml --all-targets
error[E0433]: cannot find `Platform` in `jarvis_codex_lib`
error[E0425]: cannot find function `normalize_workspace_path` in crate `jarvis_codex_lib`
error: could not compile `jarvis-codex` (test "zz_tmp_clippy_probe") due to 2 previous errors
```

## 激活步骤（由实现侧在落地符号的同一个提交里执行）

每个文件顶部注明了它依赖哪些符号。当某个文件依赖的符号全部就位后：

```sh
mkdir -p src-tauri/tests
git mv tests/contract/<file>.rs src-tauri/tests/<file>.rs
cargo test --manifest-path src-tauri/Cargo.toml
```

**逐个文件搬运，不要一次全搬。** 三组测试依赖的符号分属三个 P0，任一组提前搬入都会阻塞另外两个的开发。

搬完最后一个文件后，再把 `cargo test` 加入 `npm run check`（见 `docs/WINDOWS_P0_CONTRACT.md` §6 的门禁切换顺序）。在那之前 `cargo test` 不进门禁，因为它此刻没有任何测试可跑。

## 可见性前提

这些是 integration test，只能访问 `pub` 项。按同步点 0.5 的决定，被它们调用的契约类型与纯函数以 `#[doc(hidden)] pub` 暴露。若实现侧改用其他暴露方式（例如单独的 `contract` 模块），请同步修改这些文件顶部的 `use` 语句并在提交信息中说明。

## 这些测试不覆盖什么

- 真实文件系统行为：全部走注入的 `PathProbe`，向量来自 `tests/fixtures/workspace-path-vectors.json`（其中的 Windows 映射是本机实测结果，非假设）。
- 真实进程行为：全部走注入的 `ProcessSpawner`。真实 `codex.exe` 的生死、Job Object 进程树回收属实机项，见 `docs/WINDOWS_P0_CONTRACT.md` §3 的 M-2 / M-3 / M-4。
- UI 联动：`auto` 模式的拒绝提示、安全降级提示属实机项 M-8。
