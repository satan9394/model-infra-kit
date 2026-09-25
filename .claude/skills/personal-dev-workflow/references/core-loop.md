# Core Development Loop

## 0. Confirm the mode

Decide `quick / standard / bounded / audit` first. Without explicit authorization, do not assume `bounded`.

## 1. Converge scope

Answer four questions first:

- What result is to be delivered?
- What is explicitly NOT to be done?
- Which constraints must not be broken?
- What evidence proves completion?

Only write `assets/spec.md` when the requirement spans multiple behaviors, crosses modules, or holds important unknowns. For an unfamiliar codebase, do focused exploration first: entry points, call chains, tests, interfaces, config; stop once you have enough evidence — do not endlessly "look a bit more".

## 2. Create the card

A task card is an **execution contract**, not a project-management ritual. Create one only if any of these holds:

- it can be independently accepted;
- it needs to continue across sessions;
- it will be handed to another Worker;
- on failure it needs its own rollback / blocking.

A card must contain: Mission, goal, Not Doing / constraints, acceptance criteria, blast radius, expected evidence.

## 3. Execute

Single agent by default. Dispatch a Worker only if at least one condition holds:

- the subtask is independent and won't touch the same core files at the same time;
- parallelism is needed to cut wall-clock time;
- an independent evaluator / security review is needed;
- the main agent's context would balloon significantly from that subtask.

Do not split out Workers just to "look like a multi-agent system".

Issues found during execution:

- blocks the current card / Mission: mark `blocker`, handle within scope;
- does not block: write to the Deferred Backlog; do not grow the Mission on the sly.

## 4. Verify

Verification must come from reproducible evidence, not the executor's self-assessment.

- Small change: the executor may self-test first;
- Medium-high risk / cross-module: prefer an independent evaluator;
- Subjective quality: use an explicit rubric;
- Executable software: prefer tests / build / runtime evidence.

Pick an evidence profile per `verification.md`.

If a critical gate still fails after one repair: `BLOCKED`, stop mechanically retrying.

## 5. Record & hand off

Save only the state the next round genuinely needs:

- Task Card: task semantics and acceptance;
- Git diff / commit: code facts;
- `.agent-state/run-state.json`: bounded run state;
- ADR / docs: long-term design decisions;
- AGENTS.md: cross-task stable rules / real lessons;
- CHANGELOG: user-visible delivered changes.

Do not copy the same fact into three or four files. See `memory-policy.md`.

## 6. Stop or continue

- `quick`: finish, show evidence, end.
- `standard`: end when the current card is done / blocked; suggest the next card but do not auto-start it.
- `bounded`: when `gate` passes, the Mission is unfinished, and no escalation condition holds, auto-continue to the next card; on Run exhaustion, checkpoint + `new-run`; on Mission exhaustion, stop and hand to the human.
- `audit`: report findings and end; never jump automatically from Finding to Code.
