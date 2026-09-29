# Sandbox T2: Sandbox policy — design

**Issue:** #12 (part of epic #10, Samwise Sandbox). **Covers:** D4, D5, D6, Q5 (AC2).
**Status:** Approved 2026-09-29.

## Goal

Replace T1's placeholder `pi/sandbox.json` with the real policy: what bash may
read, write and reach, and what Pi's read/write/edit tools may touch without a
prompt. Every entry carries its reason, and a model-free test enforces the
policy's invariants.

## Findings that shape the design

From pi-sandbox 0.6.8 (`src/policy.ts`, `src/sandbox-runtime.ts`, `src/config.ts`)
and `@carderne/sandbox-runtime` 0.0.72:

- **Reads, OS level (bash):** allowed everywhere by default; `denyRead` blocks
  regions and `allowRead` re-allows paths inside them. **`allowRead` wins over
  `denyRead`**, whatever the specificity, and pi-sandbox adds every
  `allowWrite` path to `allowRead`. So any allow entry covering a secret
  re-exposes it.
- **Reads, Pi's read tool:** prompted for any path outside
  `allowRead`/`allowWrite`; `denyRead` is not consulted. D5 is therefore hard
  for bash and "prompted" for the read tool (a grant overrides it).
- **Writes:** `denyWrite` wins over `allowWrite` and is never prompted; paths
  outside `allowWrite` are prompted.
- **Path forms:** `~` expands to `$HOME`; relative paths resolve against the
  launch directory; no environment variables. Non-glob patterns match by
  prefix; patterns with `*` become an anchored regex in which `*` matches
  across `/`.
- **Mandatory write denies** in this runtime fork cover only shell rc files,
  `.gitconfig`, `.ripgreprc` and `.mcp.json`. **`.git/hooks` and `.git/config`
  are not protected**, and both run code outside the fence the next time
  George uses git.
- **Model-provider calls come from the Pi host process**, not bash; so do
  pi-memory's writes and its qmd subprocesses. None of them is fenced, and
  none needs bash network or write access.
- **Unknown keys survive rewrites:** approvals re-serialise the whole file,
  so a `_why` map stays next to the entries.

## Decisions (this design)

- **Deny home, allow listed.** `denyRead: ["~"]`; `allowRead` names the places
  bash needs. Secrets nobody listed are blocked by default.
- **George applies `/reflect`.** Samwise proposes; George types
  `!samwise-reflect apply` (with `--skip`/`--only`). `sandboxUserShell: false`
  so George's own `!` commands run unfenced. The config repo stays read-only
  to Samwise, and the memory dir is read-only to bash: wisdom files change
  only through George's command, by construction.
- **George pushes.** Credentials (`~/.ssh`, `~/.config/gh`) are unreadable
  from bash; Samwise commits on branches and asks George to push. D12's "may
  push" waits for a Thanx-scoped credential (brief parking lot: host-side
  secret injection).
- **No model-provider hosts** in `allowedDomains` (deviation from D6's
  wording: they would only add an exfiltration route for bash).
- **Memory dir read-only to bash** (stricter than D4): nothing Samwise runs in
  bash needs to write there any more.

## Policy (`pi/sandbox.json`)

Top level: `enabled: true`, `sandboxUserShell: false`, `network`,
`filesystem`, and `_why` (a map from each entry string to a one-line reason;
one reason serves an entry that appears in several arrays).

**`filesystem.denyRead`**: `~`.

**`filesystem.allowRead`**:
- `~/dev`: George's code, including this repo (`samwise-reflect` runs from it).
- `~/.pi/samwise/memory`: memory, read-only (`samwise-reflect context`).
- Toolchains: `~/.nvm`, `~/.npm-global`, `~/.volta`, `~/.asdf`, `~/.rbenv`,
  `~/.pyenv`, `~/.cargo`, `~/.rustup`, `~/.local/bin`.
- `~/.gitconfig`, `~/.config/git/config`: commit identity (not
  `~/.git-credentials`, not the rest of `~/.config/git`).
- Outside home, so the read tool doesn't prompt for system files (already
  readable at OS level): `/usr`, `/opt`, `/etc`, `/private/etc`, `/Library`,
  `/Applications`, `/System`, `/bin`, `/sbin`.

**`filesystem.allowWrite`**:
- `.`: the launch (project) directory.
- `/tmp`, `/private/tmp`, `/private/var/folders`: temp dirs (macOS `$TMPDIR`
  lives under the last one).
- `~/.pi/samwise/reflect`: `/reflect` proposals.
- `~/.npm`: npm's cache.

**`filesystem.denyWrite`** (hard):
- `.pi`: the project's Pi config (`sandbox.json` is re-read on every tool call
  and can disable the fence; `extensions/` is code Pi loads; `settings.json`
  installs packages).
- `.git/hooks`, `.git/config`, `*/.git/hooks/*`, `*/.git/config`: hooks and
  config run code outside the fence (including nested repos and submodules).
- `~/.pi/agent`, `~/.pi/samwise/agent`: Pi's agent dirs (settings, auth,
  extensions, the policy link).
- `~/.cache/qmd`: models the host process loads.
- pi-sandbox's defaults, kept because an explicit array replaces them: `.env`,
  `.env.*`, `*.pem`, `*.key`.

**`network.allowedDomains`** (exact hosts; no wildcards):
`registry.npmjs.org`, `registry.yarnpkg.com`, `pypi.org`,
`files.pythonhosted.org`, `rubygems.org`, `index.rubygems.org`, `github.com`,
`api.github.com`, `codeload.github.com`, `raw.githubusercontent.com`,
`objects.githubusercontent.com`. `deniedDomains: []`.

**Thanx hosts (Q5):** none. Process (README): on the first legitimate prompt
for a Thanx host, choose "Allow for all projects"; it lands in
`pi/sandbox.json` through the link; add its `_why`, review the diff, commit.

Formatting stays pi-sandbox's own (`JSON.stringify(config, null, 2)` plus a
newline; `test/sandbox.test.sh` already checks this).

## Supporting changes

- **`pi/prompts/reflect.md`**: after showing the diff, Samwise asks George to
  approve by running `!samwise-reflect apply` (or `--skip N,..`/`--only N,..`,
  or `!samwise-reflect discard`) himself. Samwise never runs `apply` or
  `discard`.
- **`samwise-reflect apply`** prints each item it commits (number, scope and
  text) before its existing summary, so George sees what was applied even if
  `pending.json` (writable by Samwise) changed after he approved.
- **Eval runner:** for scenarios with `requires: [reflect]`, after the Pi
  session, if a proposal is pending, the runner runs `samwise-reflect apply`
  (standing in for George's `!` command) before collecting the personal-scope
  files, so `personal_scope_clean` still checks what an approval would write.
- **Preflight (macOS)**, new check `checkPolicyCoverage(repo, env)` in
  `lib/sandbox/checks.mjs`: the config repo and `$PI_MEMORY_DIR` are readable
  under the policy (covered by `allowRead` or `allowWrite`), and
  `$SAMWISE_HOME/reflect` is writable (covered by `allowWrite`). Otherwise
  `samwise-reflect` breaks silently inside the fence. Uses a matcher that
  mirrors pi-sandbox 0.6.8's `matchesPattern`, in `lib/sandbox/match.mjs`.
- **README Sandbox section**: a short policy summary, the Q5 process, that
  George runs `/reflect` applies and pushes, and that new approvals need a
  `_why` before the tests pass.

## Tests (model-free, run on Linux)

`lib/sandbox/test/policy.test.mjs` (node:test) loads `pi/sandbox.json` and,
using `lib/sandbox/match.mjs` with `~` bound to a fixed fake home:

- **Secrets unreachable:** none of these is covered by, or contains, any
  `allowRead` or `allowWrite` entry: `~/.ssh`, `~/.aws`, `~/.config/gh`,
  `~/.gnupg`, `~/.netrc`, `~/.npmrc`, `~/.docker`, `~/.kube`,
  `~/.git-credentials`, `~/.config/git/credentials`, `~/.password-store`,
  `~/.config/op`, `~/Library/Keychains`,
  `~/Library/Application Support/Google/Chrome`,
  `~/Library/Application Support/Firefox`, `~/Library/Group Containers`,
  `~/.config/google-chrome`, `~/.mozilla`, `~/.pi/agent/auth.json`,
  `~/.pi/samwise/agent/auth.json`; and all of them are under `denyRead`.
- **Not writable:** `~` itself, `~/.bashrc`, `~/.zshrc`, `~/.ssh`,
  `~/.pi/agent/settings.json`, `~/.pi/samwise/agent/settings.json`,
  `~/.pi/samwise/memory/MEMORY.md` are not covered by `allowWrite`.
- **Hard write denies present:** `<cwd>/.pi/sandbox.json`,
  `<cwd>/.pi/extensions/x.ts`, `<cwd>/.git/hooks/pre-commit`,
  `<cwd>/.git/config`, `<cwd>/vendor/x/.git/hooks/post-checkout`,
  `~/.pi/samwise/agent/sandbox.json` all match `denyWrite`.
- **Domains:** no `*` anywhere in `allowedDomains`; none of `chatgpt.com`,
  `api.openai.com`, `api.anthropic.com` is allowed; every D6 host listed.
- **Rationale:** every entry in `denyRead`, `allowRead`, `allowWrite`,
  `denyWrite` and `allowedDomains` has a non-empty `_why`.
- **Settings:** `enabled` is `true`, `sandboxUserShell` is `false`.

`lib/sandbox/test/match.test.mjs`: the matcher's cases (tilde, relative,
prefix vs sibling, glob across `/`).
`lib/sandbox/test/checks.test.mjs`: `checkPolicyCoverage` pass and fail cases.
`test/reflect.test.sh`: `apply` prints the committed items.
`test/eval-runner.test.sh` (fixture): a reflect scenario's pending proposal is
applied by the runner.

**Manual smoke test on the Mac** (automated in T5): via `bin/samwise`, writing
`~/foo`, `cat ~/.ssh/id_*` and `curl https://example.com` are blocked or
prompted; writing in the project dir, `npm view zod version` and
`git ls-remote https://github.com/carderne/pi-sandbox` work; `/sandbox` shows
this policy.

## Out of scope

- Pushing from Samwise (D12) until a Thanx-scoped credential exists.
- Verifying the runtime actually enforces globbed `denyWrite` entries and the
  read-tool path checks (T3).
- Automated smoke tests through the fence (T5, on the Mac).

## Changes from review (2026-09-29)

Per-task reviews checked the policy against what pi-sandbox and its runtime
actually do and found gaps in this design. What changed:

- **Two matchers.** Pi's read/write/edit tools use pi-sandbox's `policy.ts`
  (`*` crosses `/`); bash uses the runtime (macOS Seatbelt), which converts
  globs gitignore-style (`*` stays within a directory, `**/` spans any depth)
  and first strips a trailing `/**`, deciding glob vs literal on what remains.
  `lib/sandbox/match.mjs` mirrors both (`globs: "tool" | "runtime"`), and the
  policy test checks every hard write-deny under both. The Finding "allowRead
  wins over denyRead whatever the specificity" is too strong for macOS: a
  literal `denyRead` nested inside a literal `allowRead` is re-applied and wins
  for bash. The policy doesn't rely on that.
- **Git denies:** `.git/hooks`, `.git/config`, `**/.git/hooks/*`,
  `**/.git/config`, `.git/modules/**/hooks/*`, `.git/modules/**/config`, plus
  git's redirection files: `.git/commondir`, `**/.git/commondir`,
  `.git/modules/**/commondir`, `**/.git` (gitlink files; writes inside the
  project's own `.git` still work) and `.git/worktrees`. Both redirections
  (commondir, gitlink) were reproduced end to end running code outside the
  fence before the fix.
- **Narrower reads:** `~/.npm-global/bin`, `~/.npm-global/lib` (not its
  `etc/npmrc`); `~/.cargo/bin`, `~/.cargo/registry`, `~/.cargo/git` (not
  `credentials.toml`).
- **Samwise's own home:** `~/.pi/samwise/tools` (qmd, run by the host) and
  `~/.pi/samwise/qmd` (its config and index) are hard write-denied.
- **Network:** `release-assets.githubusercontent.com` added (GitHub release
  downloads redirect there).
- **Launch dir (preflight, `checkLaunchDir`):** the policy lets bash write
  `.`, so `bin/samwise` on macOS refuses a launch dir that is or contains home,
  or overlaps (contains or is inside) the config repo, the memory dir, the Pi
  agent dir or `$SAMWISE_HOME`.
- **`samwise-reflect apply` treats `pending.json` as untrusted** (Samwise can
  write it): it validates the proposal (unique positive item numbers, known
  ops and scopes, text where needed, edit/retire targets that exist in their
  scope, single-line vocabulary, a reflected-through date not after today, no
  control characters) and fails closed; then it prints exactly what it
  commits: each item, the text an edit or retire removes, the new text, new
  vocabulary and the reflected-through date.

### Residual risks (accepted for v1)

- Git has other ways to redirect itself than those denied (e.g. environment
  or includes George's own config pulls in); the denies cover the paths shown
  to work. T5 should try git-based escapes through the real fence on the Mac.
- `apply` shows what it commits only after the fact (George's recourse is
  git). A proposal store the fenced bash cannot write (a host-side Pi tool)
  would remove the window; follow-up.
- A global npmrc under `~/.nvm`, `~/.asdf` or `~/.volta` would be readable;
  keep npm tokens in `~/.npmrc` (denied).
- Unverified on the Mac: pi-sandbox's tool matcher is case-sensitive while
  APFS usually isn't (`.PI/sandbox.json`); a launch dir reached through the
  `/System/Volumes/Data` firmlink may not canonicalise to `/Users/...`.
- The runtime drops glob write-denies on Linux; irrelevant while the fence is
  macOS-only.
