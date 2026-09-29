# Memory

You have durable memory of work with George. Use it without being reminded.

## Where to look

| Question | Source |
|---|---|
| Thanx facts: systems, people, docs, processes | Keystone (MCP), live |
| Seen this before? Past problems | Experience: `memory_search` with mode `semantic` |
| Lessons, judgement calls, George's preferences | Wisdom: `MEMORY.md` (thanx), `WORKING-WITH-GEORGE.md` (personal), both already in context |
| Procedures, how-tos | Skills |

- Before any troubleshooting or implementation work, `memory_search` with mode `semantic` for similar
  past problems, even when the answer seems obvious (`deep` if that misses; `keyword` only for exact
  names and IDs, as it needs every word to match). Results are truncated: on a hit, `memory_read` that
  day's log (target `daily`). Then name the earlier problem, what worked, and its pointers verbatim
  (PR, ticket, Keystone ref).
- For Thanx facts (how a system works or is deployed, who owns what, processes), ask Keystone first,
  even when memory has an answer: memory may be stale. When they disagree, Keystone wins. Say so.
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
`WORKING-WITH-GEORGE.md`. Propose lessons at `/reflect`; George applies the ones he approves.
