import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export interface TranscriptEntry {
  id: string;
  parentId: string | null;
  timestamp: string;
  role: string;
  sessionId: string;
  stopReason?: string;
  text: string;
  toolCalls: Array<{ name: string; args: string }>;
  toolResults: string[];
  identity: string;
  abandoned: boolean;
  sessionAbandoned: boolean;
  sessionPath: string;
}

export interface SessionSnapshot {
  path: string;
  sessionId: string;
  size: number;
  entries: TranscriptEntry[];
}

export interface TranscriptSnapshot {
  startedAt: string;
  sessions: SessionSnapshot[];
  entries: TranscriptEntry[];
  incompleteTailCount: number;
}

type RawEntry = Record<string, unknown> & { id?: unknown; parentId?: unknown; timestamp?: unknown; type?: unknown; message?: unknown };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function walk(directory: string, root: string, result: string[]): void {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    if (item.name === "subagent-artifacts" || item.name.startsWith("run-")) continue;
    const path = join(directory, item.name);
    if (item.isDirectory()) walk(path, root, result);
    else if (item.isFile() && item.name.endsWith(".jsonl") && !(item.name === "session.jsonl" && relative(root, path).split(/[\\/]/).length > 1)) result.push(path);
  }
}

export function discoverSessionFiles(directory = join(process.env.HOME ?? "", ".pi", "agent", "sessions")): string[] {
  const root = resolve(directory);
  const result: string[] = [];
  walk(root, root, result);
  return result.sort();
}

function content(entry: RawEntry): Pick<TranscriptEntry, "role" | "stopReason" | "text" | "toolCalls" | "toolResults"> {
  const message = entry.message && typeof entry.message === "object" ? entry.message as Record<string, unknown> : {};
  const blocks = Array.isArray(message.content) ? message.content as Array<Record<string, unknown>> : [];
  const text: string[] = [];
  const toolCalls: TranscriptEntry["toolCalls"] = [];
  const toolResults: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") text.push(block.text);
    if (block.type === "toolCall") toolCalls.push({ name: String(block.name ?? "tool"), args: abbreviated(block.arguments) });
    if (block.type === "toolResult") toolResults.push(abbreviated(block.content));
  }
  if (message.role === "toolResult") toolResults.push(abbreviated(`${String(message.toolName ?? "tool")}: ${abbreviated(message.content)}`));
  return {
    role: typeof message.role === "string" ? message.role : "event",
    ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
    text: message.role === "toolResult" ? "" : text.join("\n"), toolCalls, toolResults,
  };
}

function abbreviated(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else if (Array.isArray(value)) text = value.map((part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "text" ? String((part as Record<string, unknown>).text ?? "") : "[non-text]").join(" ");
  else text = canonical(value);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

function isProcessable(entry: TranscriptEntry): boolean {
  return entry.role === "user" || entry.role === "assistant" || entry.role === "toolResult";
}

function localDate(timestamp: string): string {
  if (!timestamp) return "unknown-date";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "unknown-date";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isDescendant(entry: TranscriptEntry, ancestor: TranscriptEntry, session: TranscriptEntry[]): boolean {
  const byId = new Map(session.map((candidate) => [candidate.id, candidate]));
  let parentId = entry.parentId;
  while (parentId !== null) {
    if (parentId === ancestor.id) return true;
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  return false;
}

function completedAssistant(entry: TranscriptEntry): boolean {
  // Pi uses stop for normal completion; toolUse means the assistant turn is still in flight.
  return entry.role === "assistant" && ["stop", "end_turn"].includes(entry.stopReason ?? "");
}

function readSession(path: string, size: number): { entries: TranscriptEntry[]; incomplete: number; sessionId: string } {
  const bytes = readFileSync(path).subarray(0, size);
  const lastNewline = bytes.lastIndexOf(10);
  const complete = lastNewline < 0 ? Buffer.alloc(0) : bytes.subarray(0, lastNewline + 1);
  const tail = bytes.subarray(lastNewline + 1);
  const rows = complete.toString("utf8").split("\n").filter(Boolean);
  const parsed: RawEntry[] = rows.map((line, index) => {
    try { return JSON.parse(line) as RawEntry; }
    catch (error) { throw new Error(`Malformed JSONL in ${path} at complete line ${index + 1}`, { cause: error }); }
  });
  const header = parsed.find((entry) => entry.type === "session");
  const sessionId = typeof header?.id === "string" ? header.id : path;
  const records = parsed.filter((entry) => typeof entry.id === "string" && (entry.parentId === null || typeof entry.parentId === "string"));
  const children = new Set(records.map((entry) => entry.parentId).filter((id): id is string => typeof id === "string"));
  const leaf = [...records].reverse().find((entry) => typeof entry.id === "string" && !children.has(entry.id)) ?? records.at(-1);
  const byId = new Map(records.map((entry) => [entry.id as string, entry]));
  const ancestry = new Set<string>();
  for (let node = leaf; node && typeof node.id === "string"; node = typeof node.parentId === "string" ? byId.get(node.parentId) : undefined) ancestry.add(node.id);
  const entries = records.map((raw) => {
    const formatted = content(raw);
    // Identity tracks the semantic Pi message record; parentId and clone labels are structural metadata.
    const semanticRecord = { id: raw.id, timestamp: raw.timestamp, type: raw.type, message: raw.message };
    const hash = createHash("sha256").update(canonical(semanticRecord)).digest("hex");
    return {
      id: raw.id as string,
      parentId: typeof raw.parentId === "string" ? raw.parentId : null,
      timestamp: typeof raw.timestamp === "string" ? raw.timestamp : "",
      ...formatted,
      identity: `${raw.id}:${hash}`,
      abandoned: !ancestry.has(raw.id as string),
      sessionAbandoned: !ancestry.has(raw.id as string),
      sessionId,
      sessionPath: path,
    };
  });
  return { entries, incomplete: tail.length > 0 ? 1 : 0, sessionId };
}

export function readTranscriptSnapshot(directory?: string): TranscriptSnapshot {
  const paths = discoverSessionFiles(directory);
  // Freeze every file's byte boundary before opening any transcript.
  const boundaries = paths.map((path) => ({ path, size: statSync(path).size }));
  const loaded = boundaries.map(({ path, size }) => ({ path, size, ...readSession(path, size) }));
  const active = new Set(loaded.flatMap((session) => session.entries.filter((entry) => !entry.abandoned).map((entry) => entry.identity)));
  for (const session of loaded) for (const entry of session.entries) if (active.has(entry.identity)) entry.abandoned = false;
  return {
    startedAt: new Date().toISOString(),
    sessions: loaded.map(({ path, size, entries, sessionId }) => ({ path, size, entries, sessionId })),
    entries: loaded.flatMap((session) => session.entries),
    incompleteTailCount: loaded.reduce((total, session) => total + session.incomplete, 0),
  };
}

export interface PlannedSpan {
  date: string;
  entries: TranscriptEntry[];
}

export interface SpanPlan {
  spans: PlannedSpan[];
  context: TranscriptEntry[];
  deferredUnfinished: TranscriptEntry[];
  abandonedCount: number;
  coveredCount: number;
  processableCount: number;
  limitDeferredCount: number;
}

export function planTranscriptSpans(snapshot: TranscriptSnapshot, coveredEntryKeys: ReadonlySet<string> = new Set(), limit = 200): SpanPlan {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
  const entries = snapshot.entries;
  const sessionEntries = entries;
  const deferredUnfinished: TranscriptEntry[] = [];
  const sessions = new Map<string, TranscriptEntry[]>();
  for (const entry of sessionEntries) {
    const session = sessions.get(entry.sessionPath) ?? [];
    session.push(entry);
    sessions.set(entry.sessionPath, session);
  }
  for (const session of sessions.values()) {
    const activeBranch = session.filter((entry) => !entry.sessionAbandoned);
    const lastUser = activeBranch.map((entry, index) => entry.role === "user" ? index : -1).filter((index) => index >= 0).at(-1);
    if (lastUser === undefined) continue;
    const user = activeBranch[lastUser];
    const descendants = activeBranch.filter((entry) => isDescendant(entry, user, session));
    if (!descendants.some(completedAssistant)) deferredUnfinished.push(user, ...descendants.filter(isProcessable));
  }
  const unfinishedOccurrences = new Set(deferredUnfinished.map((entry) => `${entry.sessionPath}\0${entry.identity}`));
  const availableByIdentity = new Map<string, TranscriptEntry>();
  for (const entry of sessionEntries) if (isProcessable(entry) && !unfinishedOccurrences.has(`${entry.sessionPath}\0${entry.identity}`)) availableByIdentity.set(entry.identity, entry);
  const available = [...availableByIdentity.values()];
  const candidates = available.filter((entry) => !coveredEntryKeys.has(entry.identity));
  const selected = candidates.slice(0, limit);
  const contexts: TranscriptEntry[] = [];
  const bySessionId = new Map<string, TranscriptEntry[]>();
  for (const entry of entries) {
    const session = bySessionId.get(entry.sessionPath) ?? [];
    session.push(entry);
    bySessionId.set(entry.sessionPath, session);
  }
  const contextIdentities = new Set<string>();
  for (const selectedEntry of selected) {
    const ancestry: TranscriptEntry[] = [];
    const session = bySessionId.get(selectedEntry.sessionPath) ?? [];
    let parentId = selectedEntry.parentId;
    while (parentId !== null) {
      const parent = session.find((entry) => entry.id === parentId);
      if (!parent) break;
      if (isProcessable(parent) && coveredEntryKeys.has(parent.identity)) ancestry.push(parent);
      parentId = parent.parentId;
    }
    for (const parent of ancestry.reverse().slice(-8)) if (!contextIdentities.has(parent.identity)) {
      contexts.push(parent);
      contextIdentities.add(parent.identity);
    }
  }
  const spans = new Map<string, TranscriptEntry[]>();
  for (const entry of selected) {
    const date = localDate(entry.timestamp);
    const group = spans.get(date) ?? [];
    group.push(entry);
    spans.set(date, group);
  }
  return {
    spans: [...spans].map(([date, spanEntries]) => ({ date, entries: spanEntries })),
    context: contexts,
    deferredUnfinished,
    abandonedCount: entries.filter((entry) => entry.abandoned).length,
    coveredCount: entries.filter((entry) => coveredEntryKeys.has(entry.identity)).length,
    processableCount: candidates.length,
    limitDeferredCount: candidates.length - selected.length,
  };
}
