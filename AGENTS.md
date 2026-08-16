# Jarvis Codex Project Instructions

## Source of truth

- Treat the working tree and live Git state as authoritative.
- Read `docs/WINDOWS_OPTIMIZATION_PLAN.md` for the long-term Windows goal and implementation order.
- Read `docs/WINDOWS_STATUS.md` for the last recorded Windows baseline and manual verification limits.
- Use `docs/CURRENT_HANDOFF.md` only as a compact local checkpoint. If it conflicts with disk or Git, use disk and Git.
- Preserve all existing user changes. Do not discard, rewrite, or hide unrelated dirty-tree work.

## Command: 生成交接

When the user's entire request is `生成交接` after trimming whitespace:

1. Use the global `codex-model-handoff` Skill.
2. Treat the command as explicit authorization to update only `docs/CURRENT_HANDOFF.md`.
3. Collect repository state read-only and summarize paths and diff statistics; never embed a full diff.
4. Read this file, `docs/WINDOWS_OPTIMIZATION_PLAN.md`, `docs/WINDOWS_STATUS.md`, and the existing handoff if present.
5. Record only completed work supported by evidence, current dirty files, test evidence, limits, and one executable next step.
6. Scan the result for credentials before returning `交接已生成，可以切换模型。`

Do not run builds or tests, modify another project file, commit, push, switch branches, change CC Switch configuration, or access Codex/CC Switch task databases as part of this command.

## Command: 继续

When the user's entire request is `继续` after trimming whitespace:

1. Use the global `codex-model-handoff` Skill.
2. Read `docs/CURRENT_HANDOFF.md`, `docs/WINDOWS_OPTIMIZATION_PLAN.md`, and `docs/WINDOWS_STATUS.md`.
3. Collect the live branch, HEAD, short status, and staged/unstaged diff statistics.
4. Compare live state with the handoff. Report any concrete mismatch briefly and use live state to correct the working context.
5. If state is consistent, execute the single item under `下一步` directly. Do not repeat completed and verified work.
6. If the handoff is absent, reconstruct a degraded context from Git and the planning/status files, then continue with the earliest unfinished verifiable action.

This command authorizes normal, reversible project edits and proportionate verification required by that next step. It does not authorize commits, pushes, releases, destructive cleanup, credential access, CC Switch changes, or edits to Codex task storage.

## Safety and verification

- Never read or reproduce `.env`, tokens, cookies, API keys, login material, personal credentials, CC Switch authentication configuration, Codex SQLite files, rollout records, or old task databases.
- Do not claim a test passed unless its command and result are available as evidence. Keep historical baseline results distinct from results for the current dirty tree.
- Keep real-device checks such as microphone, wake phrase, Voice playback, Windows login startup, installer behavior, and code signing explicitly marked as manual until performed.
- Do not commit, push, merge, release, or switch branches unless the user explicitly requests it.
