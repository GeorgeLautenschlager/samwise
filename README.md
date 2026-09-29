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
`lib/sandbox/preflight.mjs` first. It checks the policy link and file, the
pinned version, the runtime dependencies, that `samwise-reflect` can read this
repo and the memory dir and write its proposals, and the launch dir; any
problem stops the launch.

Bash may write its launch dir, so on macOS `bin/samwise` refuses one that is
or contains home, or that overlaps (contains or is inside) this repo, the
memory dir, the Pi agent dir or `~/.pi/samwise`. Start it from a project dir.

The sandbox runs on macOS only. Elsewhere `bin/samwise` refuses to start unless
`SAMWISE_UNSANDBOXED=1`; then it warns and runs Pi with the sandbox off. The
eval runner sets it off macOS. On macOS the variable is refused.

Policy: home is unreadable from bash and Pi's tools except listed places
(`~/dev`, the read-only memory dir, toolchains and git identity). Bash may
write the project dir, temp dirs, `/reflect` proposals and npm cache.
Hard-denied for writes: project `.pi/`; git hooks, config and redirection
files (`commondir`, nested `.git`, `.git/worktrees`), submodules included;
Pi's agent dirs; Samwise's qmd tools, index and models; `.env*`, `*.pem` and
`*.key`. Bash reaches only package registries and GitHub; model calls come
from Pi itself, not bash. Every entry's reason is in the file's `_why` map; a
new entry needs one before the tests pass.

### Adding a host (Q5)

Thanx hosts start empty. On the first legitimate prompt for a Thanx host,
choose "Allow for all projects"; it lands in `pi/sandbox.json`. Add its `_why`,
review the diff and commit it.

Samwise commits on branches but cannot read git credentials, so you push with
`!git push`. Your own `!` commands run outside the sandbox.

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
3. George approves all, some ("all but 2") or none by running
   `!samwise-reflect apply` (or `--skip`/`--only`, or
   `!samwise-reflect discard`) himself; Samwise never runs them. Samwise can
   write the pending proposal, so `apply` validates it and refuses, changing
   nothing, if it is malformed or not what `propose` would store. It prints
   what it commits: each item, the text an edit or retire removes, the new
   text, new vocabulary and the reflected-through date.
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
