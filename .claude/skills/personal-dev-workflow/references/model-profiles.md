# Model Capability Profiles

The core Skill does not bind to specific model names. Choose a model by task phase, not by brand.

| Role | More important capabilities | Negotiable |
|---|---|---|
| Planner | long context, codebase understanding, requirement convergence, blast-radius analysis | execution speed |
| Executor | tool reliability, code editing, local reasoning, speed / cost | very long global planning |
| Evaluator | skepticism, completeness, security / test awareness, independent perspective | generation speed |
| Researcher | retrieval coverage, evidence quality, source judgment | code-writing ability |

## Routing principles

1. **Don't upgrade when the capability is already enough.** A clear task card does not need a top-tier model re-planning repeatedly.
2. **Use heterogeneity only when it pays.** Independent review, security audit, and subjective design justify a different model / context; ordinary small changes do not.
3. **Shrink the task before adding model.** On repeated failure, first check the task definition, tools, context, and verification — don't just reach for a "smarter model".
4. **Model names live in presets.** The core keeps only capability contracts; specific model versions can be updated at any time.
