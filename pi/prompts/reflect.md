---
description: Consolidate recent experience into wisdom (one batched diff for George to approve)
---
Run /reflect: turn recent experience into wisdom proposals for George to approve. Follow these steps exactly.

1. Run `samwise-reflect context`. It prints the daily logs to review, the current wisdom entries with ids (`T…` in the thanx scope's MEMORY.md, `P…` in the personal scope's WORKING-WITH-GEORGE.md) and the known Thanx vocabulary.
2. Decide what to propose:
   - add: durable lessons, judgement calls and preferences the logs support;
   - edit: entries the logs show are stale (target them by id);
   - retire: entries George has said are wrong (they are deleted, not annotated).
   If nothing is worth proposing, say so and stop.
3. Route each addition. Personal scope only for general, portable lessons with no Thanx-specific content: no internal system names, customers, people, incidents, code, metrics, ticket IDs, PR numbers, Keystone pointers or internal URLs. Generalise and strip the names, or route it to thanx. When unsure, thanx. List every Thanx-specific name you saw in the logs as `vocabulary`.
4. Run:

   ```
   samwise-reflect propose <<'JSON'
   {"items": [
     {"op": "add", "scope": "personal", "title": "...", "body": "..."},
     {"op": "edit", "target": "T1", "title": "...", "body": "..."},
     {"op": "retire", "target": "P2", "reason": "..."}
   ], "vocabulary": ["..."]}
   JSON
   ```

   Show George the printed diff verbatim.
5. Ask George to approve all, some or none by running one of these himself in Pi (`!` runs his command outside the sandbox), then stop and wait:
   - `!samwise-reflect apply` when he approves everything;
   - `!samwise-reflect apply --skip 2,3` or `!samwise-reflect apply --only 1` when he approves some;
   - `!samwise-reflect discard` when he approves nothing.

Never run `apply` or `discard` yourself: they are George's approval. (`apply` would fail anyway: the wisdom files are outside what you may write.) Never change the wisdom files any other way.
