# Verification: evidence, not ritual

## Common gates

Every card must at least answer:

1. Does it meet the card's acceptance criteria?
2. Did it go out of scope or touch a forbidden area?
3. Did it introduce interface / data / security regressions?
4. Can the evidence be reproduced by the next Agent or human?

## Evidence Profiles

### docs

- link / reference / structure checks;
- terminology and factual consistency;
- run doc build or lint when needed;
- do not demand pointless code tests / screenshots.

### backend / library

- relevant unit / integration tests;
- type / static checks;
- critical error paths;
- public API / compatibility;
- run build only when the project has a build gate.

### frontend / UI

- relevant tests + build;
- real browser interaction;
- screenshots for visual / layout tasks;
- pick responsive or accessibility checks per the acceptance criteria.

### infra / automation

- dry-run / validate / plan;
- config syntax and idempotency;
- never treat a real deploy as the default verification;
- production side effects must be escalated for authorization.

### security / risk

- independent evaluator;
- threat model / abuse paths;
- negative tests;
- explicit blast radius and irreversibility.

## Evaluator principles

An independent evaluator is best for:

- large changes;
- subjective quality;
- security / permissions;
- after the executor has already repaired once;
- results that easily "feel fine" but are hard to judge objectively.

The evaluator's input is preferably: the task card + diff + reproducible evidence, not the whole execution chat history.

## Repair

Allow one targeted repair for the same failure cause. On a second failure, stop and mark `BLOCKED`; do not manufacture infinite loops with "try once more".
