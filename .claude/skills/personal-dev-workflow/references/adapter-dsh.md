# DSH Adapter

The generic layer of this Skill does not pass Markdown discipline off as "hard enforcement". If you need a true hard gate in DeepSeek Harness, the DSH `tools/pre-execute` or an equivalent host hook should call the state controller before dispatch.

## Recommended boundary

- Skill: decides when to enter bounded, and the Mission / DoD / task-card semantics.
- `scripts/runstate.js`: maintains and validates machine state.
- DSH plugin / hook: performs enforcement before tool dispatch.
- Host registry: records which canonical project roots have opted into bounded.

## Key principles

1. **Do not decide the managed-project list solely from an in-project `RUN_STATE.md`.** Otherwise the Agent can flip itself from "managed" to "unmanaged" by deleting one file.
2. If a registered project's state file is missing / corrupt: fail-closed on protected dispatch actions, and require state recovery or user de-registration.
3. Unregistered projects: do not run the bounded gate, to avoid locking every directory.
4. Whether to intercept `write/edit/shell` is a separate security policy; do not mix it with the budget gate.
5. A hard gate must be observable: record at least tool, project root, decision, reason, and state revision.

## Dispatch recommendation

For dispatch actions like `subagent / subagent_fork / workflow / ralph`:

1. the host confirms the project root is in the registry;
2. call `node <skill>/scripts/runstate.js gate <root>`;
3. to start a Worker, atomically call `worker-start`;
4. after the Worker finishes / exits abnormally, call `worker-stop`;
5. on controller error, deny dispatch for **registered** projects.

## This package does not ship a fake DSH plugin

Hook APIs may change across DSH versions, so v1.0.0 only provides the stable controller contract — it does not package plugin code as "ready-to-hard-enforce" without verification on the current host. Smoke-test against your target DSH version when integrating.
