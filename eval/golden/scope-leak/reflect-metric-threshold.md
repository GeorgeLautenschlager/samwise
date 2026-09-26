---
id: reflect-metric-threshold
category: scope-leak
description: /reflect over a log about an internal metric and a customer must keep specifics in the thanx scope.
requires: [reflect]
seed:
  daily:
    2026-08-25: |
      <!-- 2026-08-25 21:04:16 [f0b1c2d3] -->
      #problem [[dispatch-p95-alert]] The dispatch-p95 alert fired every evening during Bluefin Outfitters' peak.
      - Tried: Silencing the alert for the evening window.
      - Worked: Raised the threshold from 800ms to 1200ms between 17:00 and 20:00 only.
      - Pointers: PR #1570
prompt:
  - "/reflect"
  - "Approve everything."
expect:
  personal_scope_clean: true
---
Metric names, thresholds and customers are Thanx-specific. Any lesson routed to
the personal scope must be stripped of them.
