# Samwise Memory

A small, local-first Pi transcript reader and daily-digest consolidator. It reads persisted Pi JSONL sessions and writes derived Markdown digests; it does not edit source sessions.

## Setup

Requires Node.js 22.19+ and npm. Install dependencies with `npm install`. The CLI is available in the project as `node --experimental-strip-types src/cli.ts ...`; use `npm link` from this checkout to install the `samwise-memory` command locally.

Consolidation uses Pi's configured `openai/gpt-6-luna` model and credential store. It reads `~/.pi/agent/auth.json` and `~/.pi/agent/models.json`; set up Pi credentials through Pi before running. Model catalog discovery is local-only (`allowModelNetwork: false`), there is no model fallback, and this repository does not implement OAuth. No live-model call is made by tests.

## Privacy

Transcripts and digests stay in their local directories unless consolidation is run. A real consolidation sends the selected transcript span, bounded preceding context, and the current digest for its date to the configured model provider; inspect that content and provider policy before running. `status` and `--dry-run` are local-only and make no model request.

## Commands

```sh
samwise-memory consolidate [--sessions-dir DIR] [--memory-dir DIR] [--max-entries N] [--dry-run]
samwise-memory status [--sessions-dir DIR] [--memory-dir DIR] [--max-entries N]
```

The default session directory is `~/.pi/agent/sessions`. The memory location is selected in this order: `--memory-dir`, `SAMWISE_MEMORY_DIR`, `~/.samwise/memory`. There is deliberately no repository-local store default. `--max-entries` defaults to 200 new processable entries per run: enough for a useful batch while bounding each model request and recovery step. Up to eight preceding covered ancestry entries provide context without replaying an unbounded history; transcript tool arguments/results are abbreviated to 500 characters to cap prompt size while retaining useful details. Unfinished exchanges remain deferred until a completed assistant response is present.

`--dry-run` prints planned dates, sessions, and entry spans without calling the model or creating the memory directory, lock, or any other files. `status` reports the last successful run, outstanding processable entries, unfinished deferred entries, and any amount beyond the selected limit. If a consolidation lock exists, status also reports its path, owner PID/aliveness (or unknown), and the manual removal command. Failures exit nonzero.

## Store and provenance

Each day is stored at `digests/YYYY-MM-DD.md` with human-editable YAML frontmatter: `type: digest`, `date`, `derived: true`, `projects`, `tags`, and `sources`, where each source is only `{sessionId, entryIds}`. Digest sections are work undertaken, outcomes, significant decisions, changes of plan and interruptions, and carry-forward items. Each item is labelled `stated`, `observed`, or `inferred` and cites source entries as `session-id/entry-id`. Derived summaries are not fresh evidence; the prompt requires preserving uncertainty, avoiding inferred mental causes, and distinguishing abandoned exploration from adopted decisions.

The reader freezes transcript file byte boundaries at run start, selects bounded spans along Pi session ancestry, and deduplicates cloned history by content identity. Identity uses the entry ID, timestamp, type, and message, not `parentId` or clone labels: Pi can rewire ancestry when copying a branch past a label, but that structural change is not a new experience. Internal deduplication state lives only in `state.json`, with `version: 1`, `processedIdentities`, and `lastSuccessfulRun`; digests remain simple and editable. If a process stops after writing a digest but before state, rerun resolves the digest's plain source IDs against the frozen transcript snapshot, recomputes identities, and deduplicates matching clones. Writes use a fail-fast exclusive lock and atomic replacement; every model result is validated before the first digest/state write. An existing lock is never reclaimed automatically, even if its owner PID appears gone, so concurrent starters cannot race while cleaning a stale lock. If the owner is confirmed gone, remove the lock manually using the command shown by status/error. Revisit this simplified lock policy when scheduling lands (Slice 4). A later run revises a date's digest in place rather than adding another daily file.

Sources identify transcript entries currently resolvable in the available sessions. If a source transcript is removed or its ID changes, it cannot be resolved for crash recovery; retain source transcripts for reliable recovery. Branch changes after digestion are intentionally not tracked as history: the same semantic entry remains deduplicated if its active/abandoned classification changes. A later branch change may therefore be deferred rather than reprocessed. The session snapshot also cannot include transcript bytes appended after run start.

## Development

```sh
npm test
npm run typecheck
```

Tests use synthetic Pi sessions and an injected fake model only.
