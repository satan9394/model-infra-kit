# Optional Preset: AGY plan/adversarial → Codex execute

> This is a personal-preference example preset, not a core default. Specific model names are volatile config — swap them freely.

```text
requirement
  → AGYCLI: plan / codebase scan / task card
  → optional independent adversarial review
  → Codex: execute per card
  → independent verification (for high-risk / large changes)
```

Example configuration:

| Phase | Tool / model | Goal |
|---|---|---|
| Plan | AGYCLI + Gemini 3.8 Flash (High) | fast project scan, blast radius, card breakdown |
| Execute | Codex + GPT-6 Luna (Medium) | implement and test against clear cards |
| Review | heterogeneous from executor, or fresh context | find flaws using only card, diff, evidence |

## When to use

- the task is complex enough that splitting planning from execution genuinely reduces execution context;
- do not force "planning Agent + adversarial Agent + execution Agent + review Agent" on every small card;
- if the card is already clear and low-risk, executing directly is more efficient.

## Handoff format

What you hand to the executor must be self-contained: goal, acceptance, affected files, forbidden actions, current source of truth. Do not ask the executor to re-read the planning chat history.
