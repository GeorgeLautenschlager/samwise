# samwise

Configuration for Samwise, George's Pi agent at Thanx.

## Requirements

- Node.js ≥ 22.19 with npm
- [Pi](https://pi.dev) on `PATH`

## Install

```bash
./bootstrap.sh
```

Safe to re-run. It installs into `~/.pi/samwise` (override with `SAMWISE_HOME`)
and never touches your personal `~/.pi/agent`:

| Path | Contents |
|---|---|
| `agent/` | Pi agent dir (`PI_CODING_AGENT_DIR`); settings merged from `pi/settings.json`; `AGENTS.md` and `APPEND_SYSTEM.md` link to `pi/AGENTS.md` and `WORKING-WITH-GEORGE.md` |
| `memory/` | The thanx scope: pi-memory data, as its own local git repo (see below) |
| `tools/` | qmd, pinned |
| `qmd/` | qmd config and index for the `pi-memory` collection |

The first run downloads qmd's default local embedding model into
`~/.cache/qmd/models`. No hosted embedding API is used.

## Run

```bash
bin/samwise            # Pi with Samwise's environment (see lib/env.sh)
```

Symlink `bin/samwise` onto your `PATH` if you like; it resolves the repo
through the link.

## Memory stack

- **pi-memory**, pinned in `pi/settings.json`: long-term `MEMORY.md`, daily
  logs and scratchpad as plain markdown.
- **qmd**, pinned in `bootstrap.sh`: local keyword, semantic and hybrid search
  over the memory dir. `PI_MEMORY_SNAPSHOT=per-turn` turns on per-turn
  selective injection, at the cost of provider prompt caching.

## Scopes

Memory is split in two, and nothing Thanx-specific may enter the personal scope.

- **Personal scope**: this repo (config). `WORKING-WITH-GEORGE.md`, persona and
  general skills. Portable; pushed to this repo's private remote.
- **Thanx scope**: `~/.pi/samwise/memory`, pi-memory's data dir (state). A
  separate git repo with `MEMORY.md`, `daily/`, `SCRATCHPAD.md` and `skills/`
  for Thanx-specific skills (loaded via `pi/settings.json`). Local commits only
  until Thanx approves a remote. Stays with Thanx.

pi-memory's data dir is configurable through `PI_MEMORY_DIR`, which
`lib/env.sh` sets, so no symlink is needed. Bootstrap refuses to run if that
dir is inside this repo, and `.gitignore` ignores pi-memory's file names here.

The memory contract, `pi/AGENTS.md`, tells Samwise which layer to consult, how
to record experience and that wisdom changes only through `/reflect`. It names
no paths: memory is reached through pi-memory's tools, which run in the Pi host
process, and both wisdom files are injected. If pi-gondolin (T8) needs memory
mounted into its VM at `/memory`, only the mount changes, not the contract.

## /reflect

Wisdom files (`MEMORY.md` in the thanx scope, `WORKING-WITH-GEORGE.md` here)
change only through `/reflect`, with George's approval (D8):

1. `/reflect` (a Pi prompt template, `pi/prompts/reflect.md`) has Samwise run
   `samwise-reflect context`, then propose additions, edits and retirements as
   JSON to `samwise-reflect propose`.
2. The helper stamps `as-of` dates, reroutes any personal-bound item that
   contains Thanx vocabulary, IDs, PR refs, Keystone pointers or URLs to the
   thanx scope, and prints **one** numbered diff. Nothing is written yet.
3. George approves all, some ("all but 2") or none; Samwise runs
   `samwise-reflect apply [--skip/--only]` or `discard`.
4. `apply` writes both files and commits in each scope's repo with a
   `reflect: approved run <date>` message and `Reflect-Run`,
   `Reflected-Through` and `Approved-Items` trailers. Only
   `WORKING-WITH-GEORGE.md` is committed here, so other staged work is left
   alone. New Thanx names go into the thanx scope's `VOCABULARY.md`.

A session-start nudge (`pi/extensions/reflect-nudge.ts`) reminds George at
most once a day when logs are unreflected or a proposal is waiting.
`bin/samwise-reflect status` shows the same from a shell.

## Test

```bash
test/run.sh                      # everything (bootstrap test needs network, ~2 min)
SKIP_INTEGRATION=1 test/run.sh   # fast unit tests only
```
