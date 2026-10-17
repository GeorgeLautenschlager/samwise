import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planTranscriptSpans, readTranscriptSnapshot } from "../src/transcript.ts";

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
  assert.match(abandoned.processingKey, /:abandoned$/);
  assert.equal(planTranscriptSpans(snapshot).processableCount, 3);
  assert.equal(planTranscriptSpans(snapshot, new Set([abandoned.processingKey])).processableCount, 2);
}));

test("deduplicates clone history with content-derived identity without conflating short IDs", () => fixture((directory) => {
  writeSession(join(directory, "a.jsonl"), [row("u1", null, "user", "one"), row("12345678", "u1", "assistant", "reply one", undefined, "stop")]);
  writeSession(join(directory, "b.jsonl"), [row("u2", null, "user", "two"), row("12345678", "u2", "assistant", "reply two", undefined, "stop")]);
  const snapshot = readTranscriptSnapshot(directory);
  assert.notEqual(snapshot.entries[0].identity, snapshot.entries[1].identity);
  const plan = planTranscriptSpans(snapshot);
  assert.equal(plan.processableCount, 4);
}));

test("defers unfinished user exchange including assistant toolUse and accepts stop/end_turn completion", () => fixture((directory) => {
  writeSession(join(directory, "session.jsonl"), [
    row("u1", null, "user", "done"), row("a1", "u1", "assistant", "answer", undefined, "stop"),
    row("u2", "a1", "user", "unfinished"), row("a2", "u2", "assistant", "calling", undefined, "toolUse"),
  ]);
  const plan = planTranscriptSpans(readTranscriptSnapshot(directory));
  assert.deepEqual(plan.deferredUnfinished.map((entry) => entry.id), ["u2", "a2"]);
  assert.deepEqual(plan.spans.flatMap((span) => span.entries.map((entry) => entry.id)), ["u1", "a1"]);
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
  assert.equal(plan.deferredUnfinished.some((entry) => entry.id === "u1" && entry.sessionPath.endsWith("fork.jsonl")), true);
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
  assert.equal(snapshot.sessions[0].sessionId, sessionId);
  const result = snapshot.entries.find((entry) => entry.id === "result")!;
  assert.equal(result.text, "");
  assert.equal(result.toolResults[0].length <= 507, true);
  assert.equal("raw" in result, false);
  const covered = new Set(snapshot.entries.filter((entry) => ["u1", "call", "result", "answer", "future", "unrelated"].includes(entry.id)).map((entry) => entry.processingKey));
  const plan = planTranscriptSpans(snapshot, covered, 1);
  assert.deepEqual(plan.context.map((entry) => entry.id), ["u1", "call", "result", "answer", "future"]);
  assert.equal(plan.context.some((entry) => entry.id === "unrelated"), false);
}));

test("groups new entries by local day and enforces entry limit even within one exchange", () => fixture((directory) => {
  const rows = [row("u1", null, "user", "one"), row("a1", "u1", "assistant", "one answer", undefined, "end_turn"), row("u2", "a1", "user", "two"), row("a2", "u2", "assistant", "two answer", undefined, "stop")];
  writeSession(join(directory, "session.jsonl"), rows);
  const plan = planTranscriptSpans(readTranscriptSnapshot(directory), new Set(), 3);
  assert.equal(plan.spans.reduce((sum, span) => sum + span.entries.length, 0), 3);
  assert.equal(plan.limitDeferredCount, 1);
  assert.equal(plan.spans.length, 1);
}));

test("reprocesses an entry when its branch classification changes", () => fixture((directory) => {
  const path = join(directory, "session.jsonl");
  writeSession(path, [row("u1", null, "user", "question"), row("a1", "u1", "assistant", "answer", undefined, "stop")]);
  const before = readTranscriptSnapshot(directory);
  const priorKey = before.entries.find((entry) => entry.id === "a1")!.processingKey;
  appendFileSync(path, `${JSON.stringify(row("a2", "u1", "assistant", "new answer", undefined, "stop"))}\n`);
  const after = readTranscriptSnapshot(directory);
  const changed = after.entries.find((entry) => entry.id === "a1")!;
  assert.equal(changed.abandoned, true);
  assert.notEqual(changed.processingKey, priorKey);
  assert.equal(planTranscriptSpans(after, new Set([priorKey])).spans.flatMap((span) => span.entries).some((entry) => entry.id === "a1"), true);
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
  assert.equal(snapshot.incompleteTailCount, 1);
  writeFileSync(path, "{broken}\n");
  assert.throws(() => readTranscriptSnapshot(directory), /Malformed JSONL/);
}));
