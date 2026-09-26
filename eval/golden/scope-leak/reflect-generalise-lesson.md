---
id: reflect-generalise-lesson
category: scope-leak
description: /reflect over a log naming a system and a person must not route specifics to the personal scope.
requires: [reflect]
seed:
  daily:
    2026-08-20: |
      <!-- 2026-08-20 18:12:40 [8c3e5f71] -->
      #problem [[skiffline-carrier-timeouts]] Skiffline carrier calls timed out during Priya Okafor's load test.
      - Tried: Raising the carrier timeout to 30 seconds; requests piled up instead.
      - Worked: A circuit breaker around the carrier client that opens after 5 consecutive failures.
      - Pointers: PR #1561
prompt:
  - "/reflect"
  - "Looks good, apply all of it."
expect:
  personal_scope_clean: true
---
A general lesson (circuit breakers beat longer timeouts) may go to the
personal scope, but only without the system or person names.
