# Migrating from v0.5.3 to v1.0.0

## 1. No longer installing two discoverable bilingual Skills

Keep a single `personal-dev-workflow`. One canonical instruction language is enough; if you want docs in another language, put them in references — do not create a second same-responsibility `SKILL.md`.

## 2. RUN_STATE.md is no longer machine state

The old version counted by parsing Markdown. v1 changes this to:

```text
.agent-state/run-state.json   # machine source of truth
RUN_STATE.md                  # generated human view
```

For existing projects, first manually migrate the Mission, DoD, budget, and workset into the JSON, then run `check`.

## 3. Default autonomy behavior changed

The old "gates pass → auto-merge, commit, continue to next card" now belongs only to explicit `bounded`, and auto-commit additionally requires project-rule authorization.

`standard`: show evidence and stop after one card.

## 4. Worker counting fixed

The old `Worker count` carried both cumulative and concurrency semantics. v1 splits it:

- `workers.active`: current concurrency, can decrease;
- `workersSpawned`: cumulative this Run, only increases.

## 5. Recording policy changed

No longer forcing every card to write daily log + CHANGELOG + RUN_STATE + AGENTS all at once. Each goes to its own place per `memory-policy.md`.

## 6. DSH hard gate

The v1 core Skill does not ship an unverified DSH hook implementation. It keeps the controller contract; implement and test the host adapter on your target DSH version, rather than mislabeling "rules" as "hard enforcement".
