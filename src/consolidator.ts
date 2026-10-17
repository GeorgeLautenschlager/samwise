import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { planTranscriptSpans, readTranscriptSnapshot, type PlannedSpan, type SpanPlan, type TranscriptEntry } from "./transcript.ts";

export interface DigestItem { label: "stated" | "observed" | "inferred"; text: string; citations: string[] }
export interface DigestOutput { projects: string[]; tags: string[]; sections: Record<string, DigestItem[]> }
export interface ModelAdapter { consolidate(prompt: string): Promise<string> }
export interface ConsolidateOptions { sessionsDir?: string; memoryDir?: string; maxEntries?: number; dryRun?: boolean; model?: ModelAdapter; afterDigestWrite?: (date: string) => void }
interface DigestFrontmatter { type: "digest"; date: string; derived: true; projects: string[]; tags: string[]; sources: Array<{ sessionId: string; entryIds: string[] }> }
interface ConsolidationState { version: 1; processedIdentities: string[]; lastSuccessfulRun: string | null }
const headings = ["Work undertaken", "Outcomes", "Significant decisions", "Changes of plan and interruptions", "Carry-forward items"] as const;

export function resolveMemoryDir(memoryDir?: string): string {
  return memoryDir || (process.env.SAMWISE_MEMORY_DIR ? process.env.SAMWISE_MEMORY_DIR : undefined) || join(homedir(), ".samwise", "memory");
}
function digestPath(dir: string, date: string): string { return join(dir, "digests", `${date}.md`); }
function readDigest(path: string): { frontmatter: DigestFrontmatter; body: string } | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error(`Invalid digest frontmatter: ${path}`);
  const metadata = parse(match[1]) as DigestFrontmatter;
  if (metadata.type !== "digest" || !Array.isArray(metadata.sources) || metadata.sources.some((source) => !source || typeof source.sessionId !== "string" || !Array.isArray(source.entryIds) || source.entryIds.some((id) => typeof id !== "string"))) throw new Error(`Invalid digest metadata: ${path}`);
  return { frontmatter: metadata, body: match[2] };
}
function coverageFrom(dir: string, snapshot: ReturnType<typeof readTranscriptSnapshot>): Set<string> {
  const identities = new Set<string>();
  const statePath = join(dir, "state.json");
  if (existsSync(statePath)) {
    let state: ConsolidationState;
    try { state = JSON.parse(readFileSync(statePath, "utf8")) as ConsolidationState; } catch { throw new Error(`Invalid state file: ${statePath}`); }
    if (state.version !== 1 || !Array.isArray(state.processedIdentities) || state.processedIdentities.some((id) => typeof id !== "string")) throw new Error(`Invalid state file: ${statePath}`);
    for (const identity of state.processedIdentities) identities.add(identity);
  }
  const bySource = new Map(snapshot.entries.map((entry) => [`${entry.sessionId}\\0${entry.id}`, entry.identity]));
  const directory = join(dir, "digests");
  if (existsSync(directory)) for (const name of readdirSync(directory)) if (name.endsWith(".md")) {
    for (const source of readDigest(join(directory, name))?.frontmatter.sources ?? []) for (const id of source.entryIds) {
      const identity = bySource.get(`${source.sessionId}\\0${id}`);
      if (identity) identities.add(identity);
    }
  }
  return identities;
}

function contextEntry(entry: TranscriptEntry): string {
  const id = `${entry.sessionId}/${entry.id}`;
  return JSON.stringify({ source: id, role: entry.role, text: entry.text, toolCalls: entry.toolCalls, toolResults: entry.toolResults, branch: entry.abandoned ? "abandoned exploration (not adopted unless explicitly stated)" : "active" });
}
export function buildPrompt(span: PlannedSpan, context: TranscriptEntry[], priorBody = "", priorSources: string[] = []): string {
  const sessionPairs = [...new Set([...priorSources, ...span.entries.map((entry) => `${entry.sessionId}/${entry.id}`)])];
  return [
    "Create a concise daily memory from the new transcript entries. Return JSON only with shape {projects:string[],tags:string[],sections:{<exact heading>: [{label:'stated'|'observed'|'inferred',text:string,citations:string[]}]}}.",
    `Include all headings: ${headings.join("; ")}. Cite only source IDs exactly as listed below (session-id/entry-id). Use labels stated for George's explicit claims, observed for transcript/tool evidence, inferred for clearly tentative interpretation. Preserve uncertainty. NEVER infer mental causes or diagnose. Distinguish explored/abandoned approaches from adopted decisions. The source-derived prior context is not new evidence.`,
    `Required citations: ${sessionPairs.join(", ")}`,
    "Revise the existing digest together with the new entries. Return the complete replacement digest, not an append-only update. Existing digest is derived material, not fresh evidence. Context-only entries may aid interpretation but cannot support new claims.",
    "Existing digest (may be corrected; its cited source references remain eligible):", priorBody || "(none)",
    "Prior context (interpretation only):", ...context.map(contextEntry), "New entries:", ...span.entries.map(contextEntry),
  ].join("\n");
}
function parseOutput(raw: string, span: PlannedSpan, prior: DigestFrontmatter | undefined): DigestOutput {
  const value = JSON.parse(raw) as Partial<DigestOutput>;
  if (!value || !Array.isArray(value.projects) || !Array.isArray(value.tags) || !value.sections || typeof value.sections !== "object") throw new Error("Model returned invalid digest JSON");
  const priorSources = prior?.sources.flatMap((source) => source.entryIds.map((entryId) => `${source.sessionId}/${entryId}`)) ?? [];
  const allowed = new Set([...priorSources, ...span.entries.map((entry) => `${entry.sessionId}/${entry.id}`)]);
  const sections: Record<string, DigestItem[]> = {};
  for (const heading of headings) {
    const items = value.sections[heading];
    if (!Array.isArray(items)) throw new Error(`Model omitted section: ${heading}`);
    sections[heading] = items.map((item) => {
      if (!item || !["stated", "observed", "inferred"].includes(item.label) || typeof item.text !== "string" || !Array.isArray(item.citations) || item.citations.length === 0 || item.citations.some((citation) => typeof citation !== "string" || !allowed.has(citation))) throw new Error(`Model returned invalid item/citation in ${heading}`);
      return { label: item.label, text: item.text, citations: item.citations };
    });
  }
  if (Object.keys(value.sections).some((heading) => !(headings as readonly string[]).includes(heading))) throw new Error("Model returned an unknown section");
  if (value.projects.some((project) => typeof project !== "string") || value.tags.some((tag) => typeof tag !== "string")) throw new Error("Model returned invalid projects or tags");
  return { projects: value.projects as string[], tags: value.tags as string[], sections };
}
function renderItems(output: DigestOutput): string {
  return headings.map((heading) => {
    const items = output.sections[heading].map((item) => `- **${item.label}** ${item.text} — [${item.citations.join(", ")}]`).join("\n");
    return `## ${heading}\n${items || "- None recorded."}`;
  }).join("\n\n");
}
function writeAtomic(path: string, content: string): void {
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
interface LockDiagnostic { path: string; ownerPid: number | null; ownerAlive: boolean | null; removeCommand: string }
function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function lockDiagnostic(path: string): LockDiagnostic | undefined {
  if (!existsSync(path)) return undefined;
  let ownerPid: number | null = null;
  let ownerAlive: boolean | null = null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    if (Number.isInteger(data.pid) && (data.pid as number) > 0) {
      ownerPid = data.pid as number;
      try { process.kill(ownerPid, 0); ownerAlive = true; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        ownerAlive = code === "EPERM" ? true : code === "ESRCH" ? false : null;
      }
    }
  } catch { /* Unknown/unreadable lock owners are never assumed dead. */ }
  return { path, ownerPid, ownerAlive, removeCommand: `rm -f -- ${shellQuote(path)}` };
}
function lockError(diagnostic: LockDiagnostic): Error {
  const owner = diagnostic.ownerPid === null ? "unknown owner PID" : `owner PID ${diagnostic.ownerPid}`;
  const alive = diagnostic.ownerAlive === null ? "alive status unknown" : diagnostic.ownerAlive ? "PID alive" : "PID not alive";
  return new Error(`Consolidation lock exists at ${diagnostic.path} (${owner}; ${alive}). If the owner is gone, remove it with: ${diagnostic.removeCommand}`);
}
function acquireLock(dir: string): () => void {
  const path = join(dir, ".consolidate.lock");
  let fd: number;
  try { fd = openSync(path, "wx"); }
  catch (error) {
    const diagnostic = lockDiagnostic(path);
    if (diagnostic) throw lockError(diagnostic);
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

export interface ConsolidationStatus { lastSuccessfulRun: string | null; outstandingNewProcessable: number; deferredUnfinished: number; limitDeferred: number; lock?: LockDiagnostic }
function readLastSuccessfulRun(dir: string): string | null {
  let lastSuccessfulRun: string | null = null;
  const statePath = join(dir, "state.json");
  if (existsSync(statePath)) {
    try { const state = JSON.parse(readFileSync(statePath, "utf8")) as ConsolidationState; if (state.version !== 1 || !Array.isArray(state.processedIdentities)) throw new Error(); lastSuccessfulRun = typeof state.lastSuccessfulRun === "string" ? state.lastSuccessfulRun : null; } catch { throw new Error(`Invalid state file: ${statePath}`); }
  }
  return lastSuccessfulRun;
}
function statusFrom(snapshot: ReturnType<typeof readTranscriptSnapshot>, coverage: ReadonlySet<string>, maxEntries: number, lastSuccessfulRun: string | null): ConsolidationStatus {
  const plan = planTranscriptSpans(snapshot, coverage, maxEntries);
  const allCandidates = planTranscriptSpans(snapshot, coverage, Number.MAX_SAFE_INTEGER);
  const processableKeys = new Set(allCandidates.spans.flatMap((span) => span.entries.map((entry) => entry.identity)));
  const deferredKeys = new Set(plan.deferredUnfinished.map((entry) => entry.identity).filter((identity) => !coverage.has(identity) && !processableKeys.has(identity)));
  return { lastSuccessfulRun, outstandingNewProcessable: plan.processableCount, deferredUnfinished: deferredKeys.size, limitDeferred: plan.limitDeferredCount };
}
export function getConsolidationStatus(options: Pick<ConsolidateOptions, "sessionsDir" | "memoryDir" | "maxEntries"> = {}): ConsolidationStatus {
  const dir = resolveMemoryDir(options.memoryDir);
  const snapshot = readTranscriptSnapshot(options.sessionsDir);
  const status = statusFrom(snapshot, coverageFrom(dir, snapshot), options.maxEntries ?? 200, readLastSuccessfulRun(dir));
  const lock = lockDiagnostic(join(dir, ".consolidate.lock"));
  return lock ? { ...status, lock } : status;
}
export function planSummary(plan: SpanPlan): string[] { return plan.spans.map((span) => `${span.date}: ${[...new Set(span.entries.map((entry) => entry.sessionId))].join(", ")} — ${span.entries[0]?.id}..${span.entries.at(-1)?.id} (${span.entries.length} entries)`); }

export async function consolidate(options: ConsolidateOptions = {}): Promise<{ plan: string[]; status: ConsolidationStatus }> {
  const dir = resolveMemoryDir(options.memoryDir);
  const snapshot = readTranscriptSnapshot(options.sessionsDir);
  const plan = planTranscriptSpans(snapshot, coverageFrom(dir, snapshot), options.maxEntries ?? 200);
  const summary = planSummary(plan);
  const existingCoverage = coverageFrom(dir, snapshot);
  const lastSuccessfulRun = readLastSuccessfulRun(dir);
  if (options.dryRun) return { plan: summary, status: statusFrom(snapshot, existingCoverage, options.maxEntries ?? 200, lastSuccessfulRun) };
  if (!options.model && plan.spans.length) throw new Error("A model adapter is required when new entries are available");
  mkdirSync(dir, { recursive: true });
  const unlock = acquireLock(dir);
  try {
    mkdirSync(join(dir, "digests"), { recursive: true });
    // Re-read coverage under lock. Model output for every date is obtained before the first write.
    const currentCoverage = coverageFrom(dir, snapshot);
    const lockedPlan = planTranscriptSpans(snapshot, currentCoverage, options.maxEntries ?? 200);
    const prepared = [] as Array<{ date: string; output: DigestOutput; entries: TranscriptEntry[]; prior?: { frontmatter: DigestFrontmatter; body: string } }>;
    for (const span of lockedPlan.spans) {
      const prior = readDigest(digestPath(dir, span.date));
      const raw = await options.model!.consolidate(buildPrompt(span, lockedPlan.context, prior?.body ?? "", prior?.frontmatter.sources.flatMap((source) => source.entryIds.map((entryId) => `${source.sessionId}/${entryId}`)) ?? []));
      const output = parseOutput(raw, span, prior?.frontmatter);
      prepared.push({ date: span.date, output, entries: span.entries, ...(prior ? { prior } : {}) });
    }
    for (const item of prepared) {
      const metadata = frontmatter(item.prior?.frontmatter, item.date, item.entries, item.output.projects, item.output.tags);
      const body = renderItems(item.output);
      writeAtomic(digestPath(dir, item.date), renderDigest(metadata, body));
      options.afterDigestWrite?.(item.date);
    }
    const statePath = join(dir, "state.json");
    const resultingCoverage = new Set(currentCoverage);
    for (const item of prepared) for (const entry of item.entries) resultingCoverage.add(entry.identity);
    const state: ConsolidationState = { version: 1, processedIdentities: [...resultingCoverage], lastSuccessfulRun: new Date().toISOString() };
    const status = statusFrom(snapshot, resultingCoverage, options.maxEntries ?? 200, state.lastSuccessfulRun);
    writeAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
    return { plan: summary, status };
  } finally { unlock(); }
}
