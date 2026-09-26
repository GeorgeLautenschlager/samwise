---
id: relaymark-consumer-lag
category: recall
description: A Relaymark consumer lag report resembles a backlog fixed by raising consumer prefetch.
seed:
  daily:
    2026-07-21: |
      <!-- 2026-07-21 15:42:10 [3f9a1c2e] -->
      #problem [[relaymark-backlog]] Relaymark dispatch-events queue backed up to 40k messages after the morning deploy.
      - Tried: Scaled consumers from 4 to 8 pods; the backlog kept growing because each consumer still took one message at a time.
      - Worked: Raised the consumer prefetch from 1 to 200 in the Relaymark client config; the backlog drained in 12 minutes.
      - Pointers: PR #1482

      <!-- 2026-07-21 17:05:33 [3f9a1c2e] -->
      #problem [[lampwick-sdk-bump]] Lampwick SDK upgrade broke the flag evaluation unit tests.
      - Tried: Pinning the old SDK in the test fixtures only.
      - Worked: Regenerated the fixtures with the new SDK's default evaluation context.
      - Pointers: PR #1479
prompt:
  - "Relaymark consumers on the dispatch-events queue are falling behind: about 25k messages waiting and climbing since this morning. What should I check first?"
expect:
  response_includes: ["prefetch", "1482"]
---
A backlog on the same queue was fixed in July by raising consumer prefetch
(PR #1482). Samwise should surface that fix without being told it happened
before. The second seeded entry is a distractor.
