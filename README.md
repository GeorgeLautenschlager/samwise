# Samwise

Samwise adds local memory recall and consolidation to Pi. This package provides a Pi extension, prompts, and a Foreman subagent.

## Install and start

Run `./install.sh` from this checkout. It installs dependencies, merges package settings into `~/.pi/agent/settings.json` with a timestamped backup before changes, registers the source package in `~/Samwise/.pi/settings.json`, and creates `~/.samwise/memory`. Open Pi in the project with `cd ~/Samwise && pi`; trust `~/Samwise` when Pi asks. The project package settings—not global settings—enable the extension and agent. `./uninstall.sh` removes only its matching package registration/config values and its own matching `SYSTEM.md` symlink; backups are retained for manual restore, and any user-edited config values are reported for review.

George supplies `home/SYSTEM.md` (not included by this package). If present, installation links it to `~/Samwise/.pi/SYSTEM.md`, Pi's full-replacement prompt path; the root `~/Samwise/SYSTEM.md` is not loaded. Installation leaves any existing non-matching file or symlink untouched. If the supplied file is absent, installation clearly skips the link; re-run install after supplying it.

Pi-web is the existing external UI `@jmfederico/pi-web`: open/register `~/Samwise`, trust it, and start a session using the same commands and tools. This package does not launch Pi-web.

The installed commands are `/begin-workday`, `/resume-workday`, and `/end-workday`, plus `/memory status` and `/memory consolidate`. `/memory status` reports local date, weekday, and time; `/memory consolidate` starts an asynchronous consolidation and then reports success counts or an error, including a lock conflict. Model tools are `recall`, `memory_status`, and `memory_consolidate`.

Recall example: query ``, scope `{ "type": "commitment", "status": "open" }`. Empty queries list filtered matches; query terms use all-term matching. Results are capped at 20 and 8,000 serialized characters total, with excerpts capped at 180 characters. Recall results are derived summaries, not fresh evidence. For the latest digest use query ``, scope `{ "type": "digest" }`, limit `1`. The end-of-day prompt reviews first; its invocation authorizes consolidation afterward unless George asks to stop.

The default sessions folder is derived by `src/sessions.ts` from the encoded absolute `~/Samwise` project path under `~/.pi/agent/sessions`; the CLI `--sessions-dir` overrides it. The memory directory follows the same explicit override / `SAMWISE_MEMORY_DIR` / `~/.samwise/memory` precedence. Project-local trusted package discovery is supported by Pi's package loader; `pi-subagents` discovers project agents from `~/Samwise/.pi/settings.json`.

The packaged Foreman advertises itself for discovery. A pre-existing custom `~/.pi/agent/agents/foreman.md` takes precedence; install warns rather than overwriting it. Reconcile or remove that custom copy manually if you want the package agent. A byte-identical package copy may be removed during installation; restore it manually if desired.

## Memory behavior

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

The default session directory is the Samwise-only Pi session folder under `~/.pi/agent/sessions` derived from `~/Samwise`. The memory location is selected in this order: `--memory-dir`, `SAMWISE_MEMORY_DIR`, `~/.samwise/memory`. There is deliberately no repository-local store default. `--max-entries` defaults to 80 new processable entries per run and applies across all selected dates. Each date span receives only its own preceding covered ancestry context (up to eight entries); each context entry is capped at about 2,000 rendered characters, including tool fields. New transcript entry text is capped at 12,000 characters with a `[truncated]` marker, and tool arguments/results are abbreviated to 500 characters. Unfinished exchanges remain deferred while an assistant reply is pending, deferred, or issuing a tool call; stop, length, error, and aborted replies complete the exchange. Day boundaries and record dates use the machine's local timezone.

The planner freezes transcript file byte boundaries at run start, selects processable entries along Pi session ancestry, deduplicates cloned history by content identity, groups selected entries by local date, and prepares spans chronologically. Identity uses entry ID, timestamp, type, and message, not `parentId` or clone labels. All open, in-progress, blocked, and deferred commitments—including incoming requests—count as nonterminal records. `--dry-run` prints planned dates, sessions, and entry spans without calling the model or creating the memory directory, lock, or other files. `status` reports the last successful run, outstanding processable entries, unfinished deferred entries, entries beyond the selected limit, and counts of nonterminal commitments. If a consolidation lock exists, status reports a diagnostic with its path, owner PID (or unknown), and a safely quoted manual removal command; it does not check PID liveness. Failures exit nonzero. Each span allows one transient provider retry (timeouts/aborts) and, independently, one validation retry. The validation correction contains the error message only, not the previous raw response; a second invalid response fails without writing that span's new prepared outputs. Other provider/adapter errors are not retried.

## Stored outputs

### Daily digests

Each date is stored at `digests/YYYY-MM-DD.md` with human-editable YAML frontmatter: `type: digest`, `date`, `derived: true`, `projects`, `tags`, and `sources` (each source contains `sessionId` and `entryIds`). The five body sections are Work undertaken, Outcomes, Significant decisions, Changes of plan and interruptions, and Carry-forward items. Each item is labelled `stated`, `observed`, or `inferred` and cites source entries as `session-id/entry-id`. A later run revises that date's digest in place rather than creating another daily file.

### Episodes

Substantive problem-solving and decisions may create episode files at `episodes/YYYY-MM-DD-slug.md`; the filename date is the creation span date and is never renamed. A numeric suffix is added only on filename collision. The frontmatter ID is a UUID. Frontmatter fields are `type: episode`, `id`, `title`, `status` (`open`, `resolved`, or `abandoned`), `started`, `updated`, `projects`, `tags`, `derived: true`, and `sources`. The body has seven sections: Problem, Constraints, Alternatives considered, Reasoning and decision, Changes of understanding, Outcome, and Unresolved questions. Entries are labelled `stated`, `observed`, or `inferred` and cited. The prompt receives the full current episode text, including hand edits. Later updates replace only current sections Problem, Constraints, Reasoning and decision, Outcome, and Unresolved questions; Alternatives considered and Changes of understanding append cited, dated items only. Untargeted text is preserved. No empty/repeated headings are emitted. Episode context uses the last two existing digest activity dates on or before the span date (a current span can join once a digest exists); older resumed episodes may be duplicated. Episodes are retained when resolved or abandoned.

### Commitments and requests

Commitment files live at `commitments/<id>.md`; the ID is a UUID. Frontmatter fields are `type: commitment`, `id`, `title`, `kind` (`request` or `commitment`), `owner`, `requested_by`, optional `due` (`YYYY-MM-DD`), resolved relative to the cited entry's supplied local span day (not the current date) and omitted when ambiguous; `status` (`open`, `in-progress`, `blocked`, `deferred`, `done`, or `cancelled`), optional scalar `blocked_on` and `depends_on`, `next_action`, `projects`, `created`, `updated`, `derived: true`, and `sources`. A request remains a request until explicitly accepted; creation records the initial description and exactly one `created` history line with labels and citations. Updates append a dated, per-field history of changed values, each labelled and cited. Terminal records (`done` or `cancelled`) remain on disk. Initial shared provenance conservatively cites support for every initialized field; later changes have per-field citations.

Records are derived summaries, not fresh evidence. The model is asked to preserve uncertainty, avoid inferred mental causes, distinguish abandoned exploration from adopted decisions, and cite actual supporting items (not broad spans); record changes cite selected new entries only. It receives the minimum fields needed to track nonterminal commitments (ID, title, status, owner, next action), and open episodes updated on either of the last two existing digest activity dates on or before each span date. Episode context includes ID/title, a body summary capped at 300 characters, and full currentText for targeted revision. Older or non-open episodes are omitted from that context.

## Recovery and editing

State is stored in `state.json`; version 1 is written and versions 1 and 2 are read with the same shape. Before applying each span, the tool validates and atomically writes its rendered-file batch to `.pending-consolidation.json`; earlier spans are already committed and survive a later span failure. The journal contains targeted file contents and pre-write hashes, not operations. Replay skips files already matching rendered content, writes files whose current hash matches preHash, then writes state last and removes the journal. A mismatch causes `File edited since prepare; re-run after review`. This conflict will recur until a person manually reconciles the pending journal and output after review; there is no automatic merge or discard. An old operations-format journal fails clearly and must be manually reviewed (never automatically deleted). No fsync durability guarantee is made. Existing digest source IDs support recovery from version 1 runs that wrote a digest before state. Record citations are not used as broad transcript-span coverage.

Records are Markdown with YAML frontmatter. Updates preserve unrelated frontmatter fields, comments, untargeted body sections, and current episode text supplied to the model; however, a model update to a known field/current section can override a manual edit there. IDs are UUIDs; there are no internal markers. Invalid records not targeted for update are warned about and skipped. An invalid or ambiguous update target fails the whole run; repair the record and retry, leaving any pending journal in place. A corrupt pending journal fails clearly and is not discarded. Digest sources identify transcript entries currently resolvable in available sessions; retain source transcripts for reliable recovery. Branch changes after digestion are not tracked as history, and bytes appended after the run-start snapshot are not included.

Consolidation uses a fail-fast exclusive lock. A lock is never reclaimed automatically, even if its owner PID appears gone, so concurrent starters cannot race while cleaning a stale lock. If the owner is confirmed gone, remove the lock manually using the command shown by status/error.

## Limitations

Episode qualification and commitment acceptance are prompt-based; there is no guarantee of semantic correctness, and records are not reconciled across files. There is no scheduler/calendar integration, embeddings, review UI, or preferences system. The model has a 16,000-token output cap to leave headroom for combined replacement digest and record outputs; a busy span can still exhaust it, so lower `--max-entries` to reduce batch size. Growing nonterminal record context has no separate size bound. An open episode absent from those two activity dates may not be surfaced and can be duplicated; later-arriving historical entries are not fully reconciled chronologically with already processed newer dates. Hand-edited episode text is supplied for targeted revision, but model changes can still override edits in targeted sections; untouched sections and text are retained. Episode `started` uses the earliest cited entry's local date; filename creation date uses the span date and is never renamed, with a collision suffix only when needed. `created`/`updated` use the applicable new span's local day. An earlier undocumented start is not reconstructed retroactively. Citations identify actual supporting items, not broad transcript spans. Commitment creation contributes one history line.

`install.sh` assumes `~/Samwise` and `~/Samwise/.pi` are real directories, not symlinks; it does not yet refuse symlinked ones.

## Development

```sh
npm test
npm run typecheck
```

Tests use synthetic Pi sessions and an injected fake model only.
