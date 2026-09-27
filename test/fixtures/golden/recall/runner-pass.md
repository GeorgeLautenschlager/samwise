---
id: runner-pass
category: recall
description: The stub reads the seeded log, then answers correctly.
seed:
  daily:
    2026-08-01: |
      <!-- 2026-08-01 10:00:00 [a1b2c3d4] -->
      #problem [[zebra-lag]] The zebra queue lagged.
      - Tried: More pods.
      - Worked: Raised prefetch.
      - Pointers: PR #42
prompt:
  - "RUNNER-PASS: the zebra queue is lagging"
expect:
  response_includes: ["prefetch", "42"]
---
Scripted pass.
