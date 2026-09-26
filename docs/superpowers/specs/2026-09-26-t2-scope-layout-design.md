# T2: Scope layout — design

**Issue:** #3 (part of epic #1, Samwise Memory). **Covers:** D3, D4, D5, D12, Q1, Q4, Q7.
**Status:** Approved 2026-09-26.

## Goal

Make pi-memory's data directory the **thanx scope**: a local-only git repo,
separate from the config repo, with a skeleton for wisdom, daily logs,
scratchpad and Thanx-specific skills. Add the **personal scope** wisdom file,
`WORKING-WITH-GEORGE.md`, to the config repo as a template. Make it hard for
thanx-scope content to end up in the config repo.

## Q1 (resolved in T1)

pi-memory reads `PI_MEMORY_DIR` (`resolveMemoryDir()` in pi-memory 0.4.2's
`index.ts`), which `lib/env.sh` sets. No symlink is needed. Documented in the
README's "Scopes" section and on the issue (`DECISIONS.md` arrives in T7).

## Thanx scope (state)

**Location:** `$SAMWISE_HOME/memory` (default `~/.pi/samwise/memory`), i.e. the
existing `PI_MEMORY_DIR`. It is outside the config repo, and T1's qmd
`pi-memory` collection already indexes it.

**Skeleton:**

| Path | Content |
|---|---|
| `MEMORY.md` | Two-line header (it is injected every turn, so it stays short) |
| `SCRATCHPAD.md` | `# Scratchpad` followed by a blank line (pi-memory's own header; it preserves unknown lines) |
| `daily/.gitkeep` | empty |
| `skills/.gitkeep` | empty |

**New bootstrap step, "Setting up thanx scope"**, after "Creating
$SAMWISE_HOME":

1. **Guard (D5).** Resolve `PI_MEMORY_DIR` and the config repo to physical
   paths; if the memory dir is the repo or inside it, fail with a clear message.
2. If `$PI_MEMORY_DIR/.git` exists, do nothing more (re-runs are no-ops).
3. Otherwise: `git init`; create each skeleton file only if absent (existing
   memory, e.g. daily logs from before T2, is never overwritten and goes into
   the first commit); `git add -A`; commit as `Samwise <samwise@localhost>`
   (works on a clean account with no git identity) with message
   `Initialize thanx scope`.
4. No remote is ever added (D12, Q4). A remote is added by hand once Thanx
   approves one.

**Skills wiring:** `pi/settings.json` gains `"skills": ["../memory/skills"]`.
Pi resolves resource paths in user settings from the agent dir
(`$SAMWISE_HOME/agent`), so this loads the thanx-scope `skills/`.

**Out of scope:** automatic commits of daily logs and scratchpad changes (T2
only makes the repo; `/reflect` in T4 commits wisdom). qmd also indexes
`skills/**/*.md`; left as is unless the T7 bake-off shows it is noise.

## Personal scope (config)

The config repo and its existing private remote (Q7); nothing new to configure.

**`WORKING-WITH-GEORGE.md`** at the repo root, template only:

- What belongs here: how George and Samwise work together (preferences,
  working style, general engineering judgement). Portable. Never
  Thanx-specific: no internal systems, customers, people, incidents, code or
  metrics (D5). When unsure, it belongs in the thanx scope.
- Rules: entries are added, edited and retired only through `/reflect` with
  George's approval (D8); every entry carries an `as-of` date; entries George
  marks wrong are deleted, not annotated (D9).
- Entry format, inside a fenced code block so `/reflect` never parses the
  example as an entry:

  ```
  ### <Short title>
  as-of: YYYY-MM-DD

  <The lesson or preference, and when it applies.>
  ```
- An empty `## Entries` section.

**`.gitignore` (D5 belt and braces):** a block that ignores pi-memory's file
names anywhere in the config repo: `MEMORY.md`, `SCRATCHPAD.md`, `daily/`,
`recovery/`.

## Testing

**`test/bootstrap.test.sh`** (clean-`HOME` integration test) gains:

1. The thanx-scope dir is a git repo with no remote, with `MEMORY.md`,
   `SCRATCHPAD.md`, `daily/.gitkeep` and `skills/.gitkeep` committed, and a
   clean working tree.
2. A second bootstrap run leaves the thanx-scope HEAD unchanged.
3. With `SAMWISE_HOME` inside the config repo, bootstrap exits non-zero and
   names the problem.
4. **End-to-end write.** Start `test/fixtures/stub-llm.mjs`, a local
   OpenAI-compatible streaming stub that answers the first request with a
   `memory_write` (target `daily`) tool call and the next with `done`. Write a
   `models.json` for it into the temp agent dir, seed
   `memory/skills/probe/SKILL.md`, then run the real
   `bin/samwise -p --model stub/stub-model` (stdin closed, `PI_OFFLINE=1`,
   `PI_MEMORY_EXIT_SUMMARY=0`). Assert:
   - the note is in `memory/daily/*.md` and `git status` of the thanx-scope
     repo shows `daily/` changed;
   - `git status --porcelain` of the config repo is unchanged;
   - the stub's recorded request contains the probe skill's name (skills are
     wired).

**`test/scopes.test.sh`** (fast):

- `WORKING-WITH-GEORGE.md` contains the scope rule, the `/reflect` rule, the
  `as-of: YYYY-MM-DD` format line and `## Entries`.
- `git check-ignore` matches `MEMORY.md`, `SCRATCHPAD.md`, `daily/x.md`,
  `recovery/x.json` and `sub/daily/x.md`, and does not match
  `WORKING-WITH-GEORGE.md`.
