import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planTranscriptSpans, readTranscriptSnapshot } from "../src/transcript.ts";
import { buildPrompt } from "../src/consolidator.ts";

function fixture(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "samwise-transcript-"));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function row(id: string, parentId: string | null, role: string, text: string, timestamp = "2026-10-16T10:00:00.000Z", stopReason?: string) {
  return { type: "message", id, parentId, timestamp, message: { role, ...(stopReason ? { stopReason } : {}), content: [{ type: "text", text }] } };
}
function writeSession(path: string, rows: unknown[]): void { writeFileSync(path, `${rows.map((item) => JSON.stringify(item)).join("\n")}\n`); }

test("marks inactive fork exploration abandoned but preserves copied active ancestry across sessions", () => fixture((directory) => {
  const activePath = join(directory, "main.jsonl");
  const forkPath = join(directory, "fork.jsonl");
  const shared = row("12345678", null, "user", "shared");
  const exploration = row("deadbeef", "12345678", "assistant", "explored", undefined, "stop");
  const activeAnswer = row("cafebabe", "12345678", "assistant", "active", undefined, "stop");
  writeSession(activePath, [shared, exploration, activeAnswer]);
  writeSession(forkPath, [shared, activeAnswer]);
  const snapshot = readTranscriptSnapshot(directory);
  assert.equal(snapshot.entries.find((entry) => entry.id === "deadbeef")?.abandoned, true);
  assert.equal(snapshot.entries.find((entry) => entry.id === "12345678")?.abandoned, false);
  const abandoned = snapshot.entries.find((entry) => entry.id === "deadbeef")!;
  assert.equal(planTranscriptSpans(snapshot).processableCount, 3);
  assert.equal(planTranscriptSpans(snapshot, new Set([abandoned.identity])).processableCount, 2);
}));

test("deduplicates copied history when Pi rewires parents around removed branch labels", () => fixture((directory) => {
  const shared = row("u1", null, "user", "question");
  const answer = { ...row("a1", "label-1", "assistant", "same answer", "2026-10-16T10:01:00.000Z", "stop"), label: "original branch" };
  writeSession(join(directory, "original.jsonl"), [shared, { type: "label", id: "label-1", parentId: "u1", timestamp: "2026-10-16T10:00:30.000Z", text: "branch" }, answer]);
  const { label: _label, ...clone } = answer;
  writeSession(join(directory, "fork.jsonl"), [shared, { ...clone, parentId: "u1" }]);
  const snapshot = readTranscriptSnapshot(directory);
  const copies = snapshot.entries.filter((entry) => entry.id === "a1");
  assert.equal(copies.length, 2);
  assert.equal(copies[0].identity, copies[1].identity);
  assert.equal(planTranscriptSpans(snapshot).processableCount, 2);
}));

test("deduplicates clone history with content-derived identity without conflating short IDs", () => fixture((directory) => {
  writeSession(join(directory, "a.jsonl"), [row("u1", null, "user", "one"), row("12345678", "u1", "assistant", "reply one", undefined, "stop")]);
  writeSession(join(directory, "b.jsonl"), [row("u2", null, "user", "two"), row("12345678", "u2", "assistant", "reply two", undefined, "stop")]);
  const snapshot = readTranscriptSnapshot(directory);
  assert.notEqual(snapshot.entries[0].identity, snapshot.entries[1].identity);
  const plan = planTranscriptSpans(snapshot);
  assert.equal(plan.processableCount, 4);
}));

test("defers unfinished user exchange including assistant toolUse and accepts terminal stop reasons", () => fixture((directory) => {
  writeSession(join(directory, "session.jsonl"), [
    row("u1", null, "user", "done"), row("a1", "u1", "assistant", "answer", undefined, "stop"),
    row("u2", "a1", "user", "unfinished"), row("a2", "u2", "assistant", "calling", undefined, "toolUse"),
  ]);
  const plan = planTranscriptSpans(readTranscriptSnapshot(directory));
  assert.deepEqual(plan.deferredUnfinished.map((entry) => entry.id), ["u2", "a2"]);
  assert.deepEqual(plan.spans.flatMap((span) => span.entries.map((entry) => entry.id)), ["u1", "a1"]);
}));

test("aborted and error final replies complete their exchanges", () => fixture((directory) => {
  for (const [reason, userId, assistantId] of [["aborted", "ua", "aa"], ["error", "ue", "ae"], ["length", "ul", "al"]]) {
    writeSession(join(directory, `${reason}.jsonl`), [row(userId, null, "user", "question"), row(assistantId, userId, "assistant", "partial", undefined, reason)]);
  }
  const plan = planTranscriptSpans(readTranscriptSnapshot(directory));
  assert.equal(plan.deferredUnfinished.length, 0);
  assert.deepEqual(new Set(plan.spans.flatMap((span) => span.entries.map((entry) => entry.id))), new Set(["ua", "aa", "ue", "ae", "ul", "al"]));
}));

test("caps array and string conversational content and supports plain-string user content", () => fixture((directory) => {
  const plain = { type: "message", id: "plain", parentId: null, timestamp: "2026-10-16T10:00:00.000Z", message: { role: "user", content: "plain user message" } };
  const longArray = row("array", "plain", "assistant", "x".repeat(12_100), undefined, "stop");
  const longString = { type: "message", id: "string", parentId: "array", timestamp: "2026-10-16T10:02:00.000Z", message: { role: "user", content: "y".repeat(12_100) } };
  writeSession(join(directory, "session.jsonl"), [plain, longArray, longString]);
  const entries = readTranscriptSnapshot(directory).entries;
  assert.equal(entries[0].text, "plain user message");
  assert.equal(entries[1].text, `${"x".repeat(12_000)}[truncated]`);
  assert.equal(entries[2].text, `${"y".repeat(12_000)}[truncated]`);
}));

test("uses per-session ancestry for unfinished status when a fork entry is active elsewhere", () => fixture((directory) => {
  const user = row("u1", null, "user", "question");
  const oldAnswer = row("a1", "u1", "assistant", "completed elsewhere", undefined, "stop");
  writeSession(join(directory, "active-copy.jsonl"), [user, oldAnswer]);
  writeSession(join(directory, "fork.jsonl"), [user, oldAnswer, row("a2", "u1", "assistant", "unfinished", undefined, "toolUse")]);
  const snapshot = readTranscriptSnapshot(directory);
  const oldInFork = snapshot.entries.find((entry) => entry.id === "a1" && entry.sessionPath.endsWith("fork.jsonl"))!;
  assert.equal(oldInFork.abandoned, false);
  assert.equal(oldInFork.sessionAbandoned, true);
  const plan = planTranscriptSpans(snapshot);
  assert.deepEqual(plan.spans.flatMap((span) => span.entries.map((entry) => entry.id)), ["u1", "a1"]);
  assert.equal(plan.deferredUnfinished.some((entry) => entry.id === "u1"), false);
  assert.deepEqual(plan.deferredUnfinished.map((entry) => entry.id), ["a2"]);
}));

test("does not let an abandoned completed assistant finish the active branch's user exchange", () => fixture((directory) => {
  writeSession(join(directory, "session.jsonl"), [
    row("old-answer", null, "assistant", "abandoned answer", undefined, "stop"),
    row("u1", null, "user", "active unfinished"),
  ]);
  const plan = planTranscriptSpans(readTranscriptSnapshot(directory));
  assert.equal(plan.deferredUnfinished.some((entry) => entry.id === "u1"), true);
  assert.equal(plan.spans.flatMap((span) => span.entries).some((entry) => entry.id === "u1"), false);
}));

test("carries bounded tool results and only preceding covered ancestry into context", () => fixture((directory) => {
  const sessionId = "session-header-id";
  const entries = [
    { type: "session", id: sessionId, version: 3, timestamp: "2026-10-16T10:00:00.000Z" },
    row("u1", null, "user", "question"),
    row("unrelated", "u1", "assistant", "other branch", undefined, "stop"),
    { type: "message", id: "call", parentId: "u1", timestamp: "2026-10-16T10:01:00.000Z", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "inspect", arguments: { path: "x" } }, { type: "thinking", thinking: "hidden" }] } },
    { type: "message", id: "result", parentId: "call", timestamp: "2026-10-16T10:02:00.000Z", message: { role: "toolResult", toolName: "inspect", content: [{ type: "text", text: "x".repeat(700) }] } },
    row("answer", "result", "assistant", "done", "2026-10-16T10:03:00.000Z", "stop"),
    row("future", "answer", "user", "later"),
    row("next", "future", "assistant", "later answer", undefined, "stop"),
  ];
  writeSession(join(directory, "session.jsonl"), entries);
  const snapshot = readTranscriptSnapshot(directory);
  assert.equal(snapshot.entries[0].sessionId, sessionId);
  const result = snapshot.entries.find((entry) => entry.id === "result")!;
  assert.equal(result.text, "");
  assert.equal(result.toolResults[0].length <= 507, true);
  assert.equal("raw" in result, false);
  const covered = new Set(snapshot.entries.filter((entry) => ["u1", "call", "result", "answer", "future", "unrelated"].includes(entry.id)).map((entry) => entry.identity));
  const plan = planTranscriptSpans(snapshot, covered, 1);
  assert.deepEqual(plan.spans[0].context.map((entry) => entry.id), ["u1", "call", "result", "answer", "future"]);
  assert.equal(plan.spans[0].context.some((entry) => entry.id === "unrelated"), false);
}));

test("keeps ancestry contexts distinct for spans on different dates", () => fixture((directory) => {
  for (const [name, prefix, day] of [["a", "A", "16"], ["b", "B", "17"]]) writeSession(join(directory, `${name}.jsonl`), [
    row(`${prefix}-old-user`, null, "user", `${prefix} prior`, "2026-10-15T10:00:00.000Z"),
    row(`${prefix}-old-answer`, `${prefix}-old-user`, "assistant", `${prefix} prior answer`, "2026-10-15T10:01:00.000Z", "stop"),
    row(`${prefix}-new-user`, `${prefix}-old-answer`, "user", `${prefix} new`, `2026-10-${day}T10:00:00.000Z`),
    row(`${prefix}-new-answer`, `${prefix}-new-user`, "assistant", `${prefix} answer`, `2026-10-${day}T10:01:00.000Z`, "stop"),
  ]);
  const snapshot = readTranscriptSnapshot(directory), covered = new Set(snapshot.entries.filter((entry) => entry.timestamp.startsWith("2026-10-15")).map((entry) => entry.identity));
  const plan = planTranscriptSpans(snapshot, covered);
  assert.equal(plan.spans.length, 2);
  assert.deepEqual(plan.spans.map((span) => span.context.map((entry) => entry.id)), [["A-old-user", "A-old-answer"], ["B-old-user", "B-old-answer"]]);
}));

test("context prompt caps prior entries as valid JSON but preserves full new entry text", () => fixture((directory) => {
  writeSession(join(directory, "session.jsonl"), [row("u1", null, "user", "x".repeat(5_000)), row("a1", "u1", "assistant", "answer", undefined, "stop")]);
  const span = planTranscriptSpans(readTranscriptSnapshot(directory)).spans[0];
  const prompt = buildPrompt(span, [span.entries[0]!]), instructions = prompt.split("Existing digest")[0]!;
  for (const heading of ["Work undertaken", "Outcomes", "Significant decisions", "Changes of plan and interruptions", "Carry-forward items"]) assert.equal(instructions.split(heading).length - 1, 1, `${heading} appears once`);
  const prior = prompt.split("Prior context (interpretation only):\n")[1]!.split("\nNew entries:")[0]!;
  const next = prompt.split("\nNew entries:\n")[1]!;
  assert.ok(prior.length <= 2_000);
  assert.doesNotThrow(() => JSON.parse(prior));
  assert.ok(next.includes("x".repeat(4_900)));
}));

test("groups new entries by local day and enforces entry limit even within one exchange", () => fixture((directory) => {
  const rows = [row("u1", null, "user", "one"), row("a1", "u1", "assistant", "one answer", undefined, "length"), row("u2", "a1", "user", "two"), row("a2", "u2", "assistant", "two answer", undefined, "stop")];
  writeSession(join(directory, "session.jsonl"), rows);
  const plan = planTranscriptSpans(readTranscriptSnapshot(directory), new Set(), 3);
  assert.equal(plan.spans.reduce((sum, span) => sum + span.entries.length, 0), 3);
  assert.equal(plan.limitDeferredCount, 1);
  assert.equal(plan.spans.length, 1);
}));

test("branch classification changes do not create a second processing identity", () => fixture((directory) => {
  const path = join(directory, "session.jsonl");
  writeSession(path, [row("u1", null, "user", "question"), row("a1", "u1", "assistant", "answer", undefined, "stop")]);
  const before = readTranscriptSnapshot(directory);
  const priorKey = before.entries.find((entry) => entry.id === "a1")!.identity;
  appendFileSync(path, `${JSON.stringify(row("a2", "u1", "assistant", "new answer", undefined, "stop"))}\n`);
  const after = readTranscriptSnapshot(directory);
  const changed = after.entries.find((entry) => entry.id === "a1")!;
  assert.equal(changed.abandoned, true);
  assert.equal(changed.identity, priorKey);
  assert.equal(planTranscriptSpans(after, new Set([priorKey])).spans.flatMap((span) => span.entries).some((entry) => entry.id === "a1"), false);
}));

test("freezes byte boundary before later appends", () => fixture((directory) => {
  const path = join(directory, "session.jsonl");
  writeSession(path, [row("u1", null, "user", "before")]);
  const snapshot = readTranscriptSnapshot(directory);
  appendFileSync(path, `${JSON.stringify(row("a1", "u1", "assistant", "after", undefined, "stop"))}\n`);
  assert.equal(snapshot.entries.length, 1);
}));

test("excludes subagent artifacts and nested run session files", () => fixture((directory) => {
  writeSession(join(directory, "main.jsonl"), [row("main", null, "user", "main")]);
  mkdirSync(join(directory, "subagent-artifacts"));
  writeSession(join(directory, "subagent-artifacts", "child.jsonl"), [row("child", null, "user", "child")]);
  mkdirSync(join(directory, "run-1"));
  writeSession(join(directory, "run-1", "session.jsonl"), [row("nested", null, "user", "nested")]);
  assert.deepEqual(readTranscriptSnapshot(directory).entries.map((entry) => entry.id), ["main"]);
}));

test("ignores incomplete final bytes but fails malformed complete lines", () => fixture((directory) => {
  const path = join(directory, "session.jsonl");
  writeSession(path, [row("u1", null, "user", "okay")]);
  appendFileSync(path, "{incomplete");
  const snapshot = readTranscriptSnapshot(directory);
  assert.equal(snapshot.entries.length, 1);
  writeFileSync(path, "{broken}\n");
  assert.throws(() => readTranscriptSnapshot(directory), /Malformed JSONL/);
}));
