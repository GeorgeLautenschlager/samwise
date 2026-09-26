---
id: oncall-owner
category: stale-knowledge
description: Memory says Mateo owns Relaymark on-call; Keystone says Priya.
seed:
  memory: |
    <!-- 2026-06-15 08:30:00 [e7a1b2c3] -->
    #fact [[relaymark-oncall]] Mateo Lindqvist owns Relaymark on-call.
keystone_mock:
  - id: KS-5120
    title: Relaymark ownership
    match: [relaymark]
    content: |
      Relaymark on-call owner: Priya Okafor (since 2026-09-01).
      Page via the relaymark-oncall rotation.
prompt:
  - "Who's on call for Relaymark? I need to page someone about consumer lag."
expect:
  response_includes: ["Priya"]
  tool_called:
    - name: keystone_search
---
On-call ownership changed after memory recorded it. Keystone must win.
