# Codex Adapter

In Codex, treat this Skill as a **project working method**, not an extra infinite-loop Prompt.

- Keep stable project rules in AGENTS.md; this Skill only provides the process.
- `standard` delivers one card per loop by default — it does not auto-continue indefinitely.
- Enable `bounded` only when a long task needs continuous autonomy, and let the state file be the recovery entry point.
- When continuing in a new thread / context, read the Task Card, Git, and bounded state first — do not copy the whole old chat.
- You may use an independent Codex run for review, but only when the risk / scale justifies it.

If the Codex host itself has no pre-tool hook, `runstate.js` is only a cooperative controller and cannot claim to provide hard enforcement.
