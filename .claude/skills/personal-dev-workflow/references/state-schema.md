# State Model

Machine source of truth: `.agent-state/run-state.json`.

Core fields:

```json
{
  "schemaVersion": 1,
  "mode": "bounded",
  "mission": {
    "goal": "...",
    "definitionOfDone": ["..."],
    "outOfScope": [],
    "status": "active"
  },
  "workset": [],
  "blocked": [],
  "deferredBacklog": [],
  "budget": {
    "run": {
      "epoch": {"used": 0, "limit": 2},
      "cards": {"used": 0, "limit": 6},
      "repairs": {"used": 0, "limit": 1},
      "workersSpawned": {"used": 0, "limit": 8},
      "research": {"used": 0, "limit": 1}
    },
    "mission": {
      "runs": {"used": 1, "limit": 3},
      "cards": {"used": 0, "limit": 12},
      "repairs": {"used": 0, "limit": 3}
    },
    "worksetLimit": 8,
    "activeWorkerLimit": 3,
    "maxSubagentDepth": 1
  },
  "workers": {"active": 0},
  "lastVerifiedCommit": null,
  "resumeFrom": null
}
```

`RUN_STATE.md` is auto-rendered by the script for humans. Do not hand-edit the Markdown expecting the budget to change.

## Counter vs Gauge

- counter: cards, repairs, workersSpawned, research — only go up (Run-level reset on new-run).
- gauge: workers.active — +1 when a Worker starts, -1 when it ends.
- derived: workset size = `workset.length`; do not maintain a separate drift-prone "WorkSet size counter".

## Consistency

Every state write uses a temp file + rename, so an interrupted process cannot leave a half-written JSON. `check` rejects illegal types, over-limit values, negative active workers, and similar states.
