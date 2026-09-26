# T3: Memory contract — design

**Issue:** #4 (part of epic #1, Samwise Memory). **Covers:** D5, D6, D7, D8.
**Status:** Approved 2026-09-26.

## Goal

A short, imperative memory contract that Samwise loads every session: which
layer to consult for which question, the Keystone pointer rule, scope rules,
the daily-log entry format and the wisdom write rule. Wire it, and the
personal-scope wisdom file, into Samwise's context.

## Wiring

- The contract lives at `pi/AGENTS.md` in the config repo (a persona section
  may join it later).
- Bootstrap creates two symlinks in the agent dir (`$PI_CODING_AGENT_DIR`):
  - `AGENTS.md` → `<repo>/pi/AGENTS.md` (Pi loads `<agent-dir>/AGENTS.md` as
    instructions applied in every working directory)
  - `APPEND_SYSTEM.md` → `<repo>/WORKING-WITH-GEORGE.md` (Pi appends
    `<agent-dir>/APPEND_SYSTEM.md` to its system prompt)
- Symlinks, not copies: Pi never writes these files, and edits (including
  approved `/reflect` changes) apply to the next session without re-running
  bootstrap.
- Idempotent: an existing symlink with the right target is left alone. A
  symlink pointing elsewhere (e.g. stale after the repo checkout moved) holds
  no content and is repointed, so no manual edit under `~/.pi/` is needed
  (D16). If either path exists as a regular file or directory, bootstrap fails
  with a clear message rather than overwrite it.

With this, both wisdom files are always in context: `MEMORY.md` via pi-memory's
injection, `WORKING-WITH-GEORGE.md` via `APPEND_SYSTEM.md`.

## Paths (issue item 6)

The contract contains **no filesystem paths**. Memory is reached only through
pi-memory's `memory_*` and `scratchpad` tools, which run in the Pi host process,
and both wisdom files are injected. pi-gondolin (T8) redirects the model's own
file tools, so it cannot invalidate the contract. The note that T8 may add a
`/memory` mount goes in the README's "Scopes" section instead of the contract,
so it costs no tokens per session.

## Contract text (`pi/AGENTS.md`)

````markdown
# Memory

You have durable memory of work with George. Use it without being reminded.

## Where to look

| Question | Source |
|---|---|
| Thanx facts: systems, people, docs, processes | Keystone (MCP), live |
| Seen this before? Past problems | Experience: `memory_search` |
| Lessons, judgement calls, George's preferences | Wisdom: `MEMORY.md` (thanx), `WORKING-WITH-GEORGE.md` (personal), both already in context |
| Procedures, how-tos | Skills |

- Before a non-trivial problem, `memory_search` for similar past ones and say what you found.
- When memory and Keystone disagree on a fact, Keystone wins. Say so.
- Use only the `memory_*` and `scratchpad` tools for memory; never file tools.

## Keystone pointers

Store a pointer, not content: `keystone:<id or URL> — <one line on why it mattered>`.
Never copy more than one line of Keystone content into memory.

## Scopes

- Thanx scope: everything the memory tools write. Thanx-specific content lives only here.
- Personal scope: `WORKING-WITH-GEORGE.md`. Never Thanx-specific: no internal system
  names, customers, people, incidents, code or metrics. When unsure, it's Thanx-specific.

## Recording experience

When you finish solving a problem, append one entry with `memory_write` (target `daily`):

```
#problem [[short-slug]] <the problem, one line>
- Tried: <what didn't work, and why>
- Worked: <what fixed it>
- Pointers: <PRs, tickets, keystone:<id> — why it mattered>
```

One entry per solved problem.

## Wisdom

Never write wisdom yourself: no `memory_write` with target `long_term`, no edits to
`WORKING-WITH-GEORGE.md`. Propose lessons at `/reflect`; only apply changes George approved there.
````

Notes:

- The **Wisdom** section resolves the D8 conflict: pi-memory's `memory_write`
  with `target: long_term` writes `MEMORY.md` directly.
- The **daily-log entry** (D7) is the fixed shape the T5 golden set seeds
  fixtures in. pi-memory prefixes each entry with its own
  `<!-- YYYY-MM-DD HH:MM:SS [session] -->` line; fixtures include that line too.
  `#problem` and `[[slug]]` give qmd keyword search something stable to match.

## Testing

**`test/contract.test.sh`** (fast), against `pi/AGENTS.md`:

- Routing: the four rows (`Keystone (MCP)`, `memory_search`,
  `WORKING-WITH-GEORGE.md`, `Skills`) and `Keystone wins`.
- Pointer rule: `keystone:<id or URL>` and `more than one line`.
- Scope rule: `internal system`, `customers`, `people`, `incidents`, `code`,
  `metrics`, and `When unsure`.
- Daily-log template: `#problem [[`, `- Tried:`, `- Worked:`, `- Pointers:`,
  and `target \`daily\``.
- Wisdom rule: `long_term` and `/reflect`.
- No paths: none of `~/`, `/memory`, `.pi/`, `$HOME`.
- Size budget: at most 4,000 bytes.

**`test/bootstrap.test.sh`** gains:

- `agent/AGENTS.md` and `agent/APPEND_SYSTEM.md` are symlinks resolving to
  `<repo>/pi/AGENTS.md` and `<repo>/WORKING-WITH-GEORGE.md`.
- A re-run repoints a stale `APPEND_SYSTEM.md` symlink (planted before the
  re-run) and leaves both links correct.
- With a regular file at `agent/AGENTS.md`, bootstrap fails and leaves the
  file intact (run against a separate temp `SAMWISE_HOME`).
- End-to-end: the stub's recorded requests contain `Keystone wins` (contract)
  and `# Working with George` (personal wisdom).
