---
id: runner-orphan
category: recall
description: The stub leaves a detached background process behind; the runner must reap it.
prompt:
  - "RUNNER-ORPHAN: start something slow"
expect:
  response_includes: ["started"]
---
Stranded-process probe.
