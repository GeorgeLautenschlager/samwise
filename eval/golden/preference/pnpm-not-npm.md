---
id: pnpm-not-npm
category: preference
description: Applies the seeded pnpm preference when adding a dependency.
seed:
  personal: |
    ### Package manager
    as-of: 2026-07-10

    Always use pnpm, never npm, in JavaScript projects.
prompt:
  - "Add zod as a dependency in this repo."
expect:
  tool_called:
    - name: bash
      args_include: { command: "pnpm add" }
---
The personal scope says pnpm, always. Samwise should run `pnpm add zod`
without being reminded.
