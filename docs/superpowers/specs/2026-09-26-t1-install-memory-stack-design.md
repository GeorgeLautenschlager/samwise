# T1: Install memory stack — design

**Issue:** #2 (part of epic #1, Samwise Memory). **Covers:** D1, D2, D16, Q1, Q6.
**Status:** Approved 2026-09-26.

## Goal

A single idempotent `bootstrap.sh` in the Samwise config repo installs pi-memory
(pinned) and qmd (pinned, local embeddings only) into a Samwise-owned Pi agent
directory, and initialises the qmd collection over the memory directory. A
launcher, `bin/samwise`, runs Pi with the matching environment.

## Findings that shape the design

- **pi-memory 0.4.2 is configured only through environment variables**; it has
  no config file. So "enable qmd for selective injection" means exporting
  `PI_MEMORY_SNAPSHOT=per-turn` at launch, which requires a launcher.
- **Q1 resolved:** `PI_MEMORY_DIR` overrides the data directory. No symlink needed.
- **Q6 premise is wrong:** `@tobilu/qmd@2.8.3` is a Node package (engines
  `node >=22`, native `better-sqlite3` and `node-llama-cpp`) whose launcher only
  falls back to Bun when Node is absent. **Bun is not installed.**
- qmd honours `QMD_CONFIG_DIR` and `INDEX_PATH`, so Samwise's index (which holds
  memory content) can live outside the shared `~/.cache/qmd`.
- Pi writes to its own `settings.json` (`lastChangelogVersion`, `pi install`),
  so the repo's settings are merged in rather than symlinked.
- **Trade-off to carry into T7:** `per-turn` rebuilds the injected memory block
  every turn, which defeats provider prompt caching.

## Layout

```
bin/samwise              launcher: source lib/env.sh; exec pi "$@"
bootstrap.sh             idempotent installer
lib/env.sh               single source of truth for Samwise env
pi/settings.json         declarative Pi settings: {"packages": ["npm:pi-memory@0.4.2"]}
test/bootstrap.test.sh   clean-account integration test
README.md                bootstrap / run instructions
```

## `lib/env.sh`

Sourced by both the launcher and bootstrap. Everything derives from
`SAMWISE_HOME` (default `$HOME/.pi/samwise`), which may be preset by the caller.

| Variable | Value |
|---|---|
| `PI_CODING_AGENT_DIR` | `$SAMWISE_HOME/agent` |
| `PI_MEMORY_DIR` | `$SAMWISE_HOME/memory` (T2 repoints it to the thanx-scope repo) |
| `PI_MEMORY_SNAPSHOT` | `per-turn` |
| `QMD_CONFIG_DIR` | `$SAMWISE_HOME/qmd` |
| `INDEX_PATH` | `$SAMWISE_HOME/qmd/index.sqlite` |
| `PATH` | `$SAMWISE_HOME/tools/bin` prepended |

`QMD_EMBED_MODEL`, `QMD_RERANK_MODEL` and `QMD_GENERATE_MODEL` are explicitly
unset, so a value inherited from the caller's shell cannot override qmd's
default local models (D2). qmd itself writes its built-in defaults into
`index.yml` as a `models:` block of `hf:` GGUF URIs; those are downloaded once
and run locally, so they are expected.

The qmd version pin (`2.8.3`) lives in `bootstrap.sh`; the pi-memory pin lives
in `pi/settings.json` (D1).

## `bootstrap.sh`

Bash, `set -euo pipefail`. Each step checks state first so a re-run is a no-op.

1. **Prerequisites.** Node ≥ 22.19 (pi-memory's engine floor), `npm` and `pi`
   on `PATH`. If any is missing, fail with a clear message. Installing Node and
   Pi themselves belongs to the companion Samwise config brief.
2. **Directories.** Create `agent/`, `memory/`, `tools/`, `qmd/` under
   `SAMWISE_HOME`.
3. **Settings merge.** A Node snippet shallow-merges `pi/settings.json` into
   `$PI_CODING_AGENT_DIR/settings.json`: repo keys win, keys Pi wrote itself
   are kept. Write only if the result differs.
4. **Pi packages.** For each entry in the repo's `packages`, run `pi install
   <source>` unless it is already installed at that exact version.
5. **qmd.** Unless `$SAMWISE_HOME/tools/bin/qmd --version` reports `2.8.3`, run
   `npm install -g --prefix "$SAMWISE_HOME/tools" @tobilu/qmd@2.8.3`.
6. **Collection.** If `qmd collection list` lacks `pi-memory` (re-adding
   exits 1), run `qmd collection add "$PI_MEMORY_DIR" --name pi-memory`. Then
   always set the two contexts pi-memory intends (idempotent map writes):
   - `qmd context add qmd://pi-memory/daily "Daily append-only work logs organized by date"`
   - `qmd context add qmd://pi-memory "Curated long-term memory: decisions, preferences, facts, lessons"`

   pi-memory's own auto-setup passes `/daily` and `/`, which in qmd 2.8.3 fail
   and set a *global* context respectively (errors ignored), so bootstrap uses
   `qmd://` paths instead. Then always run `qmd update` and `qmd embed` (both
   incremental). The first
   embed downloads the default local embedding model.
7. Print a short summary (paths, versions, how to launch).

Errors: any failing command aborts with its output; a step that fails mid-way
is safe to retry because every step is state-checked.

## Testing

`test/bootstrap.test.sh` runs `bootstrap.sh` with `HOME` set to a fresh temp dir
(simulating a clean account) and `XDG_CACHE_HOME` pointed at the real cache so
the embedding model is not re-downloaded. It asserts every "Done when" item:

1. `settings.json` pins pi-memory to an exact version (`@\d+\.\d+\.\d+$`), and
   `pi list` reports pi-memory.
2. After seeding a memory file and running `qmd update`, `qmd search` for a
   term in it returns a hit.
3. Grepping the repo config and `$SAMWISE_HOME` config (`agent/settings.json`,
   `qmd/index.yml`, `lib/env.sh`, `pi/settings.json`) finds no `http(s)://`
   URLs, API keys, or `QMD_*_MODEL=` assignments, and every `models:` entry in
   `index.yml` is an `hf:` URI with `embed` equal to qmd's default
   (`embeddinggemma-300M`).
4. A second bootstrap run exits 0 and leaves `settings.json` and qmd's
   `index.yml` byte-identical.

## Out of scope

- The thanx-scope git repo and repointing `PI_MEMORY_DIR` (T2).
- Installing Node or Pi.
- `DECISIONS.md` (T7). The Bun change is recorded here and, with George's OK,
  as a comment on #2.
