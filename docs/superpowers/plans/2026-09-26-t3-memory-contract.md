# T3: Memory Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use steward:steward-local-sdd (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Write Samwise's memory contract (`pi/AGENTS.md`) and wire it, plus `WORKING-WITH-GEORGE.md`, into every Samwise session via symlinks in the agent dir.

**Architecture:** The contract is a short markdown file checked by a fast phrase/size test. `bootstrap.sh` gains a "Linking Samwise context files" step that symlinks `<agent-dir>/AGENTS.md` and `<agent-dir>/APPEND_SYSTEM.md` to the repo files (repointing stale symlinks, refusing to replace real files). The existing end-to-end stub test confirms both reach the system prompt.

**Tech Stack:** Bash, Markdown, Pi context files (`AGENTS.md`, `APPEND_SYSTEM.md`).

**Spec:** `docs/superpowers/specs/2026-09-26-t3-memory-contract-design.md`

## Verified facts (checked 2026-09-26; do not re-derive)

- Pi loads `<agent-dir>/AGENTS.md` and `<agent-dir>/APPEND_SYSTEM.md` when they are **symlinks**; their contents appear in the system prompt of every request the stub LLM (`test/fixtures/stub-llm.mjs`) records.
- `test/bootstrap.test.sh` computes `REPO` as `cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd` and runs `"$REPO/bootstrap.sh"`; `bootstrap.sh` computes `repo` as `cd "$(dirname "${BASH_SOURCE[0]}")" && pwd`. Both yield the same string, so `readlink` results can be compared to `$REPO/...` exactly.
- Current `test/bootstrap.test.sh` has 27 assertions; its anchor lines used below exist exactly once.

## File structure

| File | Change |
|---|---|
| `pi/AGENTS.md` | Create: the memory contract |
| `test/contract.test.sh` | Create: phrase, no-path and size checks |
| `bootstrap.sh` | Modify: symlink step |
| `test/bootstrap.test.sh` | Modify: symlink, refusal, stale-repoint and end-to-end assertions |
| `README.md` | Modify: agent-dir row, contract + T8 note |

---

### Task 1: The contract and its test

**Files:**
- Create: `test/contract.test.sh`
- Create: `pi/AGENTS.md`

- [ ] **Step 1: Write the failing test**

Create `test/contract.test.sh`:

```bash
#!/usr/bin/env bash
# Checks the memory contract (pi/AGENTS.md) covers issue #4 items 1-6, has no
# filesystem paths, and stays within its size budget (it loads every session).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO/test/lib.sh"

contract="$REPO/pi/AGENTS.md"
c="$(cat "$contract")"

# 1. Layer routing and precedence
for phrase in "Keystone (MCP)" "memory_search" "WORKING-WITH-GEORGE.md" "Skills" "Keystone wins"; do
  assert_contains "$c" "$phrase" "routing: $phrase"
done

# 2. Keystone pointer rule (D6)
for phrase in "keystone:<id or URL>" "more than one line"; do
  assert_contains "$c" "$phrase" "pointer rule: $phrase"
done

# 3. Scope rules (D5)
for phrase in "internal system" "customers" "people" "incidents" "code" "metrics" "When unsure"; do
  assert_contains "$c" "$phrase" "scope rule: $phrase"
done

# 4. Daily-log entry format (D7)
for phrase in "#problem [[" "- Tried:" "- Worked:" "- Pointers:" 'target `daily`'; do
  assert_contains "$c" "$phrase" "daily-log template: $phrase"
done

# 5. Wisdom write rule (D8)
for phrase in "long_term" "/reflect"; do
  assert_contains "$c" "$phrase" "wisdom rule: $phrase"
done

# 6. No filesystem paths: memory is reached through tools, so gondolin (T8) can't break it
for path in "~/" "/memory" ".pi/" '$HOME'; do
  assert_not_contains "$c" "$path" "no path: $path"
done

size="$(wc -c <"$contract")"
(( size <= 4000 )) || fail "contract is $size bytes; budget is 4000"
pass "contract within the 4000-byte budget ($((size)) bytes)"
```

Then `chmod +x test/contract.test.sh`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bash test/contract.test.sh`
Expected: exits non-zero; `cat` reports `pi/AGENTS.md: No such file or directory`.

- [ ] **Step 3: Write `pi/AGENTS.md`**

The file content is exactly the following (between the outer four-backtick fence):

````markdown
# Memory

You have durable memory of work with George. Use it without being reminded.

## Where to look

| Question | Source |
|---|---|
| Thanx facts: systems, people, docs, processes | Keystone (MCP), live |
| Seen this before? Past problems | Experience: `memory_search` |
| Lessons, judgement calls, George's preferences | Wisdom: `MEMORY.md` (thanx), `WORKING-WITH-GEORGE.md` (personal), both already in context |
| Procedures, how-tos | Skills |

- Before a non-trivial problem, `memory_search` for similar past ones and say what you found.
- When memory and Keystone disagree on a fact, Keystone wins. Say so.
- Use only the `memory_*` and `scratchpad` tools for memory; never file tools.

## Keystone pointers

Store a pointer, not content: `keystone:<id or URL> — <one line on why it mattered>`.
Never copy more than one line of Keystone content into memory.

## Scopes

- Thanx scope: everything the memory tools write. Thanx-specific content lives only here.
- Personal scope: `WORKING-WITH-GEORGE.md`. Never Thanx-specific: no internal system
  names, customers, people, incidents, code or metrics. When unsure, it's Thanx-specific.

## Recording experience

When you finish solving a problem, append one entry with `memory_write` (target `daily`):

```
#problem [[short-slug]] <the problem, one line>
- Tried: <what didn't work, and why>
- Worked: <what fixed it>
- Pointers: <PRs, tickets, keystone:<id> — why it mattered>
```

One entry per solved problem.

## Wisdom

Never write wisdom yourself: no `memory_write` with target `long_term`, no edits to
`WORKING-WITH-GEORGE.md`. Propose lessons at `/reflect`; only apply changes George approved there.
````

- [ ] **Step 4: Run test to verify it passes**

Run: `bash test/contract.test.sh`
Expected: 26 lines starting `ok - `, exit 0. The last line reports the size (about 1,800 bytes).

- [ ] **Step 5: Commit**

```bash
git add test/contract.test.sh pi/AGENTS.md
git commit -m "Add Samwise memory contract (#4)"
```

---

### Task 2: Wire the contract and personal wisdom into Samwise's context

**Files:**
- Modify: `test/bootstrap.test.sh`
- Modify: `bootstrap.sh`

- [ ] **Step 1: Add the failing assertions to `test/bootstrap.test.sh`**

(a) After the line:

```bash
assert_contains "$(cat "$settings")" '"../memory/skills"' "thanx-scope skills wired into Pi settings"
```

insert:

```bash

# --- context files: contract and personal wisdom are symlinked in (T3) --------
assert_eq "$(readlink "$home/agent/AGENTS.md")" "$REPO/pi/AGENTS.md" "AGENTS.md links to the memory contract"
assert_eq "$(readlink "$home/agent/APPEND_SYSTEM.md")" "$REPO/WORKING-WITH-GEORGE.md" \
  "APPEND_SYSTEM.md links to WORKING-WITH-GEORGE.md"

# A real file in the way is never overwritten.
other="$tmp/other-home"
mkdir -p "$other/agent"
echo "keep me" >"$other/agent/AGENTS.md"
if out="$(as_clean env SAMWISE_HOME="$other" "$REPO/bootstrap.sh" 2>&1)"; then
  fail "bootstrap replaced a regular AGENTS.md"
fi
assert_contains "$out" "is not a symlink" "bootstrap refuses to replace a regular AGENTS.md"
assert_eq "$(cat "$other/agent/AGENTS.md")" "keep me" "the regular AGENTS.md is left intact"
```

(b) After the line:

```bash
scope_head="$(git -C "$scope" rev-parse HEAD)"
```

insert:

```bash
ln -sfn /nonexistent/old-checkout/WORKING-WITH-GEORGE.md "$home/agent/APPEND_SYSTEM.md" # stale link
```

(c) After the line:

```bash
assert_eq "$(git -C "$scope" rev-parse HEAD)" "$scope_head" "thanx scope HEAD unchanged by re-run"
```

insert:

```bash
assert_eq "$(readlink "$home/agent/APPEND_SYSTEM.md")" "$REPO/WORKING-WITH-GEORGE.md" \
  "re-run repoints a stale APPEND_SYSTEM.md link"
assert_eq "$(readlink "$home/agent/AGENTS.md")" "$REPO/pi/AGENTS.md" "re-run keeps the AGENTS.md link"
```

(d) Append at the end of the file:

```bash
assert_contains "$(cat "$tmp/requests.log")" "Keystone wins" "memory contract reaches Samwise's prompt"
assert_contains "$(cat "$tmp/requests.log")" "# Working with George" "personal wisdom reaches Samwise's prompt"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash test/bootstrap.test.sh`
Expected: `FAIL: AGENTS.md links to the memory contract: expected '<repo>/pi/AGENTS.md', got ''`, exit non-zero.

- [ ] **Step 3: Add the symlink step to `bootstrap.sh`**

Replace:

```bash
step "Merging Pi settings"
```

with:

```bash
step "Linking Samwise context files"
# link <target> <path>: symlink <path> to <target>. A correct link is kept, a
# wrong or stale link is repointed (links hold no content), and a real file is
# never overwritten.
link() {
  if [[ -L "$2" ]]; then
    [[ "$(readlink "$2")" == "$1" ]] && return 0
    ln -sfn "$1" "$2"
  elif [[ -e "$2" ]]; then
    die "$2 is not a symlink; move it aside and re-run (it would be replaced by a link to $1)"
  else
    ln -s "$1" "$2"
  fi
}
link "$repo/pi/AGENTS.md" "$PI_CODING_AGENT_DIR/AGENTS.md"
link "$repo/WORKING-WITH-GEORGE.md" "$PI_CODING_AGENT_DIR/APPEND_SYSTEM.md"

step "Merging Pi settings"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash test/bootstrap.test.sh`
Expected: 35 lines starting `ok - `, exit 0.

- [ ] **Step 5: Commit**

```bash
git add test/bootstrap.test.sh bootstrap.sh
git commit -m "Link the memory contract and personal wisdom into Samwise's context (#4)"
```

---

### Task 3: README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the agent-dir row**

Replace:

```markdown
| `agent/` | Pi agent dir (`PI_CODING_AGENT_DIR`); settings merged from `pi/settings.json` |
```

with:

```markdown
| `agent/` | Pi agent dir (`PI_CODING_AGENT_DIR`); settings merged from `pi/settings.json`; `AGENTS.md` and `APPEND_SYSTEM.md` link to `pi/AGENTS.md` and `WORKING-WITH-GEORGE.md` |
```

- [ ] **Step 2: Add a contract paragraph at the end of the "Scopes" section**

Replace:

```markdown
dir is inside this repo, and `.gitignore` ignores pi-memory's file names here.
```

with:

```markdown
dir is inside this repo, and `.gitignore` ignores pi-memory's file names here.

The memory contract, `pi/AGENTS.md`, tells Samwise which layer to consult, how
to record experience and that wisdom changes only through `/reflect`. It names
no paths: memory is reached through pi-memory's tools, which run in the Pi host
process, and both wisdom files are injected. If pi-gondolin (T8) needs memory
mounted into its VM at `/memory`, only the mount changes, not the contract.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document the memory contract (#4)"
```

---

## Final verification (after all tasks)

- `bash test/run.sh` passes: bootstrap (35), contract (26), env (11), launcher (2), scopes (16), settings (9).
- Map #4 "Done when": self-contained memory section covering items 1–6 (Task 1 test); concrete daily-log template (Task 1, `#problem` block); contract is short (4,000-byte budget test).
