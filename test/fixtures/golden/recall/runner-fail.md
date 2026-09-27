---
id: runner-fail
category: recall
description: The stub answers wrongly.
prompt:
  - "RUNNER-FAIL: the zebra queue is lagging"
expect:
  response_includes: ["prefetch"]
---
Scripted fail.
