# samwise

Configuration for Samwise, George's Pi agent at Thanx.

## Requirements

- Node.js ≥ 22.19 with npm
- [Pi](https://pi.dev) on `PATH`
- macOS for the sandbox (Seatbelt); bootstrap installs its ripgrep dependency
  with Homebrew if missing. Elsewhere Samwise runs only unfenced, on request
  (see [Sandbox](#sandbox)).

## Install

```bash
./bootstrap.sh
```

Safe to re-run. It installs into `~/.pi/samwise` (override with `SAMWISE_HOME`)
and never touches your personal `~/.pi/agent`:

| Path | Contents |
|---|---|
| `agent/` | Pi agent dir (`PI_CODING_AGENT_DIR`); settings merged from `pi/settings.json`; `AGENTS.md` and `APPEND_SYSTEM.md` link to `pi/AGENTS.md` and `WORKING-WITH-GEORGE.md`; `sandbox.json` links to `pi/sandbox.json` |
| `memory/` | The thanx scope: pi-memory data, as its own local git repo (see below) |
| `tools/` | qmd, pinned |
| `qmd/` | qmd config and index for the `pi-memory` collection |

The first run downloads qmd's three local models (embedding, re-ranking and
query expansion, about 2.1 GB) into `~/.cache/qmd/models`, so a running Samwise
never needs HuggingFace. No hosted embedding API is used.

## Run

```bash
bin/samwise            # Pi with Samwise's environment (see lib/env.sh)
```

Symlink `bin/samwise` onto your `PATH` if you like; it resolves the repo
through the link.

## Sandbox

The fence is [pi-sandbox](https://github.com/carderne/pi-sandbox), pinned in
`pi/settings.json`. It wraps bash in macOS Seatbelt and checks Pi's read, write
and edit tools against `pi/sandbox.json`.

Policy lives in this repo: `~/.pi/samwise/agent/sandbox.json` links to
`pi/sandbox.json`, so "Allow for all projects" at a prompt edits this repo.
Bootstrap reports uncommitted policy changes; commit or revert them. A
project-local `.pi/sandbox.json` is not allowed: on macOS `bin/samwise` refuses
to start and says to move its entries here.

The fence must never run silently off, and pi-sandbox fails open, so
`bin/samwise` refuses `--no-sandbox` and on macOS runs
`lib/sandbox/preflight.mjs` first to check the policy link and file, the pinned
version and the runtime dependencies; any problem stops the launch.

The sandbox runs on macOS only. Elsewhere `bin/samwise` refuses to start unless
`SAMWISE_UNSANDBOXED=1`; then it warns and runs Pi with the sandbox off. The
eval runner sets it off macOS. On macOS the variable is refused.

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
