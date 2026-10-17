import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";

export interface DigestItem { label: "stated" | "observed" | "inferred"; text: string; citations: string[] }
export interface RecordSource { sessionId: string; entryIds: string[] }
export interface Episode {
  type: "episode"; id: string; title: string; status: "open" | "resolved" | "abandoned"; started: string; updated: string;
  projects: string[]; tags: string[]; derived: true; sources: RecordSource[];
}
export interface Commitment {
  type: "commitment"; id: string; title: string; kind: "request" | "commitment"; owner: string; requested_by: string;
  due?: string; status: "open" | "in-progress" | "blocked" | "deferred" | "done" | "cancelled";
  blocked_on?: string; depends_on?: string; next_action: string; projects: string[]; created: string; updated: string;
  derived: true; sources: RecordSource[];
}
export type RecordMetadata = Episode | Commitment;
export type EpisodeFields = Pick<Episode, "title" | "status" | "started" | "updated" | "projects" | "tags" | "sources">;
export type CommitmentFields = Omit<Commitment, "type" | "id" | "derived" | "sources">;
export interface EpisodeCreate { kind: "create-episode"; recordId: string; filenameDate: string; spanSources: RecordSource[]; localKey: string; fields: EpisodeFields; sections: Record<string, DigestItem[]> }
export interface EpisodeUpdate { kind: "update-episode"; spanSources: RecordSource[]; earliestCitedDate: string; id: string; updated: string; fields?: Partial<Pick<Episode, "title" | "status" | "projects" | "tags">>; sections?: Record<string, DigestItem[]> }
export interface CommitmentChange { field: string; value: string | string[] | null; label: DigestItem["label"]; citations: string[] }
export interface CommitmentCreate { kind: "create-commitment"; recordId: string; spanSources: RecordSource[]; localKey: string; fields: CommitmentFields; description: DigestItem }
export interface CommitmentUpdate { kind: "update-commitment"; spanSources: RecordSource[]; id: string; updated: string; changes: CommitmentChange[] }
export type RecordOperation = EpisodeCreate | EpisodeUpdate | CommitmentCreate | CommitmentUpdate;
type Indexed<T extends RecordMetadata> = { path: string; metadata: T; body: string; raw: string };
export interface RecordIndex { episodes: Map<string, Indexed<Episode>>; commitments: Map<string, Indexed<Commitment>>; invalidIds: Set<string>; occupiedPaths: Set<string> }
export interface RecordContext { commitments: Array<Pick<Commitment, "id" | "title" | "status" | "owner" | "next_action">>; episodes: Array<{ id: string; title: string; summary: string; currentText: string }> }
const episodeStatuses = ["open", "resolved", "abandoned"] as const;
const commitmentStatuses = ["open", "in-progress", "blocked", "deferred", "done", "cancelled"] as const;
const terminalCommitments = new Set(["done", "cancelled"]);
const headings = ["Problem", "Constraints", "Alternatives considered", "Reasoning and decision", "Changes of understanding", "Outcome", "Unresolved questions"] as const;
const semanticCommitmentFields = ["title", "kind", "owner", "requested_by", "due", "status", "blocked_on", "depends_on", "next_action", "projects"] as const;
const warnedRecords = new Set<string>(); export function resetRecordWarnings(): void { warnedRecords.clear(); } function warnRecordOnce(key: string, message: string): void { if (!warnedRecords.has(key)) { warnedRecords.add(key); console.warn(message); } }
function exactKeys(value: any, allowed: readonly string[]): boolean { return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key)); }
function validDate(value: unknown): value is string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(`${value}T00:00:00Z`); return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value; }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every((item) => typeof item === "string"); }
function sources(value: unknown): value is RecordSource[] { return Array.isArray(value) && value.every((source) => exactKeys(source, ["sessionId", "entryIds"]) && typeof source.sessionId === "string" && strings(source.entryIds)); }
function digestItem(item: unknown): item is DigestItem { const value = item as any; return exactKeys(value, ["label", "text", "citations"]) && ["stated", "observed", "inferred"].includes(value.label) && typeof value.text === "string" && strings(value.citations) && value.citations.length > 0; }
function isEpisode(value: any): value is Episode { return !!value && typeof value === "object" && !Array.isArray(value) && value.type === "episode" && typeof value.id === "string" && typeof value.title === "string" && episodeStatuses.includes(value.status) && validDate(value.started) && validDate(value.updated) && strings(value.projects) && strings(value.tags) && value.derived === true && sources(value.sources); }
function isCommitment(value: any): value is Commitment { return !!value && typeof value === "object" && !Array.isArray(value) && value.type === "commitment" && typeof value.id === "string" && typeof value.title === "string" && ["request", "commitment"].includes(value.kind) && typeof value.owner === "string" && typeof value.requested_by === "string" && (value.due === undefined || validDate(value.due)) && commitmentStatuses.includes(value.status) && (value.blocked_on === undefined || typeof value.blocked_on === "string") && (value.depends_on === undefined || typeof value.depends_on === "string") && typeof value.next_action === "string" && strings(value.projects) && validDate(value.created) && validDate(value.updated) && value.derived === true && sources(value.sources); }
function splitRecord(raw: string): { doc: ReturnType<typeof parseDocument>; body: string } {
  const match = raw.match(/^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)([\s\S]*)$/);
  if (!match) throw new Error("missing YAML frontmatter");
  const doc = parseDocument(match[2]);
  if (doc.errors.length) throw new Error(`invalid YAML: ${doc.errors.map((error) => error.message).join("; ")}`);
  return { doc, body: match[4] };
}
function slug(title: string): string { return title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "episode"; }
function episodeTarget(index: RecordIndex, date: string, fields: Pick<Episode, "title">): string { const base = `${date}-${slug(fields.title)}`; let suffix = 1, target = `episodes/${base}.md`; while (index.occupiedPaths.has(target)) target = `episodes/${base}-${++suffix}.md`; return target; }
function parseItem(value: unknown, allowed: Set<string>): asserts value is DigestItem { if (!digestItem(value) || value.citations.some((citation) => !allowed.has(citation))) throw new Error("Invalid item or citation outside the new span"); }
function allowedSources(spanSources: RecordSource[]): Set<string> { return new Set(spanSources.flatMap((source) => source.entryIds.map((id) => `${source.sessionId}/${id}`))); }
function validateSources(value: unknown): asserts value is RecordSource[] { if (!sources(value) || value.length === 0 || value.some((source) => source.entryIds.length === 0)) throw new Error("Invalid operation sources"); }
function validateSections(value: unknown, allowed: Set<string>): asserts value is Record<string, DigestItem[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid episode sections shape");
  for (const heading of Object.keys(value)) if (!(headings as readonly string[]).includes(heading)) throw new Error(`Invalid episode sections: unknown heading ${JSON.stringify(heading)}`);
  for (const [heading, items] of Object.entries(value)) {
    if (!Array.isArray(items)) throw new Error(`Invalid episode sections: ${heading} must be an array`);
    items.forEach((item, itemIndex) => {
      try { parseItem(item, allowed); }
      catch {
        const citations = (item as any)?.citations;
        const citation = Array.isArray(citations) ? citations.find((entry) => typeof entry !== "string" || !allowed.has(entry)) : undefined;
        if (citation !== undefined) throw new Error(`Invalid episode sections: invalid item/citation in ${heading} item ${itemIndex + 1}: unknown citation ${JSON.stringify(citation)}`);
        throw new Error(`Invalid episode sections: invalid item/citation in ${heading} item ${itemIndex + 1}`);
      }
    });
  }
}
function validateChanges(changes: CommitmentChange[], allowed: Set<string>): void {
  if (!Array.isArray(changes)) throw new Error("Invalid commitment changes");
  const fields = new Set(semanticCommitmentFields);
  const seen = new Set<string>();
  for (const change of changes) {
    if (!exactKeys(change, ["field", "value", "label", "citations"])) throw new Error("Invalid commitment change schema");
    if (seen.has(change.field)) throw new Error(`Duplicate commitment change: ${change.field}`);
    seen.add(change.field);
    if (!fields.has(change.field as never) || !(typeof change.value === "string" || strings(change.value) || change.value === null) || !["stated", "observed", "inferred"].includes(change.label) || !Array.isArray(change.citations) || !change.citations.length || change.citations.some((citation) => typeof citation !== "string" || !allowed.has(citation))) throw new Error("Invalid commitment change or citation outside the new span");
    if (change.field === "projects" ? !strings(change.value) : change.field === "due" || change.field === "blocked_on" || change.field === "depends_on" ? change.value !== null && typeof change.value !== "string" : typeof change.value !== "string") throw new Error(`Invalid commitment value for ${change.field}`);
    if (change.field === "status" && !commitmentStatuses.includes(change.value as Commitment["status"])) throw new Error("Invalid commitment status");
    if (change.field === "kind" && !["request", "commitment"].includes(change.value as string)) throw new Error("Invalid commitment kind");
    if (change.field === "due" && change.value !== null && !validDate(change.value)) throw new Error("Invalid commitment due date");
  }
}
function validateEpisodeFields(fields: any, allowedKeys: readonly string[]): boolean {
  return exactKeys(fields, allowedKeys) && Object.entries(fields).every(([key, value]) => key === "title" ? typeof value === "string" && !!value : key === "status" ? episodeStatuses.includes(value as never) : key === "started" || key === "updated" ? validDate(value) : key === "projects" || key === "tags" ? strings(value) : key === "sources" ? sources(value) : false);
}
function validCommitmentCreateFields(f: any): boolean {
  return exactKeys(f, [...semanticCommitmentFields, "created", "updated"]) && typeof f.title === "string" && !!f.title && ["request", "commitment"].includes(f.kind) && typeof f.owner === "string" && typeof f.requested_by === "string" && (f.due === undefined || validDate(f.due)) && commitmentStatuses.includes(f.status) && (f.blocked_on === undefined || typeof f.blocked_on === "string") && (f.depends_on === undefined || typeof f.depends_on === "string") && typeof f.next_action === "string" && strings(f.projects) && validDate(f.created) && validDate(f.updated);
}
export function validateOperations(operations: unknown, index: RecordIndex): asserts operations is RecordOperation[] {
  if (!Array.isArray(operations)) throw new Error("Operations must be an array");
  const virtualEpisodes = new Set(index.episodes.keys()), virtualCommitments = new Set(index.commitments.keys()), episodeKeys = new Set<string>(), commitmentKeys = new Set<string>();
  for (const raw of operations) {
    const op = raw as RecordOperation;
    if (!op || !Array.isArray(op.spanSources) || (op.kind === "create-episode" && (typeof op.filenameDate !== "string" || !validDate(op.filenameDate))) || (op.kind === "update-episode" && !validDate(op.earliestCitedDate)) || ((op.kind === "create-episode" || op.kind === "create-commitment") && (typeof op.recordId !== "string" || !op.recordId))) throw new Error("Invalid operation schema");
    const schemas: Record<string, { required: string[]; allowed: string[] }> = {
      "create-episode": { required: ["kind", "recordId", "filenameDate", "spanSources", "localKey", "fields", "sections"], allowed: ["kind", "recordId", "filenameDate", "spanSources", "localKey", "fields", "sections"] },
      "update-episode": { required: ["kind", "spanSources", "earliestCitedDate", "id", "updated"], allowed: ["kind", "spanSources", "earliestCitedDate", "id", "updated", "fields", "sections"] },
      "create-commitment": { required: ["kind", "recordId", "spanSources", "localKey", "fields", "description"], allowed: ["kind", "recordId", "spanSources", "localKey", "fields", "description"] },
      "update-commitment": { required: ["kind", "spanSources", "id", "updated", "changes"], allowed: ["kind", "spanSources", "id", "updated", "changes"] },
    };
    const schema = schemas[op.kind];
    if (!schema || !schema.required.every((key) => key in (op as any)) || !exactKeys(op, schema.allowed)) throw new Error("Invalid operation schema");
    validateSources(op.spanSources); const allowed = allowedSources(op.spanSources);
    if (op.kind === "create-episode") {
      if (typeof op.localKey !== "string" || !op.localKey || !validateEpisodeFields(op.fields, ["title", "status", "started", "updated", "projects", "tags", "sources"]) || !["title", "status", "started", "updated", "projects", "tags", "sources"].every((key) => key in op.fields)) throw new Error("Invalid episode creation");
      validateSections(op.sections, allowed);
      if (!Object.values(op.sections).some((items) => items.length)) throw new Error("Episode creation requires a cited section item");
      if (op.fields.sources.some((source) => source.entryIds.some((id) => !allowed.has(`${source.sessionId}/${id}`)))) throw new Error("Episode source outside new span");
      const id = op.recordId; const target = episodeTarget(index, op.filenameDate, op.fields);
      if (virtualEpisodes.has(id) || episodeKeys.has(op.localKey)) throw new Error(`Duplicate episode localKey: ${op.localKey}`);
      if (index.occupiedPaths.has(target) && !index.episodes.has(id)) throw new Error(`Episode create target already exists: ${target}`);
      virtualEpisodes.add(id); episodeKeys.add(op.localKey);
    } else if (op.kind === "update-episode") {
      if (typeof op.id !== "string" || !virtualEpisodes.has(op.id) || !validDate(op.updated)) throw new Error(`Unknown or invalid episode update target: ${op.id}`);
      if (op.fields && !validateEpisodeFields(op.fields, ["title", "status", "projects", "tags"])) throw new Error("Invalid episode fields");
      if (op.sections !== undefined) validateSections(op.sections, allowed);
      if (op.fields && Object.keys(op.fields).length && !(op.sections && Object.values(op.sections).some((items) => items.length))) throw new Error("Episode field updates require a cited section item");
    } else if (op.kind === "create-commitment") {
      if (typeof op.localKey !== "string" || !op.localKey || !validCommitmentCreateFields(op.fields)) throw new Error("Invalid commitment creation");
      parseItem(op.description, allowed); const id = op.recordId; const target = `commitments/${id}.md`;
      if (virtualCommitments.has(id) || commitmentKeys.has(op.localKey)) throw new Error(`Duplicate commitment localKey: ${op.localKey}`);
      if (index.occupiedPaths.has(target) && !index.commitments.has(id)) throw new Error(`Commitment create target already exists: ${target}`);
      virtualCommitments.add(id); commitmentKeys.add(op.localKey);
    } else if (op.kind === "update-commitment") {
      if (typeof op.id !== "string" || (!virtualCommitments.has(op.id) && !index.invalidIds.has(op.id))) throw new Error(`Unknown commitment update target: ${op.id}`);
      if (index.invalidIds.has(op.id)) throw new Error(`Cannot update invalid record ${op.id}`);
      if (!validDate(op.updated)) throw new Error("Invalid commitment updated date"); validateChanges(op.changes, allowed);
      // Rendering omits unchanged values from history while still advancing provenance/date.
    } else throw new Error(`Unknown operation kind: ${(op as { kind?: string }).kind}`);
  }
}
function dateAppend(body: string, date: string, text: string): string { return `${body}${body.length && !body.endsWith("\n") ? "\n" : ""}${body.length ? "\n" : ""}### ${date}\n${text}\n`; }
function renderEpisodeSections(sections: Record<string, DigestItem[]>, date: string): string { return headings.filter((heading) => (sections[heading] ?? []).length > 0).map((heading) => `## ${heading}\n${appendOnlyHeadings.has(heading) ? `### ${date}\n` : ""}${sections[heading]!.map((item) => `- **${item.label}** ${item.text} — [${item.citations.join(", ")}]`).join("\n")}`).join("\n\n"); }
const appendOnlyHeadings = new Set(["Alternatives considered", "Changes of understanding"]);
function reviseEpisodeSections(body: string, date: string, sections: Record<string, DigestItem[]>): string {
  for (const heading of headings) {
    const items = sections[heading] ?? []; if (!items.length) continue;
    const content = items.map((item) => `- **${item.label}** ${item.text} — [${item.citations.join(", ")}]`).join("\n"), match = new RegExp(`(^## ${heading}\\r?\\n)([\\s\\S]*?)(?=^#{1,2} |(?![\\s\\S]))`, "m").exec(body);
    if (appendOnlyHeadings.has(heading)) body = match ? `${body.slice(0, match.index + match[0].length).replace(/\s*$/, "")}\n### ${date}\n${content}\n${body.slice(match.index + match[0].length)}` : `${body}${body.endsWith("\n") ? "" : "\n"}## ${heading}\n### ${date}\n${content}\n`;
    else body = match ? `${body.slice(0, match.index)}${match[1]}${content}\n${body.slice(match.index + match[0].length)}` : `${body}${body.endsWith("\n") ? "" : "\n"}## ${heading}\n${content}\n`;
  }
  return body;
}
function citedSources(items: DigestItem[]): RecordSource[] {
  const grouped = new Map<string, string[]>();
  for (const citation of items.flatMap((item) => item.citations)) { const slash = citation.indexOf("/"), sessionId = citation.slice(0, slash), entryId = citation.slice(slash + 1), ids = grouped.get(sessionId) ?? []; if (!ids.includes(entryId)) ids.push(entryId); grouped.set(sessionId, ids); }
  return [...grouped].map(([sessionId, entryIds]) => ({ sessionId, entryIds }));
}
function citedSourcesInBody(body: string): RecordSource[] {
  const citations = [...body.matchAll(/ — \[([^\]\r\n]+)\]$/gm)].flatMap(([, list]) => list!.split(", ").filter((citation) => { const slash = citation.indexOf("/"); return slash > 0 && slash < citation.length - 1; }));
  return citedSources([{ label: "observed", text: "", citations }]);
}
function changeLine(change: CommitmentChange): string { const value = change.value === null ? "null" : Array.isArray(change.value) ? JSON.stringify(change.value) : change.value; return `${change.field}: ${value} (**${change.label}**) — [${change.citations.join(", ")}]`; }
function updateMetadata(doc: ReturnType<typeof parseDocument>, values: Record<string, unknown>): void { for (const [key, value] of Object.entries(values)) doc.set(key, value); }
function serialize(metadata: RecordMetadata | ReturnType<typeof parseDocument>, body: string): string {
  const doc = "set" in metadata ? metadata : undefined;
  return `---\n${(doc ? doc : (() => { const value = parseDocument(""); for (const [key, item] of Object.entries(metadata)) value.set(key, item); return value; })()).toString().trimEnd()}\n---\n${body}`;
}
function renderFromRaw(index: RecordIndex, operation: RecordOperation, raw: string | undefined, targetPath: string): { path: string; content: string } | undefined {
  const create = operation.kind === "create-episode" || operation.kind === "create-commitment";
  const id = create ? operation.recordId : operation.id;
  const existing = operation.kind.includes("episode") ? index.episodes.get(id) : index.commitments.get(id);
  if (create) {
    if (existing) return undefined;
    if (index.occupiedPaths.has(targetPath)) throw new Error(`Create target already exists: ${targetPath}`);
    let metadata: RecordMetadata; let body: string;
    if (operation.kind === "create-episode") { metadata = { type: "episode", ...operation.fields, id, sources: citedSources(Object.values(operation.sections).flat()), derived: true }; body = `${renderEpisodeSections(operation.sections, operation.fields.started)}\n`; }
    else {
      metadata = { type: "commitment", ...operation.fields, id, derived: true, sources: citedSources([operation.description]) };
      body = `## Description\n- **${operation.description.label}** ${operation.description.text} — [${operation.description.citations.join(", ")}]\n\n## History\n### ${operation.fields.created}\ncreated (**${operation.description.label}**) — [${operation.description.citations.join(", ")}]\n`;
    }
    return { path: targetPath, content: serialize(metadata, body) };
  }
  if (!existing || raw === undefined) throw new Error(`Missing operation target ${id}`);
  let split: ReturnType<typeof splitRecord>;
  try { split = splitRecord(raw); } catch (error) { throw new Error(`Cannot reload update target ${id}: ${(error as Error).message}`); }
  const current = split.doc.toJSON();
  const valid = operation.kind === "update-episode" ? isEpisode(current) && current.id === id : isCommitment(current) && current.id === id;
  if (!valid) throw new Error(`Cannot reload update target ${id}: invalid or conflicting metadata`);
  let body = split.body;
  if (operation.kind === "update-episode") {
    const revised = operation.sections ? reviseEpisodeSections(body, operation.updated, operation.sections) : body;
    const fieldChanged = Object.entries(operation.fields ?? {}).some(([key, value]) => JSON.stringify((current as any)[key]) !== JSON.stringify(value));
    if (!fieldChanged && revised.trimEnd() === body.trimEnd()) throw new Error(`No-op update rejected: ${id}`);
    updateMetadata(split.doc, { ...operation.fields, started: operation.earliestCitedDate < (current as Episode).started ? operation.earliestCitedDate : (current as Episode).started, updated: operation.updated, sources: citedSourcesInBody(revised) });
    body = revised;
  } else if (operation.kind === "update-commitment") {
    const changes = operation.changes.filter((change) => {
      const value = (current as Commitment)[change.field as keyof Commitment];
      return !(value === undefined && change.value === null) && JSON.stringify(value) !== JSON.stringify(change.value);
    });
    for (const change of changes) { if (change.value === null) split.doc.delete(change.field); else split.doc.set(change.field, change.value); }
    if (!changes.length) throw new Error(`No-op update rejected: ${id}`);
    split.doc.set("updated", operation.updated);
    body = dateAppend(body, operation.updated, changes.map(changeLine).join("\n")); split.doc.set("sources", citedSourcesInBody(body));
  }
  return { path: targetPath, content: serialize(split.doc, body.endsWith("\n") ? body : `${body}\n`) };
}
function operationTarget(index: RecordIndex, operation: RecordOperation): string {
  if (operation.kind === "create-episode") return episodeTarget(index, operation.filenameDate, operation.fields);
  if (operation.kind === "create-commitment") return join("commitments", `${operation.recordId}.md`);
  const existing = operation.kind === "update-episode" ? index.episodes.get(operation.id) : index.commitments.get(operation.id);
  if (!existing) throw new Error(`Missing operation target ${operation.id}`);
  return existing.path;
}
/** Render against indexed raw snapshots; no filesystem access or mutation occurs. */
export function renderOperation(index: RecordIndex, operation: RecordOperation): { path: string; content: string } | undefined {
  const path = operationTarget(index, operation);
  const id = operation.kind === "create-episode" || operation.kind === "create-commitment" ? operation.recordId : operation.id;
  const existing = operation.kind.includes("episode") ? index.episodes.get(id) : index.commitments.get(id);
  return renderFromRaw(index, operation, existing?.raw, path);
}
/** Advance a virtual index after a successful prepared render, without a disk write. */
export function advanceOperation(index: RecordIndex, operation: RecordOperation, rendered: { path: string; content: string }): void {
  const next = loadRawRecord(rendered.path, rendered.content);
  if (next.type === "episode") index.episodes.set(next.id, { path: rendered.path, metadata: next, body: splitRecord(rendered.content).body, raw: rendered.content });
  else index.commitments.set(next.id, { path: rendered.path, metadata: next, body: splitRecord(rendered.content).body, raw: rendered.content });
  index.occupiedPaths.add(rendered.path);
}
function loadRawRecord(path: string, raw: string): RecordMetadata { const metadata = splitRecord(raw).doc.toJSON(); if (isEpisode(metadata) || isCommitment(metadata)) return metadata; throw new Error(`Invalid rendered record: ${path}`); }
export function loadRecordIndex(dir: string): RecordIndex {
  const index: RecordIndex = { episodes: new Map(), commitments: new Map(), invalidIds: new Set(), occupiedPaths: new Set() };
  for (const [folder, kind] of [["episodes", "episode"], ["commitments", "commitment"]] as const) {
    const path = join(dir, folder); if (!existsSync(path)) continue;
    for (const name of readdirSync(path).filter((item) => item.endsWith(".md"))) {
      const file = join(path, name); index.occupiedPaths.add(join(folder, name));
      try {
        const raw = readFileSync(file, "utf8"); const split = splitRecord(raw); const metadata = split.doc.toJSON();
        if (kind === "episode" ? !isEpisode(metadata) : !isCommitment(metadata)) throw new Error("invalid record metadata");
        const records = kind === "episode" ? index.episodes : index.commitments;
        const prior = records.get(metadata.id);
        if (prior) {
          records.delete(metadata.id); index.invalidIds.add(metadata.id);
          warnRecordOnce(`${kind}:${metadata.id}`, `Skipping ambiguous ${kind} ID ${metadata.id} in ${prior.path} and ${file}`);
          continue;
        }
        if (index.invalidIds.has(metadata.id)) { warnRecordOnce(`${kind}:${metadata.id}`, `Skipping ambiguous ${kind} ID ${metadata.id} in ${file}`); continue; }
        records.set(metadata.id, { path: file, metadata: metadata as never, body: split.body, raw });
      } catch (error) {
        warnRecordOnce(`${kind}:${file}`, `Skipping invalid ${kind} record ${file}: ${(error as Error).message}`); index.invalidIds.add(name.replace(/\.md$/, ""));
        try { const match = readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/); if (match) { const id = parseDocument(match[1]).get("id"); if (typeof id === "string") index.invalidIds.add(id); } } catch { /* Filename ID remains available. */ }
      }
    }
  }
  return index;
}
export function buildRecordContext(index: RecordIndex, spanDate: string, activityDays: string[] = [spanDate]): RecordContext {
  const recentDays = new Set(activityDays.filter((date) => date <= spanDate).sort().slice(-2));
  return {
    commitments: [...index.commitments.values()].map(({ metadata }) => metadata).filter((item) => !terminalCommitments.has(item.status)).map(({ id, title, status, owner, next_action }) => ({ id, title, status, owner, next_action })),
    episodes: [...index.episodes.values()].map(({ metadata, body }) => ({ metadata, body })).filter(({ metadata }) => metadata.status === "open" && recentDays.has(metadata.updated)).map(({ metadata, body }) => ({ id: metadata.id, title: metadata.title, summary: body.trim().slice(0, 300), currentText: body.trim() })),
  };
}
