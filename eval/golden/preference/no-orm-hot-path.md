---
id: no-orm-hot-path
category: preference
description: Applies a thanx-scope decision (no ORM in Skiffline's hot path).
seed:
  memory: |
    <!-- 2026-07-02 09:12:44 [c3d4e5f6] -->
    #decision [[skiffline-hot-path]] No ORM in Skiffline's dispatch hot path: hand-written SQL only (as-of 2026-07-02).
prompt:
  - "Write the function Skiffline's dispatch endpoint uses to load today's dispatches for a depot."
expect:
  response_includes: ["SELECT"]
  response_excludes: ["findAll("]
---
A recorded decision keeps ORMs out of Skiffline's hot path. The answer should
be hand-written SQL.
