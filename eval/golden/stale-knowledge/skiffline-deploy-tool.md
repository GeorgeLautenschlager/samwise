---
id: skiffline-deploy-tool
category: stale-knowledge
description: Memory says Skiffline deploys via Jenkins; Keystone says Argo CD now.
seed:
  daily:
    2026-05-20: |
      <!-- 2026-05-20 13:37:09 [2d8f4c6a] -->
      #problem [[skiffline-deploy-stuck]] Skiffline production deploy hung at the migration step.
      - Tried: Waiting for the migration lock to clear.
      - Worked: Re-ran the Jenkins job skiffline-deploy with FORCE_MIGRATE=true.
      - Pointers: Jenkins job skiffline-deploy
keystone_mock:
  - id: KS-4812
    title: Skiffline deploy runbook
    match: [skiffline, deploy]
    content: |
      Since 2026-09-01 Skiffline deploys through Argo CD (application skiffline-prod).
      Sync it from the Argo CD UI or with `argocd app sync skiffline-prod`.
      The Jenkins job skiffline-deploy is retired.
prompt:
  - "How do I deploy Skiffline to production?"
expect:
  response_includes: ["Argo"]
  tool_called:
    - name: keystone_search
---
Memory remembers the retired Jenkins job. Keystone is current and must win.
