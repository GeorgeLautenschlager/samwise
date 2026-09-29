# Sandbox T1: Install execution fence — design

**Issue:** #11 (part of epic #10, Samwise Sandbox). **Covers:** D1, D2, D3, D7, D8 (AC1, AC3).
**Status:** Approved 2026-09-29.

## Goal

Bootstrap installs a pinned pi-sandbox and its dependencies and links the
config repo's `sandbox.json` into the agent dir. `bin/samwise` makes sure Pi
never starts with the fence silently off, and bootstrap reports uncommitted
policy changes.

## Findings that shape the design

- **Package:** `npm:pi-sandbox` is carderne's (repo `carderne/pi-sandbox`,
  maintainer `chrisarderne`). Latest is 0.6.8. It depends on
  `@carderne/sandbox-runtime@^0.0.72`; a caret on `0.0.x` allows only that
  version, so pinning pi-sandbox pins the runtime too.
- **Loads on Pi 0.87.1** despite its peer range `^0.80.0`: after
  `pi install npm:pi-sandbox@0.6.8`, `pi --help` lists `--no-sandbox`.
- **Q1 (early answer, T3 confirms):** pi-sandbox checks Pi's read/write/edit
  tools against the same filesystem policy, in the host process. Bash is
  wrapped with Seatbelt (macOS) or bubblewrap (Linux).
- **It fails open.** If sandbox initialisation fails, pi-sandbox shows a UI
  notice and carries on: bash runs unwrapped and the read/write/edit checks are
  skipped. In `-p`/JSON mode nobody sees the notice.
- **Dependencies (runtime `checkDependencies()`):** on Linux, `rg`, `bwrap` and
  `socat`; on macOS, nothing (`sandbox-exec` is built in; the runtime does not
  check `rg` there). This Linux box has none of the three as binaries (`rg` is
  only a shell function).
- **Config layers:** `$PI_CODING_AGENT_DIR/sandbox.json` (global), then
  `<cwd>/.pi/sandbox.json` (project). Project scalars override global ones,
  including `enabled`; arrays are merged. The project file is re-read on every
  tool call.
- **Where approvals land:** "Allow for all projects" writes the global file
  with `writeFileSync`, which follows our symlink into the config repo (D8
  works). "Allow for this project" writes the project file, outside the config
  repo. pi-sandbox rewrites the file as `JSON.stringify(config, null, 2)`.
- An invalid global file is ignored with a console warning, and pi-sandbox
  falls back to its built-in defaults.

## Decisions (this design)

- **macOS only.** The fence is supported on macOS (the Thanx laptop). On
  Linux, Samwise runs unfenced only when explicitly opted in.
- **Fail closed at launch.** `bin/samwise` runs a preflight before starting
  Pi; any problem stops the launch.
- **One place for policy.** A project-local `.pi/sandbox.json` stops the
  launch; its entries belong in the config repo's `pi/sandbox.json`.

## Components

### `pi/settings.json`

Adds `"npm:pi-sandbox@0.6.8"` to `packages`. The existing merge and
`missing-packages` steps install it.

### `pi/sandbox.json` (placeholder policy)

```json
{
  "enabled": true
}
```

pi-sandbox's built-in defaults apply until T2 writes the real policy. The file
uses pi-sandbox's own formatting (2-space JSON, trailing newline), so an
approval written through the symlink shows up as a minimal diff.

### `bootstrap.sh`

- Links `$PI_CODING_AGENT_DIR/sandbox.json` to `$repo/pi/sandbox.json` with the
  existing `link()` (a real file in the way stops bootstrap). Eval homes get
  the link the same way, since they run bootstrap.
- New step "Checking sandbox dependencies": runs `lib/sandbox/deps.sh`.
  - macOS: if `type -P rg` finds no binary, `brew install ripgrep`; if there is
    no `brew`, stop with install instructions.
  - Other platforms: print that the fence is unsupported here and that
    `samwise` needs `SAMWISE_UNSANDBOXED=1`; continue.
- New step "Checking sandbox policy": runs `lib/sandbox/drift.sh "$repo"`.
  If `git status --porcelain -- pi/sandbox.json` is non-empty, it prints a
  warning and `git diff -- pi/sandbox.json` (for an untracked or staged file,
  the status line). Report only: bootstrap never commits or reverts it, and
  drift does not fail bootstrap.
- Stays idempotent: every new step checks state first.

### `bin/samwise`

In order:

1. If any argument is `--no-sandbox` or starts with `--no-sandbox=`, print an
   error and exit 2 without starting Pi (D7). Pi parses `--flag=value` and
   sets boolean extension flags to true whatever the value, so
   `--no-sandbox=false` would also switch the fence off.
2. Platform from `uname -s`.
   - **Not `Darwin`:** without `SAMWISE_UNSANDBOXED=1`, print an error
     explaining the fence is macOS-only and how to opt in, and exit 2. With it,
     print a warning to stderr and `exec pi --no-sandbox "$@"`.
   - **`Darwin`:** if `SAMWISE_UNSANDBOXED` is set (any value), print an error
     and exit 2. Otherwise run the preflight; if it fails, exit 2 with its
     messages. Then `exec pi "$@"`.

### `lib/sandbox/preflight.mjs` and `lib/sandbox/checks.mjs`

`node lib/sandbox/preflight.mjs <repo> <agent-dir> <cwd>`. Prints one line per
problem to stderr and exits 1 if there are any, else exits 0 silently. The
checks live in `checks.mjs` (for unit tests); each returns a list of problem
strings:

- `checkPolicyLink(repo, agentDir)`: `<agent-dir>/sandbox.json` must be a
  symlink resolving to `<repo>/pi/sandbox.json`.
- `checkPolicy(repo)`: `pi/sandbox.json` must parse as a JSON object and must
  not set `"enabled": false`.
- `checkProjectPolicy(repo, cwd)`: `<cwd>/.pi/sandbox.json` must not exist (as a
  file or a symlink). The message says to move its entries into
  `<repo>/pi/sandbox.json`.
- `checkPinnedVersion(repo, agentDir)`: the installed
  `<agent-dir>/npm/node_modules/pi-sandbox/package.json` version must equal the
  version pinned in `<repo>/pi/settings.json`.
- `checkDependencies(agentDir)` (async): imports `@carderne/sandbox-runtime` from
  `<agent-dir>/npm/node_modules` as Node resolves it from pi-sandbox (nested
  under `pi-sandbox` first, else hoisted) and
  returns `SandboxManager.checkDependencies().errors`. A missing runtime is
  itself a problem.

### `lib/sandbox/deps.sh`, `lib/sandbox/drift.sh`

Small scripts so bootstrap's new steps can be tested with stubs, without a
full bootstrap run. Both honour `uname`/`brew`/`git` from `PATH`.

### Eval runner

`eval/lib/pi-run.mjs` sets `SAMWISE_UNSANDBOXED=1` in the child environment
off macOS, and removes an inherited one on macOS (where the launcher refuses
it), so eval runs unfenced on this Linux box and fenced on the Mac (T5).
The test suite is host-independent the same way, and runs under macOS's stock
bash 3.2.

## Testing

All runnable on Linux:

- `test/launcher.test.sh` (stub `pi`, stub `uname`):
  - `--no-sandbox` (or `--no-sandbox=<value>`) anywhere in the args exits
    non-zero and Pi is not started.
  - Linux without the opt-in: non-zero exit, Pi not started.
  - Linux with `SAMWISE_UNSANDBOXED=1`: Pi receives `--no-sandbox` first, a
    warning is printed, other args pass through (existing tests set the opt-in).
  - "Darwin" with `SAMWISE_UNSANDBOXED` set: refused.
  - "Darwin" with a failing preflight (no agent dir): refused, Pi not started.
- `lib/sandbox/test/checks.test.mjs` (node:test, temp dirs): each check's
  pass and fail cases; dependency check with a fake runtime module reporting
  errors and one reporting none.
- `test/sandbox.test.sh`: `deps.sh` calls `brew install ripgrep` on "Darwin"
  when `rg` is missing, does nothing when present, stops when brew is missing,
  and prints the unsupported notice on Linux; `drift.sh` is silent on a clean
  temp repo and prints the diff after an uncommitted edit.
- `test/settings.test.sh`: every npm package in `pi/settings.json` is pinned
  to an exact `x.y.z`.
- `test/bootstrap.test.sh`: `sandbox.json` is linked to the repo file,
  pi-sandbox 0.6.8 is installed, the unsupported-platform notice is printed,
  and a re-run leaves the link in place.
- `test/unit.test.sh` also runs `lib/sandbox/test/*.test.mjs`.

**Not testable here:** AC1's "`/sandbox` reports the declared policy" needs
the Mac; George checks it there after bootstrap.

## Follow-ups for later issues

- **#12 (T2):** the model could write `<cwd>/.pi/sandbox.json` mid-session
  (the default policy lets it write `.`), which pi-sandbox re-reads on every
  tool call; the policy must deny writes to it, and to `.pi/extensions`, from
  which Pi loads code.
- **#15 (T5):** tests "via the sandbox" (AC2, the adversarial eval runs) need
  the Mac.
