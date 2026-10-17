import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { advanceOperation, buildRecordContext, loadRecordIndex, renderOperation, resetRecordWarnings, validateOperations, type DigestItem, type RecordOperation, type RecordSource, type RecordIndex } from "./records.ts";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { localDate, planTranscriptSpans, readTranscriptSnapshot, type PlannedSpan, type SpanPlan, type TranscriptEntry } from "./transcript.ts";

export type { DigestItem } from "./records.ts";
export interface DigestOutput { projects: string[]; tags: string[]; sections: Record<string, DigestItem[]> }
export interface ModelAdapter { consolidate(prompt: string): Promise<string> }
export interface ConsolidateOptions { sessionsDir?: string; memoryDir?: string; maxEntries?: number; dryRun?: boolean; model?: ModelAdapter; afterDigestWrite?: (date: string) => void; afterOutputWrite?: (kind: string, index: number) => void; afterPrepare?: () => void }
interface DigestFrontmatter { type: "digest"; date: string; derived: true; projects: string[]; tags: string[]; sources: Array<{ sessionId: string; entryIds: string[] }> }
interface ConsolidationState { version: 1 | 2; processedIdentities: string[]; lastSuccessfulRun: string | null }
interface PendingBatch { files: Array<{ path: string; content: string; preHash: string | null }>; state: ConsolidationState }
function validateState(value: unknown, message: string): asserts value is ConsolidationState {
  const state = value as ConsolidationState | null;
  if (!state || ![1, 2].includes(state.version) || !Array.isArray(state.processedIdentities) || state.processedIdentities.some((id) => typeof id !== "string") || !(state.lastSuccessfulRun === null || (typeof state.lastSuccessfulRun === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(state.lastSuccessfulRun) && !Number.isNaN(Date.parse(state.lastSuccessfulRun))))) throw new Error(message);
}
const headings = ["Work undertaken", "Outcomes", "Significant decisions", "Changes of plan and interruptions", "Carry-forward items"] as const;

export function resolveMemoryDir(memoryDir?: string): string {
  return resolve(memoryDir || (process.env.SAMWISE_MEMORY_DIR ? process.env.SAMWISE_MEMORY_DIR : undefined) || join(homedir(), ".samwise", "memory"));
}
function digestPath(dir: string, date: string): string { return join(dir, "digests", `${date}.md`); }
function readDigest(path: string): { frontmatter: DigestFrontmatter; body: string } | undefined {
  if (!existsSync(path)) return undefined;
  return readDigestText(readFileSync(path, "utf8"), path);
}
function coverageFrom(dir: string, snapshot: ReturnType<typeof readTranscriptSnapshot>): Set<string> {
  const identities = new Set<string>();
  const statePath = join(dir, "state.json");
  if (existsSync(statePath)) {
    let state: ConsolidationState;
    try { state = JSON.parse(readFileSync(statePath, "utf8")) as ConsolidationState; } catch { throw new Error(`Invalid state file: ${statePath}`); }
    validateState(state, `Invalid state file: ${statePath}`);
    for (const identity of state.processedIdentities) identities.add(identity);
  }
  const bySource = new Map(snapshot.entries.map((entry) => [`${entry.sessionId}\0${entry.id}`, entry.identity]));
  const directory = join(dir, "digests");
  if (existsSync(directory)) for (const name of readdirSync(directory)) if (name.endsWith(".md")) {
    let digest;
    try { digest = readDigest(join(directory, name)); } catch (error) { console.error(`Skipping invalid digest ${join(directory, name)}: ${(error as Error).message}`); continue; }
    for (const source of digest?.frontmatter.sources ?? []) for (const id of source.entryIds) {
      const identity = bySource.get(`${source.sessionId}\0${id}`);
      if (identity) identities.add(identity);
    }
  }
  return identities;
}

function contextEntry(entry: TranscriptEntry, bounded = false): string {
  const value = { source: `${entry.sessionId}/${entry.id}`, timestamp: entry.timestamp, role: entry.role, text: entry.text, toolCalls: [...entry.toolCalls], toolResults: [...entry.toolResults], branch: entry.abandoned ? "abandoned exploration (not adopted unless explicitly stated)" : "active" };
  if (!bounded) return JSON.stringify(value);
  let rendered = JSON.stringify(value);
  if (rendered.length > 2_000) {
    value.text = `${value.text.slice(0, Math.max(0, value.text.length - rendered.length + 1_990))}[truncated]`;
    rendered = JSON.stringify(value);
  }
  while (rendered.length > 2_000 && value.text.length) { value.text = value.text.slice(0, Math.max(0, value.text.length - rendered.length + 2_000)); rendered = JSON.stringify(value); }
  while (rendered.length > 2_000 && value.toolResults.length) { value.toolResults.pop(); rendered = JSON.stringify(value); }
  while (rendered.length > 2_000 && value.toolCalls.length) { value.toolCalls.pop(); rendered = JSON.stringify(value); }
  return rendered;
}
export function buildPrompt(span: PlannedSpan, context: TranscriptEntry[], priorBody = "", priorSources: string[] = [], records = { commitments: [], episodes: [] } as ReturnType<typeof buildRecordContext>): string {
  const sessionPairs = [...new Set([...priorSources, ...span.entries.map((entry) => `${entry.sessionId}/${entry.id}`)])];
  return [
    `Processing span local date: ${span.date}. Resolve relative due dates against the supplied local span day of the cited entry, not the current wall-clock date. Include due only as YYYY-MM-DD when unambiguous; omit it when ambiguous.`,
    `Return one strict JSON object: {digest:{projects:string[],tags:string[],sections:{<exact heading>:DigestItem[]}},operations:[...]}. No extra envelope keys. Digest headings are exactly ${headings.join(", ")}; every heading maps to a DigestItem array. DigestItem is {label:'stated'|'observed'|'inferred',text:string,citations:string[]}.`,
    `Operations: create-episode {kind:'create-episode',localKey,fields:{title,status:'open'|'resolved'|'abandoned',projects,tags},sections:Record<episode heading,DigestItem[]>}; update-episode {kind:'update-episode',id,fields?:{title,status,projects,tags},sections?:Record<episode heading,DigestItem[]>}; create-commitment {kind:'create-commitment',localKey,fields:{title,kind:'request'|'commitment',owner,requested_by,due?,status:'open'|'in-progress'|'blocked'|'deferred'|'done'|'cancelled',blocked_on?,depends_on?,next_action,projects},description:DigestItem}; owner is who must act (George, Samwise, or a named person/agent); requested_by is the request originator. update-commitment {kind:'update-commitment',id,changes:[{field,value,label,citations}]}; update values are string, string[], or null. Episode headings: Problem, Constraints, Alternatives considered, Reasoning and decision, Changes of understanding, Outcome, Unresolved questions. Runner supplies dates/provenance; do not emit runner fields. Unique localKey per create; no extra fields. No-op example: {digest:{projects:[],tags:[],sections:{...}},operations:[]}.`,
    "Create episodes only for substantive problem-solving or decisions; routine exchanges do not create episodes. Still record supported requests and commitments, including from routine exchanges, and update them when supported. A request remains kind=request until explicit acceptance. Rejected approaches and changes of mind are first-class; label abandoned branches abandoned exploration, not adopted decisions. Preserve uncertainty; use stated for George's claims, observed for evidence, and inferred only tentatively; never infer mental causes or diagnose. A commitment creation description's label and citations must conservatively support every initialized field because initialization has one shared provenance item. New record citations must cite only NEW span entries, not prior context or existing records.",
    `Existing records (derived context, not new evidence): ${JSON.stringify(records)}`,
    `Allowed source IDs (format session-id/entry-id): ${sessionPairs.join(", ")}. Each item must cite only IDs that support that item. The stated label applies only to George's own statements, not assistant choices or proposals.`,
    "Return the complete replacement digest. For episodes, replace only current sections Problem, Constraints, Reasoning and decision, Outcome, and Unresolved questions; append cited dated items to Alternatives considered and Changes of understanding. Respect supplied currentText, including human edits. Do not emit empty/repeated headings or no-op operations. Existing digest/context are not fresh evidence; context-only entries cannot support claims.",
    "Existing digest (may be corrected; its cited source references remain eligible):", priorBody || "(none)",
    "Prior context (interpretation only):", ...context.map((entry) => contextEntry(entry, true)), "New entries:", ...span.entries.map((entry) => contextEntry(entry)),
  ].join("\n");
}
function parseOutput(raw: string, span: PlannedSpan, prior: DigestFrontmatter | undefined): { digest: DigestOutput; operations: unknown } {
  const envelope = JSON.parse(raw) as any;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || Object.keys(envelope).sort().join(",") !== "digest,operations") throw new Error("Model returned invalid consolidation envelope");
  const value = envelope.digest as Partial<DigestOutput>;
  if (!value || !Array.isArray(value.projects) || !Array.isArray(value.tags) || !value.sections || typeof value.sections !== "object") throw new Error("Model returned invalid digest JSON");
  const priorSources = prior?.sources.flatMap((source) => source.entryIds.map((entryId) => `${source.sessionId}/${entryId}`)) ?? [];
  const allowed = new Set([...priorSources, ...span.entries.map((entry) => `${entry.sessionId}/${entry.id}`)]);
  const sections: Record<string, DigestItem[]> = {};
  for (const heading of headings) {
    const items = value.sections[heading];
    if (!Array.isArray(items)) throw new Error(`Model returned invalid item/citation in ${heading}: missing heading array`);
    sections[heading] = items.map((item, itemIndex) => {
      const location = `Model returned invalid item/citation in ${heading} item ${itemIndex + 1}`;
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${location}: invalid item shape`);
      if (!["stated", "observed", "inferred"].includes(item.label)) throw new Error(`${location}: invalid label ${JSON.stringify(item.label)}`);
      if (typeof item.text !== "string") throw new Error(`${location}: invalid text field`);
      if (!Array.isArray(item.citations) || item.citations.length === 0) throw new Error(`${location}: invalid citations field`);
      for (const citation of item.citations) if (typeof citation !== "string" || !allowed.has(citation)) throw new Error(`${location}: unknown citation ${JSON.stringify(citation)}`);
      return { label: item.label, text: item.text, citations: item.citations };
    });
  }
  if (Object.keys(value.sections).some((heading) => !(headings as readonly string[]).includes(heading))) throw new Error("Model returned an unknown section");
  if (value.projects.some((project) => typeof project !== "string") || value.tags.some((tag) => typeof tag !== "string")) throw new Error("Model returned invalid projects or tags");
  return { digest: { projects: value.projects as string[], tags: value.tags as string[], sections }, operations: envelope.operations };
}
function prepareOperations(raw: unknown, span: PlannedSpan, index: RecordIndex): RecordOperation[] {
  if (!Array.isArray(raw)) throw new Error("Model returned invalid operations");
  const spanSources: RecordSource[] = [...new Set(span.entries.map((entry) => entry.sessionId))].map((sessionId) => ({ sessionId, entryIds: span.entries.filter((entry) => entry.sessionId === sessionId).map((entry) => entry.id) }));
  const sourceDates = new Map(span.entries.map((entry) => [`${entry.sessionId}/${entry.id}`, localDate(entry.timestamp)]));
  const citedDate = (operation: any): string => {
    const items = operation.kind === "update-commitment" ? operation.changes ?? [] : operation.kind === "create-commitment" ? [operation.description] : Object.values(operation.sections ?? {}).flat();
    const dates = items.flatMap((item: any) => (item.citations ?? []).map((citation: string) => sourceDates.get(citation)).filter((date: string | undefined): date is string => !!date));
    return dates.sort()[0] ?? span.date;
  };
  const operations = raw.map((operation: any): RecordOperation => {
    if (!operation || typeof operation !== "object" || Array.isArray(operation) || !["create-episode", "update-episode", "create-commitment", "update-commitment"].includes(operation.kind)) throw new Error("Invalid operation schema");
    const normalized: any = { ...operation, spanSources, ...(operation.kind === "create-episode" || operation.kind === "create-commitment" ? { recordId: randomUUID() } : {}) };
    if (operation.kind === "create-episode") normalized.fields = { ...operation.fields, started: citedDate(operation), updated: span.date, sources: spanSources }, normalized.filenameDate = span.date;
    if (operation.kind === "update-episode") normalized.earliestCitedDate = citedDate(operation);
    if (operation.kind === "update-episode" || operation.kind === "update-commitment") normalized.updated = span.date;
    if (operation.kind === "create-commitment") normalized.fields = { ...operation.fields, created: span.date, updated: span.date };
    return normalized as RecordOperation;
  });
  validateOperations(operations, index); return operations;
}
function renderItems(output: DigestOutput): string {
  return headings.map((heading) => {
    const items = output.sections[heading].map((item) => `- **${item.label}** ${item.text} — [${item.citations.join(", ")}]`).join("\n");
    return `## ${heading}\n${items || "- None recorded."}`;
  }).join("\n\n");
}
function writeAtomic(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content, { flag: "wx" });
  renameSync(temp, path);
}
function frontmatter(existing: DigestFrontmatter | undefined, date: string, incoming: TranscriptEntry[], projects: string[], tags: string[]): DigestFrontmatter {
  const grouped = new Map<string, Set<string>>();
  for (const source of existing?.sources ?? []) grouped.set(source.sessionId, new Set(source.entryIds));
  for (const item of incoming) {
    const ids = grouped.get(item.sessionId) ?? new Set<string>();
    ids.add(item.id);
    grouped.set(item.sessionId, ids);
  }
  const sources = [...grouped].map(([sessionId, entryIds]) => ({ sessionId, entryIds: [...entryIds] }));
  return { type: "digest", date, derived: true, projects: [...new Set([...(existing?.projects ?? []), ...projects])], tags: [...new Set([...(existing?.tags ?? []), ...tags])], sources };
}
function renderDigest(metadata: DigestFrontmatter, body: string): string { return `---\n${stringify(metadata).trimEnd()}\n---\n\n${body.trim()}\n`; }
function persistSpan(dir: string, item: { date: string; output: DigestOutput; entries: TranscriptEntry[]; files: Array<{ path: string; content: string; preHash: string | null }>; prior?: { frontmatter: DigestFrontmatter; body: string } }, coverage: Set<string>, options: ConsolidateOptions): void {
  const files = new Map(item.files.map((file) => [file.path, file]));
  const digestFile = digestPath(dir, item.date), digestRelative = relative(dir, digestFile);
  files.set(digestRelative, { path: digestRelative, content: renderDigest(frontmatter(item.prior?.frontmatter, item.date, item.entries, item.output.projects, item.output.tags), renderItems(item.output)), preHash: existsSync(digestFile) ? contentHash(readFileSync(digestFile, "utf8")) : null });
  const state: ConsolidationState = { version: 1, processedIdentities: [...new Set([...coverage, ...item.entries.map((entry) => entry.identity)])], lastSuccessfulRun: new Date().toISOString() }, batch: PendingBatch = { files: [...files.values()], state };
  validateBatch(batch); writeAtomic(pendingPath(dir), `${JSON.stringify(batch, null, 2)}\n`); options.afterPrepare?.(); replayBatch(batch, dir, options);
  for (const entry of item.entries) coverage.add(entry.identity);
}
function pendingPath(dir: string): string { return join(dir, ".pending-consolidation.json"); }
function readDigestText(raw: string, path: string): { frontmatter: DigestFrontmatter; body: string } | undefined {
  const match = raw.replaceAll("\r\n", "\n").match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`Invalid digest frontmatter: ${path}`);
  let metadata: Partial<DigestFrontmatter> | null;
  try { metadata = parse(match[1]) as Partial<DigestFrontmatter> | null; }
  catch (error) { throw new Error(`Invalid digest YAML: ${path}`, { cause: error }); }
  if (!metadata || metadata.type !== "digest" || typeof metadata.date !== "string" || metadata.derived !== true || !Array.isArray(metadata.projects) || metadata.projects.some((item) => typeof item !== "string") || !Array.isArray(metadata.tags) || metadata.tags.some((item) => typeof item !== "string") || !Array.isArray(metadata.sources) || metadata.sources.some((source) => !source || typeof source.sessionId !== "string" || !Array.isArray(source.entryIds) || source.entryIds.some((id) => typeof id !== "string"))) throw new Error(`Invalid digest metadata: ${path}`);
  return { frontmatter: metadata as DigestFrontmatter, body: match[2] };
}
function contentHash(content: string): string { return createHash("sha256").update(content).digest("hex"); }
function validateBatch(batch: PendingBatch): void {
  if (!batch || !Array.isArray(batch.files) || !batch.state || batch.state.version !== 1) { if (batch && ("operations" in batch || "digests" in batch)) throw new Error("Unsupported old operations-format pending journal; remove it only after reviewing its recovery state"); throw new Error("Invalid pending consolidation journal"); }
  validateState(batch.state, "Invalid pending consolidation state");
  for (const file of batch.files) if (!file || typeof file.path !== "string" || file.path.startsWith("/") || file.path.split(/[\\/]/).includes("..") || typeof file.content !== "string" || !(file.preHash === null || typeof file.preHash === "string")) throw new Error("Invalid pending journal file");
}
function replayBatch(batch: PendingBatch, dir: string, options: ConsolidateOptions): void {
  validateBatch(batch); let outputIndex = 0;
  for (const file of batch.files) {
    const path = join(dir, file.path), current = existsSync(path) ? readFileSync(path, "utf8") : undefined, kind = file.path.startsWith("digests/") ? "digest" : "record";
    if (current !== undefined && contentHash(current) === contentHash(file.content)) { options.afterOutputWrite?.(kind, ++outputIndex); continue; }
    if ((current === undefined ? null : contentHash(current)) !== file.preHash) throw new Error(`File edited since prepare; re-run after review: ${file.path}`);
    writeAtomic(path, file.content); if (kind === "digest") options.afterDigestWrite?.(file.path.slice("digests/".length).replace(/\.md$/, ""));
    options.afterOutputWrite?.(kind, ++outputIndex);
  }
  writeAtomic(join(dir, "state.json"), `${JSON.stringify(batch.state, null, 2)}\n`); options.afterOutputWrite?.("state", ++outputIndex); rmSync(pendingPath(dir), { force: true });
}
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function lockDiagnostic(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  let ownerPid: number | "unknown" = "unknown";
  try {
    const pid = (JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid;
    if (Number.isInteger(pid) && (pid as number) > 0) ownerPid = pid as number;
  } catch { /* An unreadable lock has an unknown owner. */ }
  return `Lock exists at ${path} (owner PID ${ownerPid}); remove it if no run is active: rm -f -- ${shellQuote(path)}`;
}
function acquireLock(dir: string): () => void {
  const path = join(dir, ".consolidate.lock");
  let fd: number;
  try { fd = openSync(path, "wx"); }
  catch (error) {
    const diagnostic = lockDiagnostic(path);
    if (diagnostic) throw new Error(diagnostic);
    throw new Error(`Cannot create consolidation lock ${path}`, { cause: error });
  }
  try { writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() })); }
  catch (error) {
    try { closeSync(fd); } finally { rmSync(path, { force: true }); }
    throw error;
  }
  try { closeSync(fd); } catch (error) { rmSync(path, { force: true }); throw error; }
  return () => rmSync(path, { force: true });
}

export interface ConsolidationStatus { lastSuccessfulRun: string | null; outstandingNewProcessable: number; deferredUnfinished: number; limitDeferred: number; commitments?: Record<"open" | "in-progress" | "blocked" | "deferred", number>; lock?: string; pendingBatch?: string }
function readLastSuccessfulRun(dir: string): string | null {
  let lastSuccessfulRun: string | null = null;
  const statePath = join(dir, "state.json");
  if (existsSync(statePath)) {
    try { const state = JSON.parse(readFileSync(statePath, "utf8")) as ConsolidationState; validateState(state, `Invalid state file: ${statePath}`); lastSuccessfulRun = state.lastSuccessfulRun; } catch { throw new Error(`Invalid state file: ${statePath}`); }
  }
  return lastSuccessfulRun;
}
function statusFrom(plan: SpanPlan, lastSuccessfulRun: string | null, dir?: string): ConsolidationStatus {
  const status: ConsolidationStatus = { lastSuccessfulRun, outstandingNewProcessable: plan.processableCount, deferredUnfinished: plan.deferredUnfinished.length, limitDeferred: plan.limitDeferredCount };
  if (dir) {
    const counts = { open: 0, "in-progress": 0, blocked: 0, deferred: 0 };
    for (const record of loadRecordIndex(dir).commitments.values()) if (record.metadata.status in counts) counts[record.metadata.status as keyof typeof counts]++;
    status.commitments = counts;
    if (existsSync(pendingPath(dir))) status.pendingBatch = pendingPath(dir);
  }
  return status;
}
export function getConsolidationStatus(options: Pick<ConsolidateOptions, "sessionsDir" | "memoryDir" | "maxEntries"> = {}): ConsolidationStatus {
  resetRecordWarnings();
  const dir = resolveMemoryDir(options.memoryDir);
  const snapshot = readTranscriptSnapshot(options.sessionsDir);
  const plan = planTranscriptSpans(snapshot, coverageFrom(dir, snapshot), options.maxEntries ?? 80);
  const status = statusFrom(plan, readLastSuccessfulRun(dir), dir);
  const lock = lockDiagnostic(join(dir, ".consolidate.lock"));
  return lock ? { ...status, lock } : status;
}
export function planSummary(plan: SpanPlan): string[] { return plan.spans.map((span) => `${span.date}: ${[...new Set(span.entries.map((entry) => entry.sessionId))].join(", ")} — ${span.entries[0]?.id}..${span.entries.at(-1)?.id} (${span.entries.length} entries)`); }

export async function consolidate(options: ConsolidateOptions = {}): Promise<{ plan: string[]; status: ConsolidationStatus }> {
  const dir = resolveMemoryDir(options.memoryDir);
  const snapshot = readTranscriptSnapshot(options.sessionsDir);
  const limit = options.maxEntries ?? 80;
  const lastSuccessfulRun = readLastSuccessfulRun(dir);
  if (options.dryRun) {
    const plan = planTranscriptSpans(snapshot, coverageFrom(dir, snapshot), limit);
    return { plan: planSummary(plan), status: statusFrom(plan, lastSuccessfulRun) };
  }
  mkdirSync(dir, { recursive: true });
  const unlock = acquireLock(dir);
  resetRecordWarnings();
  const handleSignal = () => {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    unlock();
    process.exit(1);
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);
  try {
    mkdirSync(join(dir, "digests"), { recursive: true });
    const pending = pendingPath(dir);
    if (existsSync(pending)) {
      let batch: PendingBatch;
      try { batch = JSON.parse(readFileSync(pending, "utf8")) as PendingBatch; } catch (error) { throw new Error(`Invalid pending consolidation batch: ${pending}`, { cause: error }); }
      replayBatch(batch, dir, options);
    }
    const currentCoverage = coverageFrom(dir, snapshot);
    const plan = planTranscriptSpans(snapshot, currentCoverage, limit);
    const summary = planSummary(plan);
    if (!options.model && plan.spans.length) throw new Error("A model adapter is required when new entries are available");
    let processedCount = 0;
    const priors = new Map(plan.spans.map((span) => [span.date, readDigest(digestPath(dir, span.date))]));
    for (const span of [...plan.spans].sort((a, b) => a.date.localeCompare(b.date))) {
      const prior = priors.get(span.date);
      const activityDays = [...new Set(readdirSync(join(dir, "digests"), { withFileTypes: true }).filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name)).map((entry) => entry.name.slice(0, 10)))].filter((date) => date <= span.date).sort().slice(-2);
      const recordIndex = loadRecordIndex(dir); const recordContext = buildRecordContext(recordIndex, span.date, activityDays);
      const prompt = buildPrompt(span, span.context, prior?.body ?? "", prior?.frontmatter.sources.flatMap((source) => source.entryIds.map((entryId) => `${source.sessionId}/${entryId}`)) ?? [], recordContext);
      let lastValidationError: Error | undefined;
      let accepted: { digest: DigestOutput; files: Array<{ path: string; content: string; preHash: string | null }> } | undefined;
      let validationAttempt = false, providerRetry = false;
      while (!accepted) {
        const attemptPrompt = validationAttempt ? `${prompt}\n\nValidation correction: return the complete corrected strict JSON envelope. Validation error: ${lastValidationError!.message}` : prompt;
        let raw: string;
        try { raw = await options.model!.consolidate(attemptPrompt); }
        catch (error) {
          const name = (error as Error)?.name, message = String((error as Error)?.message ?? error);
          if (!providerRetry && (name === "TimeoutError" || name === "AbortError" || /stream aborted|timed? out|timeout/i.test(message) || /configured model did not complete normally \(aborted(?:[:)]|$)/i.test(message))) { providerRetry = true; continue; }
          throw error;
        }
        const candidateIndex = loadRecordIndex(dir), originalRaw = new Map([...candidateIndex.episodes.values(), ...candidateIndex.commitments.values()].map((record) => [record.path, record.raw]));
        try {
          const envelope = parseOutput(raw, span, prior?.frontmatter);
          const spanOperations = prepareOperations(envelope.operations, span, candidateIndex), renderedFiles = new Map<string, { path: string; content: string; preHash: string | null }>();
          for (const operation of spanOperations) {
            const rendered = renderOperation(candidateIndex, operation);
            if (rendered) {
              const path = isAbsolute(rendered.path) ? rendered.path : join(dir, rendered.path), key = relative(dir, path), previous = renderedFiles.get(key);
              renderedFiles.set(key, { path: key, content: rendered.content, preHash: previous ? previous.preHash : (originalRaw.has(path) ? contentHash(originalRaw.get(path)!) : null) });
              advanceOperation(candidateIndex, operation, rendered);
            }
          }
          accepted = { digest: envelope.digest, files: [...renderedFiles.values()] };
          break;
        } catch (error) {
          if (validationAttempt) throw error;
          lastValidationError = error as Error; validationAttempt = true;
        }
      }
      const committedSpan = { date: span.date, output: accepted.digest, entries: span.entries, files: accepted.files, ...(prior ? { prior } : {}) };
      persistSpan(dir, committedSpan, currentCoverage, options); processedCount += span.entries.length;
    }
    const remainingCount = plan.processableCount - processedCount;
    const status: ConsolidationStatus = { ...statusFrom({ ...plan, processableCount: remainingCount, limitDeferredCount: Math.max(0, remainingCount - limit) }, readLastSuccessfulRun(dir), dir) };
    return { plan: summary, status };
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    unlock();
  }
}
