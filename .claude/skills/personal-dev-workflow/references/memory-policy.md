# Memory & File Responsibilities

Goal: **store each fact in its single best place.** More files does not mean better memory.

| Information | Source of truth | When to write |
|---|---|---|
| Current task goal / acceptance | Task Card | when creating and accepting the card |
| Actual code changes | Git diff / commit | produced naturally; do not re-transcribe |
| bounded budget / resume point | `.agent-state/run-state.json` | on every state change |
| Long-term architecture decisions | ADR / docs | when a decision needs cross-task explanation |
| Stable project rules / real lessons | `AGENTS.md` | when a class of mistake is likely to recur |
| User-visible version changes | `CHANGELOG.md` | on a genuinely shippable / perceptible delivery |
| Throwaway process notes | optional daily log | only when the project truly needs an audit trail |

## AGENTS.md

Treat it as a "map / invariants", not a dev diary.

Only add what the Agent cannot reliably derive from the repo, e.g.:

- the project explicitly does not use a certain technology;
- interface / architecture boundaries that must be kept;
- mistakes that really happened, are prone to recur, and are costly.

Keep it short; "100 lines" is a reminder, not a hard standard.

## Behaviors no longer forced

- writing a daily log for every small card;
- writing a CHANGELOG entry for every internal refactor;
- recording task status four times over (Task Card + log + CHANGELOG + RUN_STATE);
- appending a "lesson" to AGENTS.md at the end of every session.

When there is no reusable lesson, not writing is the correct behavior.

## Recovery priority

When resuming in a new session, take facts in this order:

1. the current repo / Git;
2. Task Card / SPEC;
3. the bounded state JSON;
4. ADR / docs / AGENTS;
5. chat history only as a supplement, never as the state database.
