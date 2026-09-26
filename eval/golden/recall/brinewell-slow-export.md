---
id: brinewell-slow-export
category: recall
description: A slow Brinewell report query resembles an export fixed with a partial index.
seed:
  daily:
    2026-05-12: |
      <!-- 2026-05-12 14:03:27 [c41f8a90] -->
      #problem [[brinewell-export-timeout]] Brinewell delivered-shipments export timed out after 30 seconds.
      - Tried: Raising the statement timeout to 120 seconds; the export finished but locked the replica for minutes.
      - Worked: Added a partial index on shipments(shipped_at) WHERE status = 'delivered'; the export runs in 2 seconds.
      - Pointers: PR #1204
prompt:
  - "The weekly on-time report query in Brinewell went from 3 seconds to over a minute. It filters delivered shipments by shipped_at. Ideas?"
expect:
  response_includes: ["partial index", "1204"]
---
The same access pattern was fixed in May with a partial index (PR #1204).
