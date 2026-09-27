# T4: `/reflect` — design

**Issue:** #5 (part of epic #1, Samwise Memory). **Covers:** D8, D9, D10, D11; AC3, AC6.
**Status:** Approved 2026-09-27.

## Goal

A batched consolidation step: Samwise reviews unreflected daily logs and the
current wisdom files, proposes additions, edits and retirements across both
scopes as **one** numbered diff, reroutes anything leaky away from the personal
scope, and writes and commits only what George explicitly approves.

## Decisions

- **Approval is conversational, enforced by a helper.** Samwise builds the
  proposal and a helper validates, leak-checks, renders and stores it as
  pending. Nothing is written until Samwise runs `apply` after George's
  explicit approval in his latest message. This relies on Samwise following the
  procedure and the contract (D8); it works unchanged in non-interactive eval
  runs.
- **Trigger: next-session nudge.** At session start, a small extension shows at
  most one notification a day when daily logs from before today are
  unreflected, or a proposal is pending.
- **Partial approval is in v1** (`apply --skip`/`--only`), since the diff is
  already numbered.

## Components (config repo, i.e. personal scope)

| File | Job |
|---|---|
| `pi/prompts/reflect.md` | The `/reflect` prompt template: the procedure |
| `bin/samwise-reflect` | CLI entry (`node lib/reflect/cli.mjs "$@"`) |
| `lib/reflect/entries.mjs` | Parse and serialise wisdom files into addressable entries |
| `lib/reflect/leak.mjs` | Deterministic leak check (vocabulary + patterns) |
| `lib/reflect/proposal.mjs` | Validate a proposal, apply leak reroutes, render the diff |
| `lib/reflect/repo.mjs` | Paths, unreflected-log discovery, writing and committing |
| `lib/reflect/cli.mjs` | `status`, `context`, `propose`, `apply`, `discard` |
| `pi/extensions/reflect-nudge.ts` | Session-start nudge |

Wiring:

- Bootstrap links `<agent-dir>/prompts` → `<repo>/pi/prompts` and
  `<agent-dir>/extensions` → `<repo>/pi/extensions` with the existing safe
  `link` rule (verified: Pi discovers templates and extensions through
  symlinked dirs, and `/reflect` expands in non-interactive runs).
- `bin/samwise` prepends `<repo>/bin` to `PATH`, so Samwise's bash tool can run
  `samwise-reflect`.

## Paths the helper uses

- Thanx scope: `$PI_MEMORY_DIR` (`MEMORY.md`, `daily/`, `VOCABULARY.md`).
- Personal wisdom: the target of `$PI_CODING_AGENT_DIR/APPEND_SYSTEM.md`
  (the repo's `WORKING-WITH-GEORGE.md` in production, the run's copy in evals).
- Pending proposal: `$SAMWISE_HOME/reflect/pending.json` (outside both repos).
- Nudge state: `$SAMWISE_HOME/reflect/nudged` (date of the last nudge).

## Entries

Both wisdom files hold entries in one format written by `/reflect`:

```
### <title>
as-of: YYYY-MM-DD

<body>
```

Parsing (`entries.mjs`):

- `WORKING-WITH-GEORGE.md`: entries are the `### ` blocks **after** the
  `## Entries` line (the template's example lives in a fenced block above it).
  Everything up to and including `## Entries` is the header.
- `MEMORY.md`: the header is everything before the first entry. An entry
  starts at a `### ` line or at a pi-memory timestamp line
  (`<!-- ... [...] -->`), so entries pi-memory wrote remain addressable.
- Ids are assigned in file order: `T1…` (thanx, `MEMORY.md`), `P1…`
  (personal, `WORKING-WITH-GEORGE.md`).
- Serialising writes the header, then each entry separated by a blank line;
  untouched entries are written back byte-for-byte.

## Proposal

`samwise-reflect propose` reads JSON on stdin:

```json
{
  "items": [
    { "op": "add", "scope": "personal", "title": "…", "body": "…" },
    { "op": "edit", "target": "T3", "title": "…", "body": "…" },
    { "op": "retire", "target": "P2", "reason": "George marked it wrong" }
  ],
  "vocabulary": ["Skiffline", "Priya Okafor"]
}
```

- `add` needs `scope` (`thanx` | `personal`), `title`, `body`. `edit` needs
  `target`, `title`, `body` and keeps the target's scope. `retire` needs
  `target`; `reason` is optional. Unknown ops, missing fields, unknown or
  duplicate targets are errors (exit 1, nothing stored).
- `vocabulary`: every Thanx-specific name Samwise saw in the material it
  reviewed (systems, customers, people, incidents, metrics).
- Every `add` and `edit` gets `as-of: <today>` (D9). `retire` deletes the
  entry (D9: wrong entries are deleted, not annotated).

## Leak check (D11)

For each item bound for the personal scope (`add` with `scope: personal`,
`edit` of a `P` entry), `leak.mjs` checks title + body against:

- **Vocabulary**, case-insensitive: the thanx scope's `VOCABULARY.md` (one
  `- term` per line) plus the proposal's `vocabulary`.
- **Patterns**: ticket/incident/doc IDs `\b[A-Z][A-Z0-9]*-\d+\b`, PR refs
  `#\d+`, `keystone:` pointers, and `http(s)://` URLs.

A failing item is **rerouted to the thanx scope**: a personal `add` becomes a
thanx `add`; a personal `edit` becomes a retirement of the `P` entry plus a
thanx `add`. The reroute and its reason appear in the diff. Samwise's own D5
judgement (in the procedure) comes first; this is a deterministic backstop
that strengthens as `VOCABULARY.md` grows.

## Diff

`propose` stores the validated proposal and prints one numbered diff covering
both files (D10), for example:

```
/reflect proposal 2026-09-27: 3 items

[1] add  personal  WORKING-WITH-GEORGE.md
  + ### Circuit breakers beat longer timeouts
  + as-of: 2026-09-27
  +
  + When a dependency degrades, fail fast behind a breaker.

[2] add  thanx  MEMORY.md  ↪ rerouted from personal: contains "Skiffline"
  + ### Skiffline carrier calls need a breaker
  ...

[3] retire  personal  WORKING-WITH-GEORGE.md  P2: George marked it wrong
  - ### Old title
  - ...

New vocabulary: Skiffline, Priya Okafor

Approve all, some (e.g. "all but 2"), or none.
```

## Apply, discard, status

- `apply [--skip 1,3 | --only 2]`: applies the approved items of the pending
  proposal, then commits and deletes the pending file.
  - Thanx scope: writes `MEMORY.md` and adds new vocabulary to
    `VOCABULARY.md` (creating it with a header if absent), then commits in the
    thanx-scope repo. The commit is made even when no thanx file changed
    (`--allow-empty`), because it records `Reflected-Through`.
  - Personal scope: writes the personal wisdom file; if it lies in a git work
    tree, commits **only that path** (`git commit -- <file>`), leaving anything
    else George has staged untouched. In evals the copy is not in a repo, so
    no commit.
  - Commit message (both repos):
    ```
    reflect: approved run YYYY-MM-DD

    Reflect-Run: <id>
    Reflected-Through: YYYY-MM-DD
    Approved-Items: 1,2
    ```
    (AC6: wisdom changes are identifiable as approved `/reflect` commits.)
  - Git identity: the repo's configured identity; if none,
    `Samwise <samwise@localhost>`.
  - With nothing approved (e.g. `--skip` of every item), behaves like
    `discard`.
- `discard`: deletes the pending proposal. No file changes, no commits.
- `status [--json]`: `{ unreflectedDays, pending }`, where `unreflectedDays`
  are daily-log dates `d` with `reflectedThrough < d < today`.
  `reflectedThrough` is the `Reflected-Through` trailer of the latest thanx-scope
  commit that has one (none → every log counts).
- `context`: prints the logs to review (dates `≥ reflectedThrough`, or all),
  then the current entries with ids, then `VOCABULARY.md`'s terms.

## Procedure (`pi/prompts/reflect.md`)

1. Run `samwise-reflect context`.
2. Decide the items: durable lessons and preferences from the logs (additions),
   corrections to stale entries (edits), and entries George has said are wrong
   (retirements). Nothing worth proposing → say so and stop.
3. Route each: personal only for general, portable lessons with no
   Thanx-specific content (D5); generalise and strip names, or route to thanx.
   List every Thanx-specific name seen in the logs as `vocabulary`.
4. Run `samwise-reflect propose` with the JSON (heredoc), show the diff
   verbatim, and ask George to approve all, some or none.
5. Do nothing else until George answers. Then `apply` (with `--skip`/`--only`
   as he said) or `discard`. Never run `apply` without explicit approval in
   his latest message.

## Nudge (`pi/extensions/reflect-nudge.ts`)

On `session_start`, only when `ctx.hasUI`: run `samwise-reflect status --json`;
if there are unreflected days or a pending proposal, and `nudged` is not today,
show one `ctx.ui.notify` ("2 unreflected days of logs: run /reflect", or "A
/reflect proposal is waiting for your approval") and write today to `nudged`.
Errors are swallowed; the nudge must never break a session.

## Eval

`eval/run.mjs` gains `reflect` in its capabilities, so the two scope-leak
`/reflect` scenarios run.

## Testing

- **Unit tests** (`node:test`, `lib/reflect/test/`): entry parsing and
  round-tripping for both files (including pi-memory-style entries and the
  WWG template's fenced example); leak check (vocabulary, patterns, reroute of
  add and edit); proposal validation errors; diff rendering; `apply` against
  temp git repos (writes, retire deletes, `as-of` stamping, vocabulary file,
  commit messages and trailers, personal path-only commit, empty thanx commit,
  identity fallback); partial apply; `discard`; `status` and
  `Reflected-Through`.
- **`test/reflect.test.sh`**: the CLI end to end in a bootstrapped temp home
  (context → propose → apply; a rejected run changes no files and makes no
  commits).
- **End to end through the eval runner**: a fixture scenario (`requires:
  [reflect]`) with a scripted stub that performs `/reflect` (context, a
  proposal with one leaky personal item, apply after "approve"). It asserts
  the template expanded, the leak was rerouted, the run's personal copy stays
  clean, and the thanx-scope commit carries the trailers.

## Refinements made while planning

1. **Leak patterns tightened** so general lessons are not blocked: IDs are
   `\b[A-Z]{2,}-\d{2,}\b` except public prefixes (AES, CVE, HTTP, IEEE, ISO,
   RFC, SHA, TLS, UTF), so `UTF-8`, `SHA-256` and `RFC-9110` pass while
   `INC-2291` does not; PR refs are `#\d{2,}`, so "rank #1" passes.
2. **The nudge logic lives in the CLI** (`samwise-reflect nudge` prints a
   reminder when one is due and records the date); the extension only calls
   it and shows the output, which keeps the logic testable without a UI.
3. `SAMWISE_REFLECT_TODAY` overrides today's date for tests.
4. `bin/samwise-reflect` sources `lib/env.sh`, so it also works from a shell.

