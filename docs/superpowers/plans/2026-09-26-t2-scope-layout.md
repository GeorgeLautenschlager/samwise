# T2: Scope Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use steward:steward-local-sdd (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pi-memory's data dir a local-only thanx-scope git repo with a skeleton and wired skills, add the personal-scope `WORKING-WITH-GEORGE.md` template, and guard the config repo against thanx-scope content.

**Architecture:** `bootstrap.sh` gains a guard (the memory dir must be outside the config repo, via a tiny `lib/path-inside.mjs`) and a "Setting up thanx scope" step that `git init`s `$PI_MEMORY_DIR` with a skeleton once. `pi/settings.json` loads skills from `../memory/skills` (resolved from the agent dir). An end-to-end test drives the real `bin/samwise -p` against a local OpenAI-compatible stub so pi-memory's own `memory_write` runs.

**Tech Stack:** Bash, Node ≥ 22.19 (ES modules, no deps), git ≥ 2.28, Pi CLI, pi-memory 0.4.2.

**Spec:** `docs/superpowers/specs/2026-09-26-t2-scope-layout-design.md`

## Verified facts (checked 2026-09-26; do not re-derive)

- `SAMWISE_HOME=<h> bin/samwise -p --model stub/stub-model "…" </dev/null` with `PI_OFFLINE=1 PI_MEMORY_EXIT_SUMMARY=0` and a `models.json` in `<h>/agent` pointing at a local stub (`"api": "openai-completions"`) completes in seconds. **stdin must be closed** or `pi -p` hangs.
- Pi sends `POST /v1/chat/completions` with a JSON body containing `messages`; the second request includes a `{"role":"tool", …}` message after a tool call. A streaming SSE reply of one `chat.completion.chunk` with `delta.tool_calls`, then one with `finish_reason: "tool_calls"`, then `data: [DONE]` makes Pi run the tool.
- pi-memory's `memory_write` with `{"target":"daily","content":…}` appends to `$PI_MEMORY_DIR/daily/<today>.md`.
- `"skills": ["../memory/skills"]` in the agent `settings.json` loads `$SAMWISE_HOME/memory/skills/*/SKILL.md`; the skill's frontmatter `name` then appears in the system prompt of every request.
- pi-memory seeds and preserves `SCRATCHPAD.md` with header `# Scratchpad`.
- git 2.34 here: `git init -q -b main` works.
- Currently nothing in the config repo ignores `MEMORY.md` or `daily/`, and no tracked file would be affected by ignoring them.

## File structure

| File | Change |
|---|---|
| `lib/path-inside.mjs` | Create: exit 0 if path A is B or inside B (physical paths, A may not exist yet) |
| `WORKING-WITH-GEORGE.md` | Create: personal-scope wisdom template |
| `.gitignore` | Modify: append D5 block |
| `test/scopes.test.sh` | Create: fast tests for the template, ignores and `path-inside.mjs` |
| `pi/settings.json` | Modify: add `skills` |
| `bootstrap.sh` | Modify: guard + thanx-scope step |
| `test/fixtures/stub-llm.mjs` | Create: OpenAI-compatible stub LLM |
| `test/bootstrap.test.sh` | Modify: thanx-scope, guard and end-to-end assertions |
| `README.md` | Modify: "Scopes" section |

---

### Task 1: Personal scope, `.gitignore` guard and `path-inside.mjs`

**Files:**
- Create: `test/scopes.test.sh`, `WORKING-WITH-GEORGE.md`, `lib/path-inside.mjs`
- Modify: `.gitignore` (append at end)

- [ ] **Step 1: Write the failing test**

Create `test/scopes.test.sh`:

```bash
#!/usr/bin/env bash
# Fast tests for scope separation: the personal-scope template, the config
# repo's D5 ignores, and lib/path-inside.mjs.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "$REPO/test/lib.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- WORKING-WITH-GEORGE.md template ------------------------------------------
wwg="$(cat "$REPO/WORKING-WITH-GEORGE.md")"
assert_contains "$wwg" "Never Thanx-specific" "template states the scope rule (D5)"
assert_contains "$wwg" "only through \`/reflect\`" "template states the /reflect rule (D8)"
assert_contains "$wwg" "deleted, not annotated" "template states the retirement rule (D9)"
assert_contains "$wwg" "as-of: YYYY-MM-DD" "template shows the dated entry format (D9)"
assert_contains "$wwg" $'\n## Entries\n' "template has an Entries section"

# --- config repo ignores thanx-scope file names (D5) --------------------------
for p in MEMORY.md SCRATCHPAD.md daily/x.md recovery/x.json sub/daily/x.md; do
  git -C "$REPO" check-ignore -q "$p" || fail "$p is not ignored"
  pass "config repo ignores $p"
done
if git -C "$REPO" check-ignore -q WORKING-WITH-GEORGE.md; then
  fail "WORKING-WITH-GEORGE.md must not be ignored"
fi
pass "config repo does not ignore WORKING-WITH-GEORGE.md"

# --- lib/path-inside.mjs ------------------------------------------------------
inside() { node "$REPO/lib/path-inside.mjs" "$1" "$2"; }
mkdir -p "$tmp/repo/sub" "$tmp/repo2" "$tmp/elsewhere"
ln -s "$tmp/repo/sub" "$tmp/elsewhere/link"

inside "$tmp/repo" "$tmp/repo" || fail "same dir should count as inside"
pass "path-inside: same dir"
inside "$tmp/repo/sub/new/deeper" "$tmp/repo" || fail "not-yet-existing child should count as inside"
pass "path-inside: non-existent child"
inside "$tmp/elsewhere/link/x" "$tmp/repo" || fail "symlink into repo should count as inside"
pass "path-inside: symlink resolved"
if inside "$tmp/repo2" "$tmp/repo"; then fail "sibling with shared prefix is not inside"; fi
pass "path-inside: shared-prefix sibling is outside"
if inside "$tmp/elsewhere" "$tmp/repo"; then fail "unrelated dir is not inside"; fi
pass "path-inside: unrelated dir is outside"
```

Then `chmod +x test/scopes.test.sh`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bash test/scopes.test.sh`
Expected: exits non-zero; `cat` reports `WORKING-WITH-GEORGE.md: No such file or directory` and the first assertion fails.

- [ ] **Step 3: Create `WORKING-WITH-GEORGE.md`**

````markdown
# Working with George

How George and Samwise work together: preferences, working style, and general
engineering judgement.

This is the **personal scope**: portable, and it leaves with George. Never
Thanx-specific: no internal systems, customers, people, incidents, code or
metrics. When unsure, it belongs in the thanx scope instead.

## Rules

- Entries are added, edited and retired only through `/reflect`, with George's
  approval.
- Every entry carries an `as-of` date.
- Entries George marks wrong are deleted, not annotated.

## Entry format

```
### <Short title>
as-of: YYYY-MM-DD

<The lesson or preference, and when it applies.>
```

## Entries
````

(The file ends with the `## Entries` line followed by a single newline.)

- [ ] **Step 4: Append the D5 block to `.gitignore`**

Append exactly:

```gitignore

# D5 belt and braces: thanx-scope (pi-memory) content never belongs in this repo.
MEMORY.md
SCRATCHPAD.md
daily/
recovery/
```

- [ ] **Step 5: Create `lib/path-inside.mjs`**

```js
// Exit 0 if <path> is <dir> or inside it, 1 otherwise. Compares physical
// paths (symlinks resolved); <path> need not exist yet, so the check can run
// before anything is created.
// Usage: node lib/path-inside.mjs <path> <dir>
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

const [target, dir] = process.argv.slice(2);
if (!target || !dir) {
	console.error("usage: path-inside.mjs <path> <dir>");
	process.exit(2);
}

// Resolve the nearest existing ancestor physically, then re-append the rest.
function physical(p) {
	let existing = resolve(p);
	const rest = [];
	while (!existsSync(existing)) {
		rest.unshift(basename(existing));
		existing = dirname(existing);
	}
	return join(realpathSync(existing), ...rest);
}

const t = physical(target);
const d = physical(dir);
process.exit(t === d || t.startsWith(d + sep) ? 0 : 1);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bash test/scopes.test.sh`
Expected: 16 lines starting `ok - `, exit 0.

- [ ] **Step 7: Run the other fast tests**

Run: `SKIP_INTEGRATION=1 bash test/run.sh`
Expected: ends with `all tests passed`.

- [ ] **Step 8: Commit**

```bash
git add test/scopes.test.sh WORKING-WITH-GEORGE.md lib/path-inside.mjs .gitignore
git commit -m "Add personal-scope template and D5 guards (#3)"
```

---

### Task 2: Thanx-scope repo in bootstrap, skills wiring

**Files:**
- Modify: `test/bootstrap.test.sh`
- Modify: `bootstrap.sh`
- Modify: `pi/settings.json`

- [ ] **Step 1: Add the failing assertions to `test/bootstrap.test.sh`**

(a) After the line `index_yml="$home/qmd/index.yml"` add:

```bash
scope="$home/memory"
```

(b) Immediately before the line `# --- re-running is safe -------------------------------------------------------` insert:

```bash
# --- thanx scope: local-only git repo with skeleton (D3, D12) -----------------
[[ -d "$scope/.git" ]] || fail "thanx scope is not a git repo"
pass "thanx scope is a git repo"
assert_eq "$(git -C "$scope" remote)" "" "thanx scope has no remote"
assert_eq "$(git -C "$scope" ls-files | tr '\n' ' ')" \
  "MEMORY.md SCRATCHPAD.md daily/.gitkeep skills/.gitkeep " "skeleton committed"
assert_eq "$(git -C "$scope" status --porcelain)" "" "thanx scope working tree is clean"
assert_contains "$(cat "$settings")" '"../memory/skills"' "thanx-scope skills wired into Pi settings"

```

(c) Replace:

```bash
settings_sum="$(cksum <"$settings")"
index_sum="$(cksum <"$index_yml")"
```

with:

```bash
settings_sum="$(cksum <"$settings")"
index_sum="$(cksum <"$index_yml")"
scope_head="$(git -C "$scope" rev-parse HEAD)"
```

(d) Replace:

```bash
assert_eq "$(cksum <"$index_yml")" "$index_sum" "index.yml unchanged by re-run"
```

with:

```bash
assert_eq "$(cksum <"$index_yml")" "$index_sum" "index.yml unchanged by re-run"
assert_eq "$(git -C "$scope" rev-parse HEAD)" "$scope_head" "thanx scope HEAD unchanged by re-run"

# --- guard: thanx scope may not live inside the config repo (D5) --------------
probe="$REPO/.guard-probe-home"
if out="$(as_clean env SAMWISE_HOME="$probe" "$REPO/bootstrap.sh" 2>&1)"; then
  rm -rf "$probe"
  fail "bootstrap accepted a thanx scope inside the config repo"
fi
assert_contains "$out" "inside the config repo" "bootstrap refuses a thanx scope inside the config repo"
[[ ! -e "$probe" ]] || { rm -rf "$probe"; fail "guard ran after creating files in the config repo"; }
pass "guard fails before creating anything"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash test/bootstrap.test.sh`
Expected: the T1 assertions pass, then `FAIL: thanx scope is not a git repo`, exit non-zero.

- [ ] **Step 3: Add skills to `pi/settings.json`**

Replace the whole file with:

```json
{
  "packages": [
    "npm:pi-memory@0.4.2"
  ],
  "skills": [
    "../memory/skills"
  ]
}
```

- [ ] **Step 4: Add the guard to `bootstrap.sh`**

Replace:

```bash
step "Creating $SAMWISE_HOME"
```

with:

```bash
step "Checking scope separation"
if node "$repo/lib/path-inside.mjs" "$PI_MEMORY_DIR" "$repo"; then
  die "PI_MEMORY_DIR ($PI_MEMORY_DIR) is inside the config repo; the thanx scope must live outside it (D5)"
fi

step "Creating $SAMWISE_HOME"
```

- [ ] **Step 5: Add the thanx-scope step to `bootstrap.sh`**

Replace:

```bash
step "Merging Pi settings"
```

with:

```bash
step "Setting up thanx scope"
# The pi-memory data dir is the thanx scope: its own local-only git repo (D3).
# No remote until Thanx approves one (D12). Existing memory is never overwritten.
if [[ ! -d "$PI_MEMORY_DIR/.git" ]]; then
  git -C "$PI_MEMORY_DIR" init -q -b main
  mkdir -p "$PI_MEMORY_DIR/daily" "$PI_MEMORY_DIR/skills"
  touch "$PI_MEMORY_DIR/daily/.gitkeep" "$PI_MEMORY_DIR/skills/.gitkeep"
  if [[ ! -e "$PI_MEMORY_DIR/MEMORY.md" ]]; then
    printf '%s\n' "# Thanx memory" "" \
      "Wisdom from working at Thanx (thanx scope; stays with Thanx). Entries carry an as-of date and change only through /reflect." \
      >"$PI_MEMORY_DIR/MEMORY.md"
  fi
  if [[ ! -e "$PI_MEMORY_DIR/SCRATCHPAD.md" ]]; then
    printf '# Scratchpad\n\n' >"$PI_MEMORY_DIR/SCRATCHPAD.md"
  fi
  git -C "$PI_MEMORY_DIR" add -A
  git -C "$PI_MEMORY_DIR" -c user.name=Samwise -c user.email=samwise@localhost \
    commit -q -m "Initialize thanx scope"
fi

step "Merging Pi settings"
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bash test/bootstrap.test.sh`
Expected: 22 lines starting `ok - `, exit 0.

- [ ] **Step 7: Commit**

```bash
git add test/bootstrap.test.sh bootstrap.sh pi/settings.json
git commit -m "Make pi-memory's data dir the local-only thanx-scope repo (#3)"
```

---

### Task 3: End-to-end write through the real Pi session

**Files:**
- Create: `test/fixtures/stub-llm.mjs`
- Modify: `test/bootstrap.test.sh` (append at end)

- [ ] **Step 1: Create `test/fixtures/stub-llm.mjs`**

```js
// Minimal OpenAI-compatible streaming stub for Pi. The first turn calls
// pi-memory's memory_write (daily) with <note>; once a tool result is present
// it answers "done". Every request body is appended to <request-log>.
// Prints the listening port on stdout.
// Usage: node test/fixtures/stub-llm.mjs <note> <request-log>
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const [note, requestLog] = process.argv.slice(2);
if (!note || !requestLog) {
	console.error("usage: stub-llm.mjs <note> <request-log>");
	process.exit(2);
}

function chunk(delta, finishReason) {
	const body = {
		id: "stub",
		object: "chat.completion.chunk",
		created: 0,
		model: "stub-model",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
	return `data: ${JSON.stringify(body)}\n\n`;
}

const server = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => {
		body += c;
	});
	req.on("end", () => {
		appendFileSync(requestLog, `${body}\n`);
		const { messages = [] } = JSON.parse(body || "{}");
		const answered = messages.some((m) => m.role === "tool");
		const delta = answered
			? { role: "assistant", content: "done" }
			: {
					role: "assistant",
					content: null,
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							type: "function",
							function: {
								name: "memory_write",
								arguments: JSON.stringify({ target: "daily", content: note }),
							},
						},
					],
				};
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(chunk(delta, null));
		res.write(chunk({}, answered ? "stop" : "tool_calls"));
		res.end("data: [DONE]\n\n");
	});
});

server.listen(0, "127.0.0.1", () => console.log(server.address().port));
```

- [ ] **Step 2: Append the end-to-end section to `test/bootstrap.test.sh`**

Append at the end of the file:

```bash

# --- end-to-end: a real pi-memory write lands in the thanx scope --------------
mkdir -p "$scope/skills/probe"
printf -- '---\nname: probe-skill-zq7\ndescription: Probe skill for the Samwise bootstrap test.\n---\n\nProbe.\n' \
  >"$scope/skills/probe/SKILL.md"
repo_status="$(git -C "$REPO" status --porcelain)"

node "$REPO/test/fixtures/stub-llm.mjs" "#lesson e2e-probe-note" "$tmp/requests.log" >"$tmp/port" &
stub_pid=$!
trap 'kill "$stub_pid" 2>/dev/null; rm -rf "$tmp"' EXIT
for _ in $(seq 50); do [[ -s "$tmp/port" ]] && break; sleep 0.1; done
[[ -s "$tmp/port" ]] || fail "stub LLM did not start"

cat >"$home/agent/models.json" <<EOF
{ "providers": { "stub": {
  "baseUrl": "http://127.0.0.1:$(cat "$tmp/port")/v1",
  "api": "openai-completions",
  "apiKey": "stub",
  "models": [{ "id": "stub-model" }]
} } }
EOF

(cd "$tmp" && as_clean PI_OFFLINE=1 PI_MEMORY_EXIT_SUMMARY=0 \
  timeout 60 "$REPO/bin/samwise" -p --model stub/stub-model "remember this" </dev/null) \
  >"$tmp/pi.log" 2>&1 || { cat "$tmp/pi.log"; fail "Samwise session against the stub failed"; }
pass "Samwise session runs against the stub LLM"

note_file="$(grep -l "e2e-probe-note" "$scope"/daily/*.md || true)"
[[ -n "$note_file" ]] || fail "memory_write did not land in the thanx scope's daily log"
pass "memory_write landed in the thanx scope's daily log"
assert_contains "$(git -C "$scope" status --porcelain)" "daily/$(basename "$note_file")" \
  "the write shows up as a change in the thanx-scope repo"
assert_eq "$(git -C "$REPO" status --porcelain)" "$repo_status" "config repo untouched by the write"
assert_contains "$(cat "$tmp/requests.log")" "probe-skill-zq7" "thanx-scope skills reach Samwise's prompt"
```

- [ ] **Step 3: Run the test**

Run: `bash test/bootstrap.test.sh`
Expected: 27 lines starting `ok - `, exit 0.

- [ ] **Step 4: Prove the end-to-end assertions can fail**

Temporarily change the note the stub is given from `"#lesson e2e-probe-note"` to `"#lesson something-else"` in the appended section, run `bash test/bootstrap.test.sh`, and confirm it ends with `FAIL: memory_write did not land in the thanx scope's daily log`. Revert the change (`git diff test/bootstrap.test.sh` shows only the intended additions).

- [ ] **Step 5: Commit**

```bash
git add test/fixtures/stub-llm.mjs test/bootstrap.test.sh
git commit -m "Test a real pi-memory write lands in the thanx scope (#3)"
```

---

### Task 4: README "Scopes" section

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the install table row for `memory/`**

Replace:

```markdown
| `memory/` | pi-memory data: `MEMORY.md`, daily logs, scratchpad |
```

with:

```markdown
| `memory/` | The thanx scope: pi-memory data, as its own local git repo (see below) |
```

- [ ] **Step 2: Insert a "Scopes" section before `## Test`**

Replace:

```markdown
## Test
```

with:

```markdown
## Scopes

Memory is split in two, and nothing Thanx-specific may enter the personal scope.

- **Personal scope**: this repo (config). `WORKING-WITH-GEORGE.md`, persona and
  general skills. Portable; pushed to this repo's private remote.
- **Thanx scope**: `~/.pi/samwise/memory`, pi-memory's data dir (state). A
  separate git repo with `MEMORY.md`, `daily/`, `SCRATCHPAD.md` and `skills/`
  for Thanx-specific skills (loaded via `pi/settings.json`). Local commits only
  until Thanx approves a remote. Stays with Thanx.

pi-memory's data dir is configurable through `PI_MEMORY_DIR`, which
`lib/env.sh` sets, so no symlink is needed. Bootstrap refuses to run if that
dir is inside this repo, and `.gitignore` ignores pi-memory's file names here.

## Test
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "Document the personal and thanx scopes (#3)"
```

---

## Final verification (after all tasks)

- `bash test/run.sh` passes: bootstrap (27), env (11), launcher (2), scopes (16), settings (9).
- Map each #3 "Done when" item to an assertion:
  fresh bootstrap → thanx-scope repo with no remote (Task 2); pi-memory write lands in the thanx scope, not the config repo (Task 3);
  `WORKING-WITH-GEORGE.md` template (Task 1); Q1 documented (Task 4); `.gitignore` guard (Task 1).
