# EVO-G131 local archive delivery — 2026-10-11

Baseline: `78007e12633a84b1b707637be188c0031e97f5eb`, local `main`, package version 1.6.0. Single-card bounded Mission; local commit explicitly authorized. No push, npm publication, dependency installation, dashboard source edits or filesystem deletion.

Implemented streaming gzip shards and a SHA-256 manifest with exact BigInt cost/savings totals; offline verification; transactionally verified fold/prune; optional post-commit VACUUM; bilingual `mik db archive export|verify|prune`. Existing JSONL archive syntax, runtime export names, Schema v7 and build `clean: false` remain compatible.

- `packages/mik/src/archive/manifest.ts`: types, fixed-order checksum, bounded serialization, parsed-tag redaction and safe JSON diagnostics.
- `stream-export.ts`: new-directory reservation, 16-row keyset cursor with byte bounds/high-water mark, backpressured gzip, compressed-byte/data hashes, durable file synchronization, manifest publication after shards finish.
- `verify-prune.ts`: bounded manifest/decompression checks, canonical filenames, strict counts/integers/timestamp range, both ledgers and full data digest; write-locked database comparison followed by existing conserved rollups.
- Usage repository/service/index: additive APIs and type-only exports; old default 256-row archive path preserved.
- CLI args/db and en/zh dictionaries: nested archive actions, offline verify without opening a DB, additive 16 paired labels. Frozen dictionary-count gate updated from 377 to 393 without changing parity or legacy values.
- Tests: export, gzip, redaction, oversized/malformed records, archive corruption, forged metadata totals, one-microdollar cost/savings drift, identity drift, traversal/duplicates/missing shards, atomic rollback, retained newer details, summary conservation, repeat-prune refusal, file-space reclamation and CLI locales/exit codes.

Final verification is recorded in `.tmp/g131/verification.json` with command, exit code and elapsed time. All seven final steps exited 0, after the last source edit:

| Gate | Result | Wall time |
|---|---|---:|
| dashboard typecheck | 0 errors | 5.284 s |
| core typecheck | 0 errors | 9.523 s |
| en_US.UTF-8 core | 1151/1151, 74 files | 57.736 s |
| zh_CN.UTF-8 core | 1151/1151, 74 files | 64.653 s |
| dashboard tests | 75/75 | 4.360 s |
| E2E | 12/12 PASS | 26.338 s (runner 21.1 s) |
| tsdown build | PASS, clean:false retained | 5.307 s |

Locale selection used only LC_ALL/LANG; MIK_LANG was absent and never globally set. No remote three-OS CI was run because push is prohibited. Final built-artifact smoke (`node .tmp/g131/dist-smoke.mjs`, exit 0) preserves exact runtime exports root42 / cli29 / server11 / auto2, includes all three new type exports, and runs the built CLI to verify the 100000-record archive while asserting the supplied nonexistent DB stays nonexistent. `dist-smoke.log` records the actual output. E2E dynamic service/dashboard ports 56984/53472 were confirmed without listeners after runner completion; artifacts remain retained.

Focused source verification: **53/53 PASS** across the three new suites plus legacy data-archiving. The timezone regression demonstrably failed before its fix; Honolulu export now verifies in Tokyo. The manifest's recorded absolute cutoff is authoritative, avoiding verifier-host timezone recalculation.

Memory reproduction: `node --expose-gc --experimental-transform-types --import ./scripts/e2e/loader.mjs scripts/archive-memory.mjs`. Final code exported and verified **100000 records / 40 shards**, cost **300000 micros**, savings **200000 micros**. JS heap peak **29350736 bytes (28.0 MiB)**; measured heap/external growth **33406267 bytes (31.9 MiB)**; baseline RSS **83206144 bytes (79.4 MiB)** and peak RSS **125886464 bytes (120.1 MiB)**, growth **42680320 bytes (40.7 MiB)**. Both JS-heap and archive-growth assertions stayed below 50 MiB. This proves the sampled archive working-memory bound, not a universal total-process RSS <50 MiB or absence of OOM for arbitrary host loads. SQLite text bytes are bounded before crossing into JS, NDJSON lines at 64 KiB, manifest at 4 MiB and shards at 10000. All memory fixtures and failure artifacts are retained in temporary directories printed in the logs.

Failure evidence retained:

1. Initial FileHandle stream closure hung until the focused test timed out; replaced with auto-closing write stream followed by explicit fsync. Type errors and fixture assumptions were corrected before passing focused gates.
2. Full English gate initially failed only the frozen dictionary count after 16 additive labels; all three count assertions updated with parity intact. `.tmp/g131/core-en-attempt1.log` and `verification-attempt1.json` retained.
3. Cross-timezone offline verification was proven red in `.tmp/g131/timezone-before.log` and fixed before final gates.
4. A final Chinese attempt hit the existing 2 ms Trace-tree timing assertion at **2.0463 ms** while the memory workload was running concurrently. The threshold/code were not changed; failure preserved as `core-zh-contention.log` / `verification-contention.json`. Ordered final gates were rerun after that workload finished.

`ponytail:` gzip only, new output directory only, fixed input bounds, no resume/overwrite protocol. Export does not hold a write lock across asynchronous compression; current full record digest/count/ledgers must still match inside the later prune transaction. Drift requires a fresh export. SHA-256 checksums prove internal consistency/corruption detection, not authenticated provenance; archive-directory protection remains the host's responsibility. Optional VACUUM executes after the conserved fold commits; a VACUUM error cannot undo that fold. G130 local-cache ratios and tag tokens remain retained-detail metrics.

Ownership: all Git changes in this delivery belong to EVO-G131; no pre-existing dirty files. Task card/BOARD, workspace HANDOVER, bounded state and `.tmp` evidence follow existing ignore rules and are updated locally without force-adding. Final commit SHA and standby state are recorded in workspace `memory/HANDOVER.md`. No user-level Codex memories were edited.