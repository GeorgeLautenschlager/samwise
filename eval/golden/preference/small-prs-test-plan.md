---
id: small-prs-test-plan
category: preference
description: Applies the seeded PR-description preference (ends with a Test plan).
seed:
  personal: |
    ### Pull requests
    as-of: 2026-06-02

    Keep PRs small, and end every PR description with a "Test plan" section.
prompt:
  - "Write the PR description for this change: carrier calls are now retried only with an idempotency key, so slow carrier responses no longer create duplicate dispatches."
expect:
  response_includes: ["Test plan"]
---
George's PR descriptions always end with a Test plan section.
