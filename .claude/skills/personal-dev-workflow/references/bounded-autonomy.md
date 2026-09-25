# Bounded Autonomy

## 1. Enabling conditions

Enter `bounded` only if any of the following holds:

- the user explicitly says "budget on / push autonomously / run continuously / no per-card confirmation";
- project rules explicitly declare this Mission uses `bounded`;
- the user explicitly provides the Mission, DoD, and the allowed side-effect scope.

Merely installing the Skill, having task cards, or having an AGENTS.md does **not** constitute authorization.

## 2. The Mission envelope

Every autonomous round must fix:

- Mission: a one-sentence goal;
- Definition of Done: objective gates;
- Out of scope: what is explicitly not done;
- WorkSet: the cards currently allowed to run under this Mission;
- Escalation: which conditions must go to the human.

The backlog is memory, not an execution queue.

## 3. Default budgets

Defaults are heuristic starting points, not engineering constants; adjust per Mission in the state JSON.

### Run budget

| Item | Default |
|---|---|---:|
| epochs | 2 |
| cards | 6 |
| repairs | 1 |
| workers spawned | 8 |
| active workers | 3 |
| research passes | 1 |
| workset size | 8 |
| max subagent depth | 1 |

### Mission budget

| Item | Default |
|---|---|---:|
| runs | 3 |
| total cards | 12 |
| total repairs | 3 |

The Run budget governs **context hygiene**; the Mission budget is the **overall fuse**. Do not conflate the two.

## 4. The state controller

Initialize only after opt-in:

```bash
node scripts/runstate.js init <project-root>
```

Then fill in `.agent-state/run-state.json`'s mission goal, DoD, outOfScope, workset, and run:

```bash
node scripts/runstate.js check <project-root>
node scripts/runstate.js gate <project-root>
```

### Counting rules

```bash
node scripts/runstate.js advance <root> epoch
node scripts/runstate.js advance <root> card
node scripts/runstate.js advance <root> repair
node scripts/runstate.js advance <root> research
```

`card` increments both Run and Mission card counts; `repair` increments both repair levels.

Budgets are **action-scoped**, not "any counter at its cap freezes the whole Run":

- `gate` decides whether the **next card** may start, so it mainly checks Run/Mission card counts;
- repairs at cap only reject new repairs; research at cap only rejects new research;
- worker-spawn at cap only rejects dispatching more Workers — the main agent can still finish current work;
- Mission `runs` at cap only means no more `new-run`; the current final Run may continue to its other budget bounds.

This avoids "research was used once, so the whole Run got wrongly locked".

### Workers are not a single number

Concurrency and cumulative count must be separate:

```bash
node scripts/runstate.js worker-start <root>
node scripts/runstate.js worker-stop <root>
```

- `workers.active`: how many Workers are currently running — a gauge, can go up and down;
- `run.workersSpawned.used`: how many Workers have been started this Run — a counter, only goes up.

This avoids "a finished Worker forever occupying a concurrency slot".

## 5. Run reset & Mission stop

Run budget exhausted but Mission still has budget:

1. update resumeFrom / blocked / workset;
2. `node scripts/runstate.js new-run <root>`;
3. a fresh context reads the state and continues.

Mission budget exhausted: stop and escalate to the human. Do not look for a side channel to continue.

## 6. Boundaries of automatic behavior

`bounded` may automatically: pick the next approved card, do low-risk local fixes, add tests, and commit when project rules allow.

It must still escalate on:

- product semantics / DoD changes;
- merge / push / deploy / publish / delete;
- credentials, funds, external communication;
- Mission blocked;
- Mission budget exhausted;
- needing to enlarge the Mission / WorkSet cap.

## 7. A note on enforcement

`runstate.js` can atomically reject **the out-of-bounds state changes it receives**, but it cannot force the Agent to call it. So it is a controller, not host enforcement.

A true hard gate needs the host to call the controller before tool dispatch, and to record "which projects are managed" in a host config/registry the Agent cannot easily bypass. For DSH, see `adapter-dsh.md`.
