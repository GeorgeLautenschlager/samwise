# Decisions

Durable decisions for Samwise, newest first. Each entry records what was
decided, the evidence, and what would reopen it.

## 2026-09-27 — Memory stack: config A (pi-memory + qmd)

**Decision:** Samwise uses **config A**, pi-memory 0.4.2 with qmd 2.8.3 for
search, as T1 installs it. Config B (pi-memory without qmd) is rejected. Mem0
is not evaluated: A's remaining misses are not retrieval failures (D14).

### Setup

| | |
|---|---|
| Model | `openai-codex/gpt-6-luna` (Pi default thinking level for Samwise's agent dir) |
| Versions | pi 0.87.1, pi-memory 0.4.2, qmd 2.8.3 (facd35e), node v22.23.2 |
| Golden set | 15 synthetic scenarios (T5), 5 runs each, 75 runs per config |
| Harness | `eval/run.mjs` (T6), 2 concurrent runs, CPU-only machine (no GPU) |

### Results

Rates are passed runs / 75 per config (25 recall, 15 preference, 15
stale-knowledge, 20 scope-leak). Targets: recall and preference ≥ 80% (AC2),
stale-knowledge ≥ 90% (AC4), 0 leaks (AC3).

| Run | Config | Recall | Preference | Stale | Leaks | Verdict | Report |
|---|---|---|---|---|---|---|---|
| 1 | A | 52%* | 67%† | 87%* | 0 | invalid | `2026-09-27-2041-config-A` |
| 1 | B | 0% | 67%† | 100% | 0 | FAIL | `2026-09-27-2149-config-B` |
| 2 | A | 64% (88%‡) | 93% | 100% | 0 | FAIL | `2026-09-27-2321-config-A` |
| 2 | B | 0% | 93% | 93% | 0 | FAIL | `2026-09-27-2347-config-B` |
| **3** | **A** | **100%** | **93%** | **100%** | **0** | **PASS** | `2026-09-28-0106-config-A` |

\* Invalid: orphaned qmd searches starved the CPU and semantic searches timed
out (every A recall failure in run 1 was a timeout). See "What the bake-off
changed" item 4.
† `no-orm-hot-path` mis-measured (item 5).
‡ Run 2 recall by AC2's own wording (earlier problem + resolution): 22/25;
the golden set also requires the PR pointer (16/25).

**Why A over B.** Without qmd, Samwise never found older experience: in run 2,
B saw a seeded log entry in 0 of 25 recall runs. pi-memory only injects
today's and yesterday's logs, and search is what reaches further back. B was
not re-run with the final contract, since its recall failure is structural
(no search), not something a contract change can fix.

**The remaining miss (run 3).** In one `no-orm-hot-path` run, Samwise recalled
the "hand-written SQL, no ORM" decision but asked for the schema instead of
writing code, so nothing contained `SELECT`. Reasonable behaviour, counted as a
fail.

Reports (markdown + JSON) are committed in `eval/reports/`; transcripts are
kept locally only (git-ignored).

### What the bake-off changed along the way

The first smoke runs and bake-off exposed problems in the contract and the
harness, not in the memory stack itself. Each was fixed with a test before the
runs that count:

1. **Keyword search misses paraphrased problems.** qmd's keyword mode needs
   every query word to match, so "consumer lag" never finds a log about a
   "backlog". The contract now has Samwise search past problems in `semantic`
   mode and keep `keyword` for exact names and IDs.
2. **Search results are truncated snippets**, which cut off what worked and
   its pointers. The contract now has Samwise `memory_read` the full day's log
   on a hit.
3. **Keystone was not consulted for company facts** when memory had an
   answer. The contract now says: Keystone first for Thanx facts; it wins.
4. **Orphaned qmd searches.** pi-memory gives up on a search after 60 s but
   leaves the qmd process running. In run 1 these piled up (load average 43 on
   12 cores), later searches timed out, and config A's recall collapsed to
   52%. Run 1 is therefore **invalid for A**; its reports are kept as
   evidence. The runner now reaps every process a run started.
5. **`no-orm-hot-path` was mis-measured.** Samwise applied the decision in
   10/10 run-1 transcripts but wrote the code to a file, which a reply-only
   check could not see. The scenario now uses `artifact_includes`.
6. **Pointers and search discipline.** In run 2, 22/25 recall runs found the
   earlier problem and fix, but 6 omitted the PR pointer and 3 did not search.
   The contract now says: search before any troubleshooting or implementation
   work, and cite the pointers verbatim. Run 3 re-ran A with that contract.

### AC5: network

With `--network`, every outbound connection from Pi and its Node children was
logged in the A runs:

| Destination | Connections (run 3, 75 runs) |
|---|---|
| chatgpt.com:443 | 119 |
| registry.npmjs.org:443 | 5 |

- `chatgpt.com` is the model provider.
- `registry.npmjs.org` comes only from `pnpm-not-npm`, where Samwise ran
  `pnpm add zod`: a package install it was asked to do.
- Run 1 also contacted HuggingFace, in one run only. Bootstrap had cached just
  the embedding model, and qmd fetches its re-ranking and query-expansion
  models (used by `deep` search) on first use; all three were cached
  afterwards, and runs 2 and 3 never contacted HuggingFace. Model downloads
  send no memory content, but a running Samwise should not need them: see
  follow-ups.
- No memory content went anywhere but the model provider. Caveat: non-Node
  processes (e.g. a `curl` the model runs) are not captured.

### Open questions resolved

- **Q1** (configurable data dir): yes, `PI_MEMORY_DIR`; no symlink (T1/T2).
- **Q2** (index raw session transcripts): **no.** A's misses were pointer
  omissions and skipped searches, not logs lacking detail; the seeded logs
  were always found when searched.
- **Q3** (pi-gondolin): still open, pending T8. The contract names no paths, so
  only a mount could change.
- **Q6** (qmd needs Bun): no; qmd 2.8.3 runs on Node (T1).

### Follow-ups

- Done: bootstrap now runs `qmd pull` when any of the three qmd models is
  missing, so a running Samwise never contacts HuggingFace.
- Report upstream: pi-memory leaves qmd running after its search timeout
  (orphaned processes).
- Semantic search on a CPU-only machine takes ~3.6 s per call; George's Thanx
  laptop (GPU) should be faster. Revisit if searches time out there.

### What would reopen this

- A different model for Samwise at Thanx: re-run `eval/run.mjs` with it.
- Recall falling below 80% on real work, or the real Keystone interface
  differing from the mock.
