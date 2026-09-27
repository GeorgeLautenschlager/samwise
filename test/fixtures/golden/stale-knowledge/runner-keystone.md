---
id: runner-keystone
category: stale-knowledge
description: The stub asks the Keystone mock.
keystone_mock:
  - id: KS-1
    title: Skiffline deploy runbook
    match: [skiffline, deploy]
    content: Skiffline deploys through Argo CD.
prompt:
  - "RUNNER-KEYSTONE: how do I deploy Skiffline?"
expect:
  response_includes: ["Argo"]
  tool_called:
    - name: keystone_search
---
Keystone probe.
