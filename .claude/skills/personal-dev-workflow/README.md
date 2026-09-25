# Personal Dev Workflow v1.0.0

A structural rework of v0.5.3: the goal is not more rules, but restoring the Skill as an **on-demand workflow capability**, with runtime control, state, and platform adaptation split into layers.

## What this version fixes

1. **Autonomy is no longer on by default**: `standard` stops after a card; only explicit `bounded` auto-continues.
2. **Skill / Harness layering**: the generic Skill no longer claims it can do a host hard gate; enforcement surfaces like DSH live in adapters.
3. **Machine state split out of Markdown**: `.agent-state/run-state.json` is the source of truth; `RUN_STATE.md` is only a rendered view.
4. **Worker semantics fixed**: `workers.active` is a gauge (start/stop); `workersSpawned` is a counter — no more "historical total posing as concurrency".
5. **Verification chosen by task type**: docs, backend, frontend, infra, and security tasks each use their most relevant evidence.
6. **Memory de-duplication**: AGENTS / ADR-docs / Task Card / machine state / changelog each have their own job; small cards are no longer forced to write multiple prose files.
7. **Model decoupling**: the core only defines capability profiles for planner / executor / evaluator; specific model names go into optional presets.
8. **Behavioral evals**: new trigger / workflow / autonomy / recovery cases, so we stop verifying only format and start verifying behavior.

## Layout

```text
personal-dev-workflow/
├── SKILL.md
├── references/
├── assets/
├── scripts/
└── evals/
```

Follows the common Agent Skills structure: `SKILL.md` is the entry point, `references/` load on demand, `scripts/` hold deterministic actions, `assets/` hold templates.

## Quick verification

```bash
python scripts/validate-skill.py .
node scripts/runstate.test.js
```

> `validate-skill.py` only checks structure, frontmatter, and local references — it does not prove the workflow semantics are correct. Behavioral correctness must be judged from `evals/` and real project replays.

## Installation approach

Keep a **single discoverable Skill**. Do not install both a Chinese and an English Skill with the same responsibility, or the routing stage will see two highly overlapping descriptions.

## Migrating from v0.5.3

See `references/migration-v0.5.3.md`.
