# Changelog

## 1.0.0 — 2026-09-24

- Split the default workflow into four modes: `quick / standard / bounded / audit`.
- `bounded` is now explicit opt-in; no auto commit or auto next-card by default.
- The root `SKILL.md` is trimmed to routing and the core contract; details moved down into references.
- New JSON state controller with atomic writes; `RUN_STATE.md` is now a derived view.
- Workers split into an `active` gauge and a `workersSpawned` counter.
- New task-typed verification evidence.
- New memory taxonomy to cut duplicate logging and context bloat.
- New DSH / Codex / Claude Code adapter docs.
- New behavioral eval cases and a local validation script.
