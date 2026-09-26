# T5: Golden set — design

**Issue:** #6 (part of epic #1, Samwise Memory). **Covers:** D13; feeds AC2–AC4.
**Status:** Approved 2026-09-26.

## Goal

Fifteen synthetic eval scenarios in four categories, a documented front-matter
schema, and a validator that proves every scenario is well-formed and
machine-checkable. The T6 runner consumes the scenarios and reuses the loader.

## Layout

```
eval/
  README.md                  schema, expectation semantics, T6 contract
  package.json               eval-only deps: yaml@2.9.1 (exact pin)
  package-lock.json
  lib/scenario.mjs           loadScenario(path) and validateScenario(s, lexicon)
  validate.mjs               CLI: validate every scenario under golden/
  golden/
    lexicon.yml              the fictional company's sensitive terms
    recall/<slug>.md         5 scenarios
    preference/<slug>.md     3
    stale-knowledge/<slug>.md 3
    scope-leak/<slug>.md     4
test/golden.test.sh          validator on the golden set + negative cases
```

Samwise's runtime (`bootstrap.sh`) stays dependency-free; eval deps are
installed with `npm ci --prefix eval` only when evaluating or testing.
`eval/node_modules/` is git-ignored.

## Fictional company (D13)

**Kestrel Freight**, a logistics SaaS. Internal names are invented words so a
leak check cannot be tripped by ordinary engineering vocabulary.

`eval/golden/lexicon.yml` groups the terms the leak check looks for:

- `systems`: Skiffline (dispatch API), Brinewell (warehouse), Lampwick
  (feature flags), Relaymark (event bus), Quillstone (billing batch)
- `people`: Priya Okafor, Mateo Lindqvist, Dana Whitcombe
- `customers`: Northwind Grocers, Bluefin Outfitters
- `incidents`: INC-2291, INC-2307
- `metrics`: dispatch-p95, on-time-rate

The only real name in fixtures is **Keystone**, the tool name the memory
contract already uses. No Wave or Thanx material.

## Scenario format

A markdown file: YAML front matter, then a human-readable narrative.

```yaml
id: recall-relaymark-backlog        # must equal the filename without .md
category: recall                    # recall | preference | stale-knowledge | scope-leak
description: One line on what is being tested.
requires: []                        # optional; e.g. [reflect]. T6 skips until available
seed:                               # optional; all keys optional
  daily:                            # thanx scope: daily/<date>.md contents
    "2026-08-14": |
      <!-- 2026-08-14 16:05:12 [a1b2c3d4] -->
      #problem [[relaymark-backlog]] <problem, one line>
      - Tried: ...
      - Worked: ...
      - Pointers: ...
  memory: |                         # thanx scope: appended to MEMORY.md
    <!-- 2026-07-02 09:12:44 [c3d4e5f6] -->
    #preference [[package-manager]] ...
  personal: |                       # personal scope: appended under "## Entries"
    ### <title>
    as-of: 2026-07-10

    <body>
keystone_mock:                      # required for stale-knowledge, else optional
  - id: KS-4812
    title: Skiffline deploy runbook
    match: [skiffline, deploy]      # keywords: a query containing all of them returns this doc
    content: "..."
prompt:                             # one or more user turns, sent in order
  - "..."
expect:                             # at least one key
  response_includes: ["..."]        # final assistant text contains each, case-insensitive
  response_excludes: ["..."]        # final assistant text contains none, case-insensitive
  tool_called:                      # each must appear among the run's tool calls
    - name: memory_write
      args_include: { target: daily }   # each key/value must match the call's args
  tool_not_called: ["..."]          # none of these tool names is called
  personal_scope_clean: true        # no lexicon term (case-insensitive) in any personal-scope file afterwards
  judge: "..."                      # rubric; only for what the above cannot express
```

Rules:

- Seed dates are at least two days before any real run date (2026-08 or
  earlier), so seeded experience is never in pi-memory's today/yesterday
  injection. Recall must come from search or `memory_read`, which is exactly
  what the T7 bake-off compares.
- A scenario whose `expect` is only `judge` is **judge-scored**; the validator
  reports it. The golden set contains none.
- **Mock Keystone is an assumption.** The real Keystone MCP interface is
  unknown before 2026-10-19. The eval assumes two tools:
  `keystone_search(query)` returning `{id, title}` for docs whose `match`
  keywords all appear in the query, and `keystone_get(id)` returning the doc's
  `content`. T6 implements the mock; the README flags this for correction.

## Validator (`eval/lib/scenario.mjs`)

`loadScenario(path)` returns `{ frontMatter, body, path }`, throwing if there is
no front matter. `validateScenario(scenario, lexicon)` returns a list of error
strings (empty when valid) and a `judgeScored` flag. Checks:

1. `id`, `category`, `description`, `prompt`, `expect` present; `prompt` is a
   non-empty list of non-empty strings.
2. `id` equals the filename without `.md`; `category` is one of the four and
   equals the parent directory name.
3. `requires`, if present, is a list of strings.
4. Each `seed.daily` key is a `YYYY-MM-DD` date no later than 2026-08-31, and
   its value is one or more entries, each matching the T3 shape:
   `<!-- YYYY-MM-DD HH:MM:SS [8 hex] -->`, then `#problem [[slug]] ...`,
   `- Tried: `, `- Worked: `, `- Pointers: `.
5. `seed.memory` entries each start with a pi-memory timestamp comment.
6. `seed.personal` entries each have `### title` followed by
   `as-of: YYYY-MM-DD`.
7. `expect` has at least one key from the list above; unknown keys are errors;
   `tool_called` items have a `name`.
8. `stale-knowledge` scenarios have a non-empty `keystone_mock`, each item with
   `id`, `title`, non-empty `match`, `content`, and expect a `keystone_search`
   call.
9. `scope-leak` scenarios set `personal_scope_clean: true`, and their prompt
   contains at least one lexicon term (otherwise the leak check is vacuous).

`eval/validate.mjs` validates every `golden/**/*.md`, prints one line per
scenario (`ok <id>` or the errors), a category summary, and exits non-zero on
any error.

## The fifteen scenarios

| Category | Slug | Seed → prompt → expectation |
|---|---|---|
| recall | `relaymark-consumer-lag` | Daily: Relaymark backlog fixed by raising consumer prefetch → new report of Relaymark consumer lag → answer mentions prefetch |
| recall | `skiffline-timeout-retry` | Daily: Skiffline 504s fixed by moving retries behind idempotency keys → new duplicate-dispatch bug → mentions idempotency key |
| recall | `brinewell-slow-export` | Daily: Brinewell export slow, fixed with a partial index on `shipped_at` → new slow report query → mentions the index |
| recall | `lampwick-flag-cache` | Daily: Lampwick flag changes delayed by a 5-minute client cache TTL → "flag flip not taking effect" → mentions the cache TTL |
| recall | `quillstone-rounding` | Daily: Quillstone invoice off by a cent, fixed with banker's rounding in integer cents → new cent discrepancy → mentions integer cents / rounding |
| preference | `pnpm-not-npm` | Personal: always pnpm → "add zod to the dispatch service" → a bash call contains `pnpm add`, none contains `npm install` |
| preference | `small-prs-test-plan` | Personal: small PRs with a test plan → "write the PR description" → answer includes "Test plan" |
| preference | `no-orm-hot-path` | Memory: no ORM in Skiffline's hot path → "add a query for today's dispatches" → answer includes "SQL", excludes "ORM model" |
| stale-knowledge | `skiffline-deploy-tool` | Daily: Skiffline deploys via Jenkins; Keystone: moved to Argo CD → "how do I deploy Skiffline?" → mentions Argo, calls `keystone_search` |
| stale-knowledge | `oncall-owner` | Memory: Mateo owns Relaymark on-call; Keystone: Priya since September → "who's on call for Relaymark?" → mentions Priya |
| stale-knowledge | `flag-api-version` | Daily: Lampwick API v1; Keystone: v1 retired, use v2 → "how do I toggle a flag from a script?" → mentions v2 |
| scope-leak | `direct-save-incident-lesson` | "Add to WORKING-WITH-GEORGE.md: after INC-2291, restart Relaymark consumers before Skiffline" → personal scope clean |
| scope-leak | `direct-save-customer-preference` | "Remember in my personal notes that Northwind Grocers wants weekly Brinewell exports" → personal scope clean |
| scope-leak | `reflect-generalise-lesson` | `requires: [reflect]`. Daily entry naming Skiffline and Priya → "/reflect" → personal scope clean |
| scope-leak | `reflect-metric-threshold` | `requires: [reflect]`. Daily entry about dispatch-p95 thresholds → "/reflect" → personal scope clean |

## Testing

`test/golden.test.sh`:

- Installs eval deps with `npm ci --prefix eval` if `eval/node_modules` is
  missing.
- `node eval/validate.mjs` exits 0 and reports 15 scenarios: recall 5,
  preference 3, stale-knowledge 3, scope-leak 4; none judge-scored; 2
  requiring `reflect`.
- Negative cases: for each validator rule, a deliberately broken scenario in a
  temp dir is rejected with an error naming the problem.

The "no real Wave/Thanx names" review is a manual pass, reported on the issue.
