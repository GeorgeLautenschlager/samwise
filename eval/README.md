# Samwise memory eval

A golden set of synthetic scenarios (D13) that exercise Samwise's memory, and
the tooling to validate them. The T6 runner executes them; results feed the
T7 bake-off.

```bash
npm ci --prefix eval      # once: installs yaml (eval-only dependency)
node eval/validate.mjs    # validate every scenario; exit 1 on any error
```

## Categories

| Category | Tests | Scored against |
|---|---|---|
| `recall` | A new problem resembles a seeded one; Samwise surfaces the earlier problem and fix unprompted | AC2 (≥ 80%) |
| `preference` | Samwise applies a seeded preference or decision without being told | AC2 |
| `stale-knowledge` | Seeded memory contradicts mock Keystone; Samwise prefers Keystone | AC4 (≥ 90%) |
| `scope-leak` | A request tempts a Thanx-specific write to the personal scope; nothing leaks | AC3 (0 leaks) |

## Fictional company

All content is about **Kestrel Freight**, an invented logistics company.
`golden/lexicon.yml` lists its internal systems, people, customers, incidents
and metrics; these count as Thanx-specific for the leak check. The only real
name used is **Keystone**, the knowledge tool named in the memory contract.

## Scenario format

`golden/<category>/<id>.md`: YAML front matter, then a narrative for humans.

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Equals the filename without `.md` |
| `category` | yes | One of the four above; equals the parent directory |
| `description` | yes | One line |
| `requires` | no | Capabilities the scenario needs, e.g. `[reflect]`; skip the scenario until they exist |
| `seed.daily` | no | `YYYY-MM-DD: <log text>` written to the thanx scope's `daily/<date>.md`. Entries use the memory contract's format, each preceded by pi-memory's `<!-- YYYY-MM-DD HH:MM:SS [8 hex] -->` line. Dates are no later than 2026-08-31, so they are never in pi-memory's today/yesterday injection |
| `seed.memory` | no | Entries appended to the thanx scope's `MEMORY.md`, each starting with a pi-memory timestamp line |
| `seed.personal` | no | Entries appended under `## Entries` in the personal scope's `WORKING-WITH-GEORGE.md`: `### title`, `as-of: YYYY-MM-DD`, body. Never contains a lexicon term |
| `keystone_mock` | stale-knowledge | Docs served by the mock Keystone: `id`, `title`, `match` (keywords), `content` |
| `prompt` | yes | User turns, sent in order |
| `expect` | yes | Assertions, below |

### Expectations

All are checked without an LLM except `judge`.

| Key | Passes when |
|---|---|
| `response_includes: [s]` | The final assistant message contains every string (case-insensitive) |
| `response_excludes: [s]` | The final assistant message contains none of them (case-insensitive) |
| `artifact_includes: [s]` | The final message or anything written with the `write`/`edit` tools contains every string (case-insensitive) |
| `artifact_excludes: [s]` | Neither the final message nor anything written contains any of them (case-insensitive) |
| `tool_called: [{name, args_include?}]` | Each item matches at least one tool call in the run |
| `tool_not_called: [name or {name, args_include?}]` | No tool call matches any item |
| `personal_scope_clean: true` | After the run, no lexicon term (case-insensitive) appears in any personal-scope file |
| `judge: "<rubric>"` | An LLM judge applies the rubric. A scenario with only `judge` is **judge-scored**; the golden set has none |

A tool call matches `{name, args_include}` when the names are equal and, for
each `args_include` key, the call's argument contains the string value
(case-sensitive substring) or equals a non-string value.

## Running the eval

```bash
npm ci --prefix eval
node eval/run.mjs --config A --model <provider/id>            # 5 runs per scenario
node eval/run.mjs --config B --model <provider/id> --network  # with AC5 evidence
```

| Flag | Default | Meaning |
|---|---|---|
| `--config` | required | `A` (pi-memory + qmd) or `B` (no qmd); see `lib/configs.mjs` |
| `--model` | required | Pi model, e.g. the one Samwise will use at Thanx |
| `--runs` | 5 | Runs per scenario |
| `--jobs` | 1 | Concurrent runs |
| `--only` | all | Comma-separated scenario ids |
| `--network` | off | Log outbound connections (AC5) |
| `--auth` | `~/.pi/agent/auth.json` | Symlinked into each run (refreshes write back); `none` to skip |
| `--models-json` | none | Copied into each run's agent dir (local or stub models) |
| `--timeout` | 600 | Seconds per Pi session |
| `--keep` | off | Keep run dirs (auth link removed) |
| `--golden`, `--out` | `eval/golden`, `eval/reports` | Inputs and outputs |

Each run gets a throwaway `SAMWISE_HOME` built by the real `bootstrap.sh`
(qmd is shared from a base home prepared once), a copy of
`WORKING-WITH-GEORGE.md`, and a scratch git workspace as its cwd. The runner
aborts (exit 3) if the real `WORKING-WITH-GEORGE.md`, `pi/AGENTS.md`, the
config repo's git status or the real thanx scope change during the eval.

Reports: `eval/reports/<date>-<time>-config-<X>.md` and `.json` (commit
them); transcripts sit in the matching directory, which is git-ignored.
Exit code: 0 for PASS, 1 for FAIL or INCOMPLETE, 2 for usage errors.

## Runner contract (T6)

- Run each scenario in a throwaway `SAMWISE_HOME` and a **copy** of
  `WORKING-WITH-GEORGE.md`, never the real one, with seeds applied as above.
- **Mock Keystone (assumption).** The real Keystone MCP interface is unknown
  until 2026-10-19. The mock exposes `keystone_search(query)`, returning
  `{id, title}` for each doc whose `match` keywords all appear in the query
  (case-insensitive substrings), and `keystone_get(id)`, returning `content`.
  Revisit once the real interface is known.
- Skip scenarios whose `requires` are not yet available (`reflect` arrives
  with T4) and report them as skipped, not passed.

## Validation rules

`lib/scenario.mjs` rejects a scenario when: a required key is missing; `id`
or `category` disagree with the path; `prompt` is not a non-empty list of
strings; `requires` is not a list; a seed entry breaks its format or a daily
date is too recent; `seed.personal` contains a lexicon term; `expect` is
empty or has an unknown or malformed key; a stale-knowledge scenario lacks
`keystone_mock` or a `keystone_search` expectation; or a scope-leak scenario
lacks `personal_scope_clean: true` or a lexicon term in its prompt or seed.
