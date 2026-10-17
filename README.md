# Samwise Memory

A small, local-first Pi transcript reader and consolidation tool. It reads persisted Pi JSONL sessions and writes three kinds of derived Markdown: daily digests, problem-solving episodes, and commitments/requests. It does not edit source sessions.

## Setup

Requires Node.js 22.19+ and npm. Install dependencies with `npm install`. The CLI is available in the project as `node --experimental-strip-types src/cli.ts ...`; use `npm link` from this checkout to install the `samwise-memory` command locally.

Consolidation uses Pi's configured `openai/gpt-6-luna` model and credential store. It reads `~/.pi/agent/auth.json` and `~/.pi/agent/models.json`; set up Pi credentials through Pi before running. Model catalog discovery is local-only (`allowModelNetwork: false`), there is no model fallback, and this repository does not implement OAuth. No live-model call is made by tests.

## Privacy

Transcripts, digests, episodes, and commitments stay in their local directories unless consolidation is run. A real consolidation sends the selected transcript span, bounded preceding transcript context, the current digest for its date, and record context (open commitments and recently updated open episodes) to the configured model provider. Inspect that content and provider policy before running. `status` and `--dry-run` are local-only and make no model request.

## Commands

```sh
samwise-memory consolidate [--sessions-dir DIR] [--memory-dir DIR] [--max-entries N] [--dry-run]
samwise-memory status [--sessions-dir DIR] [--memory-dir DIR] [--max-entries N]
```

The default session directory is `~/.pi/agent/sessions`. The memory location is selected in this order: `--memory-dir`, `SAMWISE_MEMORY_DIR`, `~/.samwise/memory`. There is deliberately no repository-local store default. `--max-entries` defaults to 200 new processable entries per run and applies across all selected dates. Up to eight preceding covered ancestry entries provide context; each transcript entry's conversational text is capped at 12,000 characters with a `[truncated]` marker, and tool arguments/results are abbreviated to 500 characters. Unfinished exchanges remain deferred while an assistant reply is pending, deferred, or issuing a tool call; stop, length, error, and aborted replies complete the exchange. Day boundaries and record dates use the machine's local timezone.

The planner freezes transcript file byte boundaries at run start, selects processable entries along Pi session ancestry, deduplicates cloned history by content identity, groups selected entries by local date, and prepares spans chronologically. Identity uses entry ID, timestamp, type, and message, not `parentId` or clone labels. All open, in-progress, blocked, and deferred commitments—including incoming requests—count as nonterminal records. `--dry-run` prints planned dates, sessions, and entry spans without calling the model or creating the memory directory, lock, or other files. `status` reports the last successful run, outstanding processable entries, unfinished deferred entries, entries beyond the selected limit, and counts of nonterminal commitments. If a consolidation lock exists, status reports a diagnostic with its path, owner PID (or unknown), and a safely quoted manual removal command; it does not check PID liveness. Failures exit nonzero. If a model response fails output validation, consolidation makes one bounded retry with the validation error and prior response included as untrusted correction context; a second invalid response fails clearly without writing this run's new prepared outputs. Provider/adapter errors and timeouts are not retried.

## Stored outputs

### Daily digests

Each date is stored at `digests/YYYY-MM-DD.md` with human-editable YAML frontmatter: `type: digest`, `date`, `derived: true`, `projects`, `tags`, and `sources` (each source contains `sessionId` and `entryIds`). The five body sections are Work undertaken, Outcomes, Significant decisions, Changes of plan and interruptions, and Carry-forward items. Each item is labelled `stated`, `observed`, or `inferred` and cites source entries as `session-id/entry-id`. A later run revises that date's digest in place rather than creating another daily file.

### Episodes

Substantive problem-solving and decisions may create episode files at `episodes/YYYY-MM-DD-slug-ID.md`. The date is the first represented span date; the deterministic ID suffix is part of the slug and distinguishes episodes. Frontmatter fields are `type: episode`, `id`, `title`, `status` (`open`, `resolved`, or `abandoned`), `started`, `updated`, `projects`, `tags`, `derived: true`, and `sources`. The body has seven sections: Problem, Constraints, Alternatives considered, Reasoning and decision, Changes of understanding, Outcome, and Unresolved questions. Entries are labelled `stated`, `observed`, or `inferred` and cited. Later updates append a dated revision, retaining prior exploration, including rejected and abandoned alternatives, rather than replacing it. Episodes are retained when resolved or abandoned.

### Commitments and requests

Commitment files live at `commitments/<id>.md`; the ID is deterministic from the creating span and model local key, not the title. Frontmatter fields are `type: commitment`, `id`, `title`, `kind` (`request` or `commitment`), `owner`, `requested_by`, optional `due` (`YYYY-MM-DD`), resolved relative to the cited entry's supplied local span day (not the current date) and omitted when ambiguous; `status` (`open`, `in-progress`, `blocked`, `deferred`, `done`, or `cancelled`), optional scalar `blocked_on` and `depends_on`, `next_action`, `projects`, `created`, `updated`, `derived: true`, and `sources`. A request remains a request until explicitly accepted; creation records the initial description and field history, with labels and citations. Updates append a dated, per-field history of changed values, each labelled and cited. Terminal records (`done` or `cancelled`) remain on disk. Initial shared provenance conservatively cites support for every initialized field; later changes have per-field citations.

Records are derived summaries, not fresh evidence. The model is asked to preserve uncertainty, avoid inferred mental causes, distinguish abandoned exploration from adopted decisions, and cite only selected new entries for record changes. It receives the minimum fields needed to track nonterminal commitments (ID, title, status, owner, next action), and open episodes updated within the 30 days preceding each span date (ID, title, and a body summary capped at 300 characters). Terminal commitments and older or non-open episodes are omitted from that context.

## Recovery and editing

State is stored in `state.json`; version 2 reads version 1 state. Before applying a run, the tool validates and prepares all selected spans and outputs, then atomically writes an internal durable batch to `.pending-consolidation.json` before writing any output. The batch records operations and targeted atomic writes; replay applies record operations with internal operation markers, replaces digests, writes state last, and removes the journal. On a later run, a pending batch is replayed under the same fail-fast exclusive lock before new coverage or planning, without another model call for that batch. Existing digest source IDs support recovery from version 1 runs that wrote a digest before state. Record citations are not used as broad transcript-span coverage.

Records are Markdown with YAML frontmatter. Updates preserve unrelated frontmatter fields, comments, and body text; however, a model update to a known field can override a manual edit to that same field. Internal IDs and `samwise-operation` HTML markers provide identity and replay safety; do not remove them. Invalid records not targeted for update are warned about and skipped. An invalid or ambiguous update target fails the whole run; repair the record and retry, leaving any pending journal in place. A corrupt pending journal fails clearly and is not discarded. Digest sources identify transcript entries currently resolvable in available sessions; retain source transcripts for reliable recovery. Branch changes after digestion are not tracked as history, and bytes appended after the run-start snapshot are not included.

Consolidation uses a fail-fast exclusive lock. A lock is never reclaimed automatically, even if its owner PID appears gone, so concurrent starters cannot race while cleaning a stale lock. If the owner is confirmed gone, remove the lock manually using the command shown by status/error.

## Limitations

Episode qualification and commitment acceptance are prompt-based; there is no guarantee of semantic certainty, and records are not reconciled across files. There is no recall, Pi extension, scheduler, review UI, or preferences system. The model has a fixed 7,000-token output cap for all three outputs, so a busy span can fail; lower `--max-entries` to reduce batch size. Growing nonterminal record context has no separate size bound. Episode revisions can be repetitive, an open episode older than 30 days may not be surfaced and can be duplicated, and later-arriving historical entries are not fully reconciled chronologically with already processed newer dates. Dates and `started`/`created`/`updated` are assigned from the first/new span's local day; an earlier undocumented start is not reconstructed retroactively.

## Development

```sh
npm test
npm run typecheck
```

Tests use synthetic Pi sessions and an injected fake model only.
