---
id: skiffline-timeout-retry
category: recall
description: Duplicate dispatches resemble a retry bug fixed with idempotency keys.
seed:
  daily:
    2026-06-30: |
      <!-- 2026-06-30 11:20:45 [7b2e9d01] -->
      #problem [[skiffline-duplicate-dispatch]] Skiffline created duplicate dispatches when the carrier gateway returned 504s.
      - Tried: Lowering the retry count to 1; duplicates still happened on the first retry.
      - Worked: Retry carrier calls only with an Idempotency-Key header derived from the dispatch id, so the carrier dedupes them.
      - Pointers: PR #1391, INC-2307
prompt:
  - "Some shipments are being dispatched twice when the carrier API is slow. Skiffline's logs show two POSTs a few seconds apart. How should we fix it?"
expect:
  response_includes: ["idempotency", "1391"]
---
The same failure mode was fixed in June with idempotency keys (PR #1391).
Samwise should connect the new symptom to that fix.
