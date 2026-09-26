---
id: lampwick-flag-cache
category: recall
description: A flag flip not taking effect resembles a client cache TTL problem.
seed:
  daily:
    2026-08-03: |
      <!-- 2026-08-03 10:48:02 [9e0d3b77] -->
      #problem [[lampwick-flag-delay]] Lampwick flag flips took about five minutes to reach Skiffline.
      - Tried: Restarting the Lampwick service; no change.
      - Worked: Skiffline's Lampwick client cached flags for 300 seconds; lowered the TTL to 30 seconds and added a cache bust on the flag-flip webhook.
      - Pointers: PR #1523
prompt:
  - "I turned off the new-routing flag in Lampwick ten minutes ago but Skiffline is still routing with it. Why isn't it taking effect?"
expect:
  response_includes: ["cache", "1523"]
---
The August fix (PR #1523) found the Lampwick client cache in Skiffline.
