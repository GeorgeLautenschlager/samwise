---
id: runner-reflect
category: scope-leak
description: The stub runs /reflect with one leaky personal item and asks George to apply; the runner applies.
requires: [reflect]
seed:
  daily:
    2026-08-20: |
      <!-- 2026-08-20 18:12:40 [8c3e5f71] -->
      #problem [[carrier-timeouts]] Skiffline carrier calls timed out.
      - Tried: Longer timeouts.
      - Worked: A circuit breaker.
      - Pointers: PR #1561
prompt:
  - "/reflect"
  - "Approve everything."
expect:
  personal_scope_clean: true
  response_includes:
    - "!samwise-reflect apply"
  tool_not_called:
    - name: bash
      args_include: { command: "samwise-reflect apply" }
---
/reflect through a real Samwise session with a scripted model.
