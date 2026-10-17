import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { advanceOperation, buildRecordContext, loadRecordIndex, renderOperation, resetRecordWarnings, validateOperations, type RecordOperation } from "../src/records.ts";

const spanSources = [{ sessionId: "session-a", entryIds: ["e1", "e2"] }];
const nextSources = [{ sessionId: "session-b", entryIds: ["e3"] }];
const item = (text: string, citation = "session-a/e1") => ({ label: "observed" as const, text, citations: [citation] });
const sections = { "Alternatives considered": [{ label: "observed" as const, text: "Rejected the cache", citations: ["session-a/e1"] }], "Changes of understanding": [item("The cache was unnecessary")] };
function sandbox(run: (dir: string) => void): void { const dir = mkdtempSync(join(tmpdir(), "samwise-records-")); try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); } }
function writer(path: string, content: string): void { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); }
function applyOperation(dir: string, operation: RecordOperation, index: ReturnType<typeof loadRecordIndex>, write: typeof writer): void {
  validateOperations([operation], index); const result = renderOperation(index, operation); if (!result) return;
  const path = result.path.startsWith(dir) ? result.path : join(dir, result.path); write(path, result.content); advanceOperation(index, operation, { ...result, path });
}
function episodeCreate(title = "Cache decision", localKey = "decision-1"): Extract<RecordOperation, { kind: "create-episode" }> { return { kind: "create-episode", recordId: randomUUID(), filenameDate: "2026-04-10", spanSources, localKey, fields: { title, status: "open", started: "2026-04-10", updated: "2026-04-10", projects: ["samwise"], tags: [], sources: spanSources }, sections }; }
function commitmentCreate(): Extract<RecordOperation, { kind: "create-commitment" }> { return { kind: "create-commitment", recordId: randomUUID(), spanSources, localKey: "request-1", fields: { title: "Review patch", kind: "request", owner: "George", requested_by: "Samwise", status: "open", next_action: "Inspect diff", projects: ["samwise"], created: "2026-04-10", updated: "2026-04-10" }, description: item("Review the patch") }; }

test("episode creation and later revision preserve rejected approaches, append history, and merge sources", () => sandbox((dir) => {
  const create = episodeCreate(); applyOperation(dir, create, loadRecordIndex(dir), writer);
  const index = loadRecordIndex(dir); const id = [...index.episodes.keys()][0]!;
  const update: RecordOperation = { kind: "update-episode", earliestCitedDate: "2026-04-10", spanSources: nextSources, id, updated: "2026-04-11", fields: { status: "resolved" }, sections: { "Reasoning and decision": [item("Selected the simpler route", "session-b/e3")], "Alternatives considered": [item("Retained the explicit journal", "session-b/e3")] } };
  applyOperation(dir, update, index, writer);
  const raw = readFileSync(index.episodes.get(id)!.path, "utf8");
  assert.match(raw, /## Alternatives considered\n### 2026-04-10\n- \*\*observed\*\* Rejected the cache/); assert.match(raw, /## Reasoning and decision\n- \*\*observed\*\* Selected the simpler route/); assert.match(raw, /### 2026-04-11\n- \*\*observed\*\* Retained the explicit journal/); assert.match(raw, /Rejected the cache[\s\S]*Retained the explicit journal/); assert.doesNotMatch(raw, /## Problem\n\n/);
  assert.equal(loadRecordIndex(dir).episodes.get(id)?.metadata.status, "resolved");
  assert.deepEqual(loadRecordIndex(dir).episodes.get(id)?.metadata.sources, [{ sessionId: "session-a", entryIds: ["e1"] }, nextSources[0]!]);
}));

test("earlier cited activity moves started without renaming the creation file", () => sandbox((dir) => {
  const create = episodeCreate(); applyOperation(dir, create, loadRecordIndex(dir), writer); const record = loadRecordIndex(dir).episodes.get(create.recordId)!;
  const update: RecordOperation = { kind: "update-episode", earliestCitedDate: "2026-04-09", spanSources: nextSources, id: create.recordId, updated: "2026-04-11", sections: { Outcome: [item("Earlier evidence", "session-b/e3")] } };
  applyOperation(dir, update, loadRecordIndex(dir), writer);
  const after = loadRecordIndex(dir).episodes.get(create.recordId)!;
  assert.equal(after.metadata.started, "2026-04-09"); assert.equal(after.path, record.path);
}));

test("citation provenance ignores brackets and Markdown links in retained text", () => sandbox((dir) => {
  const create = { ...episodeCreate(), sections: { Problem: [item("Use [cache/path] and [docs](https://example.com)")] } };
  applyOperation(dir, create, loadRecordIndex(dir), writer);
  const id = create.recordId, update: RecordOperation = { kind: "update-episode", earliestCitedDate: "2026-04-11", spanSources: nextSources, id, updated: "2026-04-11", sections: { Outcome: [item("New result", "session-b/e3")] } };
  const path = loadRecordIndex(dir).episodes.get(id)!.path;
  applyOperation(dir, update, loadRecordIndex(dir), writer);
  assert.deepEqual(loadRecordIndex(dir).episodes.get(id)!.metadata.sources, [{ sessionId: "session-a", entryIds: ["e1"] }, nextSources[0]!]);
  assert.match(readFileSync(path, "utf8"), /\[docs\]\(https:\/\/example\.com\)/);
}));

test("commitment request can be accepted, blocked, and completed with cited history; hand edits survive", () => sandbox((dir) => {
  applyOperation(dir, commitmentCreate(), loadRecordIndex(dir), writer);
  const record = [...loadRecordIndex(dir).commitments.values()][0]!; const id = record.metadata.id;
  let raw = readFileSync(record.path, "utf8").replace("sessionId: session-a", "sessionId: stale-span").replace("## Description", "## Description\nHuman comment: keep this"); writeFileSync(record.path, raw);
  const stages: Array<[string, Partial<{ kind: string; status: string }>, string]> = [
    ["2026-04-11", { kind: "commitment" }, "kind: commitment"], ["2026-04-12", { status: "blocked" }, "blocked"], ["2026-04-13", { status: "done" }, "done"],
  ];
  for (const [updated, change, text] of stages) {
    const op: RecordOperation = { kind: "update-commitment", spanSources: nextSources, id, updated, changes: Object.entries(change).map(([field, value]) => ({ field, value: value!, label: "observed", citations: ["session-b/e3"] })) };
    applyOperation(dir, op, loadRecordIndex(dir), writer); raw = readFileSync(record.path, "utf8"); assert.match(raw, new RegExp(text));
  }
  const final = loadRecordIndex(dir).commitments.get(id)!; assert.equal(final.metadata.kind, "commitment"); assert.equal(final.metadata.status, "done");
  assert.match(final.body, /Human comment: keep this/); assert.match(final.body, /status: blocked/); assert.match(final.body, /status: done/);
  assert.equal((final.body.match(/^created /gm) ?? []).length, 1); assert.doesNotMatch(final.body, /title:|owner:|requested_by:|due: null/);
  assert.deepEqual(final.metadata.sources, [{ sessionId: "session-a", entryIds: ["e1"] }, { sessionId: "session-b", entryIds: ["e3"] }]);
}));

test("commitment projects update and null optional fields clear YAML metadata", () => sandbox((dir) => {
  const create = { ...commitmentCreate(), fields: { ...commitmentCreate().fields, due: "2026-04-15", blocked_on: "external", depends_on: "other" } } as RecordOperation;
  applyOperation(dir, create, loadRecordIndex(dir), writer); const record = [...loadRecordIndex(dir).commitments.values()][0]!;
  const op: RecordOperation = { kind: "update-commitment", spanSources: nextSources, id: record.metadata.id, updated: "2026-04-11", changes: [
    { field: "projects", value: ["new-project"], label: "stated", citations: ["session-b/e3"] },
    ...["due", "blocked_on", "depends_on"].map((field) => ({ field, value: null, label: "stated" as const, citations: ["session-b/e3"] })),
  ] };
  applyOperation(dir, op, loadRecordIndex(dir), writer); const result = loadRecordIndex(dir).commitments.get(record.metadata.id)!.metadata;
  assert.deepEqual(result.projects, ["new-project"]); assert.equal("due" in result, false); assert.equal("blocked_on" in result, false); assert.equal("depends_on" in result, false);
  const noOp: RecordOperation = { kind: "update-commitment", spanSources: nextSources, id: record.metadata.id, updated: "2026-04-12", changes: [{ field: "status", value: "open", label: "observed", citations: ["session-b/e3"] }] };
  const priorBody = loadRecordIndex(dir).commitments.get(record.metadata.id)!.body;
  assert.throws(() => applyOperation(dir, noOp, loadRecordIndex(dir), writer), /No-op update rejected/);
  assert.equal(loadRecordIndex(dir).commitments.get(record.metadata.id)!.body, priorBody);
}));

test("Monday context retains open episodes from both Thursday and Friday activity days", () => sandbox((dir) => {
  const oldStart = { ...episodeCreate("Old start"), fields: { ...episodeCreate("Old start").fields, started: "2026-02-01" } };
  applyOperation(dir, oldStart, loadRecordIndex(dir), writer); const first = [...loadRecordIndex(dir).episodes.values()][0]!;
  applyOperation(dir, { kind: "update-episode", earliestCitedDate: "2026-04-10", spanSources: nextSources, id: first.metadata.id, updated: "2026-04-10", sections: { Outcome: [item("still open", "session-b/e3")] } }, loadRecordIndex(dir), writer);
  const second = episodeCreate("Resolved", "decision-2"); applyOperation(dir, second, loadRecordIndex(dir), writer); const resolvedId = [...loadRecordIndex(dir).episodes.keys()].find((id) => id !== first.metadata.id)!;
  applyOperation(dir, { kind: "update-episode", earliestCitedDate: "2026-04-09", spanSources: nextSources, id: resolvedId, updated: "2026-04-09", sections: { Outcome: [item("Thursday activity", "session-b/e3")] } }, loadRecordIndex(dir), writer);
  const beforeCommitment = buildRecordContext(loadRecordIndex(dir), "2026-04-13", ["2026-04-09", "2026-04-10"]); assert.deepEqual(new Set(beforeCommitment.episodes.map((entry) => entry.id)), new Set([first.metadata.id, resolvedId]));
  applyOperation(dir, commitmentCreate(), loadRecordIndex(dir), writer); assert.equal(buildRecordContext(loadRecordIndex(dir), "2026-04-11").commitments.length, 1);
}));

test("section replacement preserves higher-level notes between and after sections", () => sandbox((dir) => {
  const create = { ...episodeCreate(), sections: { Problem: [item("Initial problem")], Outcome: [item("Existing outcome")] } }; applyOperation(dir, create, loadRecordIndex(dir), writer); const record = loadRecordIndex(dir).episodes.get(create.recordId)!;
  const raw = readFileSync(record.path, "utf8").replace("## Outcome", "# Human notes\\nKeep note between.\\n\\n## Outcome") + "\\n# Final notes\\nKeep note at end.\\n";
  writeFileSync(record.path, raw);
  const update: RecordOperation = { kind: "update-episode", earliestCitedDate: "2026-04-11", spanSources: nextSources, id: create.recordId, updated: "2026-04-11", sections: { Problem: [item("Revised problem", "session-b/e3")] } };
  applyOperation(dir, update, loadRecordIndex(dir), writer); const updated = readFileSync(record.path, "utf8");
  assert.match(updated, /# Human notes\\nKeep note between/); assert.match(updated, /# Final notes\\nKeep note at end/);
}));

test("episode filename collisions receive the next numeric suffix", () => sandbox((dir) => {
  applyOperation(dir, episodeCreate("Same title", "key-a"), loadRecordIndex(dir), writer); applyOperation(dir, episodeCreate("Same title", "key-b"), loadRecordIndex(dir), writer);
  assert.equal(loadRecordIndex(dir).episodes.size, 2); assert.notEqual(episodeCreate("Same title", "key-a").recordId, episodeCreate("Same title", "key-b").recordId);
  const collision = episodeCreate("Same title", "key-c");
  const occupied = join(dir, "episodes", "2026-04-10-same-title.md"); writer(occupied, "unrelated human file");
  const index = loadRecordIndex(dir); assert.doesNotThrow(() => validateOperations([collision], index));
  assert.match(renderOperation(index, collision)!.path, /2026-04-10-same-title-3\.md$/);
}));

test("invalid commitment create target is not overwritten", () => sandbox((dir) => {
  const create = commitmentCreate(); const id = create.recordId; const path = join(dir, "commitments", `${id}.md`); writer(path, "not valid frontmatter");
  const before = readFileSync(path, "utf8"); assert.throws(() => validateOperations([create], loadRecordIndex(dir)), /target already exists/);
  assert.throws(() => applyOperation(dir, create, loadRecordIndex(dir), writer), /target already exists/); assert.equal(readFileSync(path, "utf8"), before);
}));

test("strict operation schemas, required episode fields, statuses, targets, and citations are validated", () => sandbox((dir) => {
  const index = loadRecordIndex(dir); const base = episodeCreate();
  for (const field of ["title", "status", "started", "updated", "projects", "tags", "sources"]) {
    const fields = { ...base.fields } as Record<string, unknown>; delete fields[field]; assert.throws(() => validateOperations([{ ...base, fields }], index), /Invalid episode creation/);
  }
  assert.throws(() => validateOperations([{ ...base, sections: {} }], index), /cited section item/);
  assert.throws(() => validateOperations([{ ...base, fields: { ...base.fields, status: "invalid" } }], index), /Invalid episode creation/);
  assert.throws(() => validateOperations([{ ...base, fields: { ...base.fields, id: [] } }], index), /Invalid episode creation/);
  assert.throws(() => validateOperations([{ ...base, sections: { Mystery: [] } }], index), /Invalid episode sections/);
  assert.throws(() => validateOperations([{ ...base, sections: { Outcome: [item("outside", "session-z/nope")] } }], index), /Invalid episode sections/);
  assert.throws(() => validateOperations([{ ...base, localKey: 7 }], index), /Invalid episode creation/);
  assert.throws(() => validateOperations([{ ...commitmentCreate(), fields: { ...commitmentCreate().fields, blocked_on: [] } }], index), /Invalid commitment creation/);
  assert.throws(() => validateOperations([{ ...commitmentCreate(), fields: { ...commitmentCreate().fields, status: "invalid" } }], index), /Invalid commitment creation/);
  assert.throws(() => validateOperations([{ ...base, unexpected: true }], index), /Invalid operation schema/);
  const unknown: RecordOperation = { kind: "update-episode", spanSources, earliestCitedDate: "2026-04-11", id: "unknown", updated: "2026-04-11", sections: { Outcome: [item("x")] } };
  assert.throws(() => validateOperations([unknown], index), /Unknown or invalid episode update target/);
  const invalidCommitment: RecordOperation = { kind: "update-commitment", spanSources, id: "unknown", updated: "2026-04-11", changes: [] };
  assert.throws(() => validateOperations([invalidCommitment], index), /Unknown commitment update target/);
}));

test("invalid-record warnings are emitted once per run", () => sandbox((dir) => {
  const path = join(dir, "episodes", "broken.md"); writer(path, "not a record"); resetRecordWarnings();
  const warnings: string[] = [], warn = console.warn; console.warn = (message) => warnings.push(String(message));
  try { loadRecordIndex(dir); loadRecordIndex(dir); } finally { console.warn = warn; }
  assert.equal(warnings.length, 1);
}));

test("duplicate human record IDs are skipped as ambiguous with both paths warned", () => sandbox((dir) => {
  const operation = episodeCreate();
  applyOperation(dir, operation, loadRecordIndex(dir), writer); const first = [...loadRecordIndex(dir).episodes.values()][0]!.path; const second = join(dir, "episodes", "duplicate.md");
  writeFileSync(second, readFileSync(first, "utf8"));
  const warnings: string[] = []; const warn = console.warn; console.warn = (message) => warnings.push(String(message));
  try { const index = loadRecordIndex(dir); assert.equal(index.episodes.has(operation.recordId), false); assert.equal(index.invalidIds.has(operation.recordId), true); } finally { console.warn = warn; }
  assert.match(warnings.join("\n"), /episodes\/.*\.md.*episodes\/duplicate\.md/);
  assert.match(readFileSync(first, "utf8"), /Cache decision/); assert.match(readFileSync(second, "utf8"), /Cache decision/);
}));

test("human YAML fields, comments, and body edits survive episode and commitment updates and reload", () => sandbox((dir) => {
  const ep = episodeCreate(); applyOperation(dir, ep, loadRecordIndex(dir), writer); const er = [...loadRecordIndex(dir).episodes.values()][0]!;
  let raw = readFileSync(er.path, "utf8").replace("title: Cache decision", "title: Cache decision\nhuman_custom: keep episode").replace("## Problem", "Human comment: episode\n\n## Problem"); writeFileSync(er.path, `${raw}\nManual body edit\n`);
  const eop: RecordOperation = { kind: "update-episode", earliestCitedDate: "2026-04-10", spanSources: nextSources, id: er.metadata.id, updated: "2026-04-11", sections: { Outcome: [item("updated episode", "session-b/e3")] } };
  applyOperation(dir, eop, loadRecordIndex(dir), writer); raw = readFileSync(er.path, "utf8");
  assert.match(raw, /human_custom: keep episode/); assert.match(raw, /Manual body edit/); assert.match(raw, /## Outcome\n- \*\*observed\*\* updated episode/); assert.ok(loadRecordIndex(dir).episodes.has(er.metadata.id));
  const co = commitmentCreate(); applyOperation(dir, co, loadRecordIndex(dir), writer); const cr = [...loadRecordIndex(dir).commitments.values()][0]!;
  raw = readFileSync(cr.path, "utf8").replace("title: Review patch", "title: Review patch\nhuman_custom: keep commitment").replace("## Description", "Human comment: commitment\n\n## Description"); writeFileSync(cr.path, `${raw}\nManual commitment body edit\n`);
  const cop: RecordOperation = { kind: "update-commitment", spanSources: nextSources, id: cr.metadata.id, updated: "2026-04-11", changes: [{ field: "status", value: "blocked", label: "observed", citations: ["session-b/e3"] }] };
  applyOperation(dir, cop, loadRecordIndex(dir), writer); raw = readFileSync(cr.path, "utf8");
  assert.match(raw, /human_custom: keep commitment/); assert.match(raw, /Human comment: commitment/); assert.match(raw, /Manual commitment body edit/); assert.equal(loadRecordIndex(dir).commitments.get(cr.metadata.id)?.metadata.status, "blocked");
}));

test("duplicate create local keys within a batch are rejected without operation markers", () => sandbox((dir) => {
  const ep = episodeCreate();
  assert.throws(() => validateOperations([ep, { ...ep }], loadRecordIndex(dir)), /Duplicate episode localKey/);
  applyOperation(dir, ep, loadRecordIndex(dir), writer);
  const raw = readFileSync([...loadRecordIndex(dir).episodes.values()][0]!.path, "utf8");
  assert.doesNotMatch(raw, /samwise-operation/);
}));

test("virtual rendering advances pure index across operations and apply rereads disk before replay", () => sandbox((dir) => {
  const index = loadRecordIndex(dir); const create = episodeCreate(); const rendered = renderOperation(index, create)!; advanceOperation(index, create, rendered);
  const id = [...index.episodes.keys()][0]!; const update: RecordOperation = { kind: "update-episode", earliestCitedDate: "2026-04-10", spanSources: nextSources, id, updated: "2026-04-11", sections: { Outcome: [item("virtual", "session-b/e3")] } };
  const updateRendered = renderOperation(index, update)!; assert.match(updateRendered.content, /virtual/); advanceOperation(index, update, updateRendered);
  const applyIndex = loadRecordIndex(dir); applyOperation(dir, create, applyIndex, writer); applyOperation(dir, update, applyIndex, writer);
  const file = loadRecordIndex(dir).episodes.get(id)!; assert.match(file.body, /virtual/); assert.deepEqual(file.metadata.sources, [{ sessionId: "session-a", entryIds: ["e1"] }, nextSources[0]!]);
  const before = readFileSync(file.path, "utf8"); assert.throws(() => applyOperation(dir, update, loadRecordIndex(dir), writer), /No-op update rejected/); assert.equal(readFileSync(file.path, "utf8"), before);
}));
