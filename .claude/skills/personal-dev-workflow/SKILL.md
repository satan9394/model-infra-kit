---
name: personal-dev-workflow
description: A disciplined personal software-development workflow for multi-step project work that benefits from task cards, explicit scope, verification, resumable state, or bounded autonomous continuation. Use for substantial feature work, refactors, bug-fix sequences, project planning-to-execution, and long-running development. Do not use for simple code questions, one-line edits, pure explanation, or read-only inspection unless audit mode is explicitly requested.
license: MIT
compatibility: Portable Agent Skills format. Core workflow is tool-agnostic. Optional bounded-state controller requires Node.js 18+. Host-level hard enforcement is adapter-specific and is not provided by the generic skill itself.
metadata:
  version: "1.0.0"
  language: "en"
  architecture: "progressive-disclosure"
---

# Personal Dev Workflow

Turn complex development work into a **verifiable, resumable, stoppable** execution loop. By default it does not run indefinitely, and it does not treat the Skill as a Harness.

## When to enable

- Multi-step features, refactors, bug-fix sequences, cross-file implementation, long-lived projects.
- When you need task cards, independent verification, cross-session recovery, or bounded autonomy.
- When the user explicitly says "start work / break down cards / build by task card / budget on / push autonomously".

Do NOT load for: simple Q&A, one-line/single-file tweaks, pure explanation, or throwaway scripts that need no state. Enter `audit` for read-only review only when the user asks.

## Choose a mode first

| Mode | Fits | Default behavior |
|---|---|---|
| `quick` | local, low-risk, small change | execute directly + minimal verification; no task system |
| `standard` | default multi-step development | one card, one closed loop; show evidence and STOP when done — no auto commit / next card |
| `bounded` | user explicitly authorizes continuous autonomy | continue within Mission and budget; requires the state controller |
| `audit` | read-only review / diagnosis | may read, search, test, lint, reproduce in sandbox; MUST NOT modify / commit / deploy |

**Entering `bounded` requires explicit opt-in.** "Using this Skill" does not mean "authorizing autonomous continuation". See `references/bounded-autonomy.md`.

## Core loop

1. **Converge scope**: confirm goal, Not Doing, risks, acceptance criteria; skip the SPEC for anything that fits in one sentence.
2. **Create a task card**: only for work that needs independent delivery. Template: `assets/task-card.md`.
3. **Execute**: prefer a single agent; dispatch Workers only for independent parallelism, cross-module work, or an independent perspective.
4. **Verify**: pick evidence by task type; do not mechanically demand all of tests/build/screenshots. See `references/verification.md`.
5. **Record / hand off**: record only facts that genuinely need to survive sessions; avoid logging the same fact into log + CHANGELOG + state file. See `references/memory-policy.md`.
6. **Stop or continue**: `quick/standard` stop and show evidence by default; `bounded` continues only within budget, Mission, and risk bounds.

Full execution detail: `references/core-loop.md`.

## Permission boundaries

- By default, never auto `commit / merge / push / deploy / publish / delete`.
- `bounded` may auto-`commit` only when project rules explicitly allow; `merge/push/deploy/publish/delete/credentials/funds` still need separate authorization.
- Audit is **no-modification**, not "cannot run any command". Safe tests, lint, builds, and read-only queries are allowed.
- Newly found issues go to the backlog by default; only a blocker that **blocks the current Mission** may enter the current WorkSet.

## State & recovery

`bounded` uses machine state `.agent-state/run-state.json`; the root `RUN_STATE.md` is only a script-generated human view, **not the machine source of truth**.

Common commands:

```bash
node scripts/runstate.js init <project-root>
node scripts/runstate.js check <project-root>
node scripts/runstate.js status <project-root> --json
node scripts/runstate.js gate <project-root>
node scripts/runstate.js advance <project-root> card
node scripts/runstate.js worker-start <project-root>
node scripts/runstate.js worker-stop <project-root>
node scripts/runstate.js new-run <project-root>
node scripts/runstate.js resume <project-root>
```

The script is a **state controller, not a host hard-enforcer**. For a true pre-execute hard gate on hosts like DSH, integrate per `references/adapter-dsh.md`.

## Read on demand

- Core loop: `references/core-loop.md`
- Verification evidence: `references/verification.md`
- Memory & file responsibilities: `references/memory-policy.md`
- Bounded autonomy / budget / recovery: `references/bounded-autonomy.md`
- State format: `references/state-schema.md`
- Model capability selection: `references/model-profiles.md`
- DSH: `references/adapter-dsh.md`; Codex: `references/adapter-codex.md`; Claude Code: `references/adapter-claude-code.md`
- Personal AGY → Codex example: `references/preset-agy-codex.md`

## Done criteria

Only claim "done" when the acceptance evidence holds. On failure, budget exhaustion, or a needed human decision, clearly output the current state, evidence, blocker, and next step; do not manufacture infinite loops with "keep optimizing".
