# T6: Eval runner — design

**Issue:** #7 (part of epic #1, Samwise Memory). **Covers:** AC2, AC3, AC4; tooling for AC5.
**Status:** Approved 2026-09-27.

## Goal

One command runs the golden set (T5) through real, isolated Samwise sessions
for a given config, scores each run against its `expect` block, maps the rates
to AC2–AC4, and writes a committed-friendly report. An optional mode records
outbound network connections as AC5 evidence.

## Command

```
node eval/run.mjs --config A|B --model <provider/id>
                  [--runs 5] [--jobs 1] [--only <id,...>] [--network]
                  [--models-json <path>] [--auth <path>] [--keep]
                  [--golden <dir>] [--out <dir>]
```

| Flag | Default | Meaning |
|---|---|---|
| `--config` | required | Config from the registry (`A`, `B`) |
| `--model` | required | Passed to Pi's `--model`; recorded in the report |
| `--runs` | 5 | Runs per scenario (targets are rates) |
| `--jobs` | 1 | Runs executed concurrently |
| `--only` | all | Comma-separated scenario ids |
| `--network` | off | Record outbound connections (AC5) |
| `--models-json` | none | Copied into each run's agent dir (stub LLM in tests, local models) |
| `--auth` | `~/.pi/agent/auth.json` if it exists | Copied into each run's agent dir, mode 600 |
| `--keep` | off | Keep run dirs (with `auth.json` removed) |
| `--golden` | `eval/golden` | Golden-set directory |
| `--out` | `eval/reports` | Report directory |

## Per-run flow

1. **Sandbox** (`eval/lib/sandbox.mjs`) under a fresh temp dir:
   - `personal/WORKING-WITH-GEORGE.md`: a copy of the repo's file with
     `seed.personal` appended under `## Entries`.
   - `home/`: `tools` symlinked to the shared base home's `tools` (qmd is
     installed once per eval invocation, into the base, by running bootstrap
     there). Then run the real `bootstrap.sh` with `SAMWISE_HOME=<run>/home`
     and `SAMWISE_PERSONAL_WISDOM=<run>/personal/WORKING-WITH-GEORGE.md`.
   - Seeds: `seed.daily` → `home/memory/daily/<date>.md`; `seed.memory` →
     appended to `home/memory/MEMORY.md`. Then `qmd update` and `qmd embed`
     with the run's environment.
   - `--auth` and `--models-json` copied into `home/agent/`.
   - `workspace/`: the run's cwd, a git repo with a minimal `package.json`.
   - The config's `prepare(run)` hook runs last.
2. **Keystone mock:** the scenario's `keystone_mock` is written to
   `<run>/keystone.json`; the Pi extension `eval/keystone-mock.ts` (loaded with
   `-e`) reads it via `KEYSTONE_MOCK_FILE` and registers `keystone_search`
   (returns `{id, title}` for docs whose `match` keywords all appear in the
   query, case-insensitive) and `keystone_get` (returns `content`).
3. **Run** (`eval/lib/pi-run.mjs`): `bin/samwise --mode json --model <m>
   -e eval/keystone-mock.ts <prompt turns...>` in `workspace/`, stdin closed,
   `SAMWISE_HOME=<run>/home`, `PI_MEMORY_EXIT_SUMMARY=0`, a per-run timeout
   (default 600 s). The JSONL stream is saved as the transcript and parsed
   into `finalText` (the text of the last assistant `message_end`) and
   `toolCalls` (`{name, args}` for every tool call in assistant messages).
4. **Score** (`eval/lib/expect.mjs`, pure): each `expect` key becomes a check
   `{key, pass, detail}` over `{finalText, toolCalls, personalFiles,
   lexicon}`, per the semantics in `eval/README.md`. The **leak check**
   (no lexicon term in any personal-scope file) runs on every run in every
   category, whether or not the scenario lists `personal_scope_clean`.
5. **Clean up:** delete the run dir unless `--keep` (then delete only
   `auth.json`).

## Configs (`eval/lib/configs.mjs`)

A registry of `{ name, description, qmd, prepare(run) }`:

- **A** — pi-memory + qmd (production wiring).
- **B** — pi-memory without qmd: `prepare` removes `home/tools`, and the
  runner verifies `qmd` does not resolve on the run's `PATH` (aborting if it
  does, e.g. a global install). pi-memory then degrades to no search and no
  selective injection.

A third config (e.g. self-hosted Mem0) is another registry entry with its own
`prepare`.

## Bootstrap change

`bootstrap.sh` links `APPEND_SYSTEM.md` to
`${SAMWISE_PERSONAL_WISDOM:-<repo>/WORKING-WITH-GEORGE.md}`. The default is
unchanged; the runner uses the override so a run is never linked to the real
file.

## Isolation guard

Before the eval and after every run, the runner fingerprints: the real
`WORKING-WITH-GEORGE.md` and `pi/AGENTS.md` (content hashes), the config
repo's `git status --porcelain`, and the real thanx scope (`~/.pi/samwise/memory`
HEAD and `git status --porcelain`) if it exists. Any change aborts the eval
with a non-zero exit. Real `~/.pi/samwise` is never used as `SAMWISE_HOME`.

## Scoring and report

- A run passes when every check passes. Category rate = passed runs / runs.
- **AC2:** recall ≥ 80% **and** preference ≥ 80%.
- **AC3:** 0 leaks across all runs.
- **AC4:** stale-knowledge ≥ 90%.
- A category with no runs (e.g. all skipped) makes its criterion
  **not evaluated**, which is not a pass.
- Scenarios whose `requires` are unavailable are listed as skipped. The
  runner's available capabilities are a fixed list in `run.mjs` (empty until
  T4 adds `reflect`).
- **Verdict:** PASS only when AC2, AC3 and AC4 all pass.

`eval/reports/<YYYY-MM-DD>-config-<X>.md` and `.json` contain: config, model,
runs per scenario, pinned versions (Pi, pi-memory, qmd, Node), per-scenario
`k/N` with the first failure detail, per-category rates vs targets, AC
verdicts, skipped scenarios, and (with `--network`) the network section.
Transcripts go to `eval/runs/<timestamp>/`, which is git-ignored.

## Network capture (AC5)

With `--network`, each run sets `NODE_OPTIONS=--require <repo>/eval/netlog.cjs`
and `NETLOG_FILE=<run>/netlog.jsonl`. The hook wraps `net.Socket.prototype.connect`
and appends `{pid, host, port}` for every outbound connection from Pi and every
Node child process (including qmd). The report lists distinct `host:port`
destinations with counts across all runs, with the caveat that non-Node
processes (e.g. a `curl` the model runs) are not captured; a stronger audit
would use strace or a packet capture.

## Testing (no real LLM)

- **`test/eval-expect.test.sh`**: unit tests for `expect.mjs`: pass and fail
  for each expectation type, `args_include` substring vs equality, and the
  leak check.
- **`test/eval-runner.test.sh`**: runs `eval/run.mjs` end to end with
  `--models-json` pointing at a **scripted stub LLM**
  (`test/fixtures/scripted-llm.mjs`, which replays per-prompt tool calls and
  text) against a fixture golden set in `test/fixtures/golden/`. It asserts:
  seeds land in the run's memory; a scripted pass and a scripted fail are
  scored as such; the Keystone mock answers `keystone_search`; a leak planted
  through the stub's `write` tool is detected; config B has no qmd; real files
  are untouched; and `--network` logs the stub's host.
