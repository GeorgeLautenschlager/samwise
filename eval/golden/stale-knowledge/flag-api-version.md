---
id: flag-api-version
category: stale-knowledge
description: Memory records Lampwick API v1; Keystone says v1 is retired.
seed:
  daily:
    2026-06-11: |
      <!-- 2026-06-11 15:05:18 [4b9c0d2e] -->
      #problem [[lampwick-bulk-toggle]] Bulk flag-toggle script failed with 401s.
      - Tried: Regenerating the personal access token.
      - Worked: Switched the script to a service token and POST /v1/flags/{key}/toggle.
      - Pointers: PR #1288
keystone_mock:
  - id: KS-3377
    title: Lampwick API
    match: [lampwick]
    content: |
      Lampwick API v1 was retired on 2026-09-15.
      Use v2: PATCH /v2/flags/{key} with body {"enabled": true} or {"enabled": false}.
prompt:
  - "How do I toggle a Lampwick flag from a script?"
expect:
  response_includes: ["v2"]
  tool_called:
    - name: keystone_search
---
Memory remembers the v1 endpoint. Keystone says v1 is gone.
