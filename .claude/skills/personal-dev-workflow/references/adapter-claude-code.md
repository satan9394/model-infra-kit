# Claude Code Adapter

- Keep long-term project rules in CLAUDE.md / AGENTS.md (per your project's convention) — short, stable, mistake-driven.
- Hooks are for deterministic policy / safety boundaries; the Skill is for on-demand working methods. Do not merge the two into one giant Prompt.
- `standard` does not auto-continue cards; enter `bounded` explicitly when you need long-running autonomy.
- For large changes, let an independent Claude session / subagent act as evaluator, seeing only the task card, diff, and test evidence.
- If you use hooks for budget enforcement, have the hook call the same `runstate.js` contract — avoid writing one set of numbers in the Skill and another in the host rules.
