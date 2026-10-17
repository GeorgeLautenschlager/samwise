import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { consolidate, getConsolidationStatus, resolveMemoryDir, type ModelAdapter } from "../src/consolidator.ts";
import { parse } from "yaml";

async function fixture(run: (root: string, sessions: string, memory: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "samwise-memory-"));
  const sessions = join(root, "sessions"); const memory = join(root, "memory");
  try { await run(root, sessions, memory); } finally { rmSync(root, { recursive: true, force: true }); }
}
function row(id: string, parentId: string | null, role: string, text: string, timestamp = "2026-10-16T10:00:00.000Z", stopReason?: string) {
  return { type: "message", id, parentId, timestamp, message: { role, ...(stopReason ? { stopReason } : {}), content: [{ type: "text", text }] } };
}
function writeSession(directory: string, rows: unknown[]): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "session.jsonl"), `${JSON.stringify({ type: "session", id: "s-1" })}\n${rows.map((item) => JSON.stringify(item)).join("\n")}\n`);
}
function validModel(onCall: (prompt: string) => void = () => {}): ModelAdapter {
  return { async consolidate(prompt) {
    onCall(prompt);
    const citations = [...prompt.matchAll(/"source":"([^"]+)"/g)].map((match) => match[1]);
    const unique = [...new Set(citations)];
    const sections: Record<string, unknown[]> = {};
    for (const heading of ["Work undertaken", "Outcomes", "Significant decisions", "Changes of plan and interruptions", "Carry-forward items"]) sections[heading] = [{ label: "observed", text: "Recorded activity", citations: unique.slice(-1) }];
    return JSON.stringify({ projects: ["demo"], tags: ["work"], sections });
  } };
}
function metadata(path: string): any { return parse(readFileSync(path, "utf8").split("---\n")[1].split("\n---")[0]); }

test("same-day limited runs revise one digest and extend plain sources", async () => fixture(async (_root, sessions, memory) => {
  writeSession(sessions, [row("u1", null, "user", "first"), row("a1", "u1", "assistant", "done", undefined, "stop")]);
  const calls: string[] = [];
  await consolidate({ sessionsDir: sessions, memoryDir: memory, maxEntries: 1, model: validModel((prompt) => calls.push(prompt)) });
  await consolidate({ sessionsDir: sessions, memoryDir: memory, maxEntries: 1, model: validModel((prompt) => calls.push(prompt)) });
  const digest = join(memory, "digests", "2026-10-16.md");
  const content = readFileSync(digest, "utf8");
  const front = metadata(digest);
  assert.equal(readdirSync(join(memory, "digests")).filter((name) => name === "2026-10-16.md").length, 1);
  assert.deepEqual(Object.keys(front).sort(), ["date", "derived", "projects", "sources", "tags", "type"]);
  assert.deepEqual(front.sources, [{ sessionId: "s-1", entryIds: ["u1", "a1"] }]);
  assert.equal((content.match(/## Work undertaken/g) ?? []).length, 1);
  assert.equal(calls.length, 2);
}));

test("plain digest sources recover a crash before state and process only remaining entries", async () => fixture(async (_root, sessions, memory) => {
  writeSession(sessions, [row("u1", null, "user", "first"), row("a1", "u1", "assistant", "done", undefined, "stop"), row("u2", "a1", "user", "second"), row("a2", "u2", "assistant", "done", undefined, "stop")]);
  await assert.rejects(consolidate({ sessionsDir: sessions, memoryDir: memory, maxEntries: 2, model: validModel(), afterDigestWrite: () => { throw new Error("simulated crash"); } }), /simulated crash/);
  assert.equal(getConsolidationStatus({ sessionsDir: sessions, memoryDir: memory }).lastSuccessfulRun, null);
  const prompts: string[] = [];
  await consolidate({ sessionsDir: sessions, memoryDir: memory, maxEntries: 2, model: validModel((prompt) => prompts.push(prompt)) });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /"source":"s-1\/u2"/);
  const front = metadata(join(memory, "digests", "2026-10-16.md"));
  assert.deepEqual(front.sources, [{ sessionId: "s-1", entryIds: ["u1", "a1", "u2", "a2"] }]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(memory, "state.json"), "utf8"))).sort(), ["lastSuccessfulRun", "processedIdentities", "version"]);
  assert.equal(JSON.parse(readFileSync(join(memory, "state.json"), "utf8")).version, 1);
}));

test("crash recovery deduplicates cloned entries after parent rewiring and dropped branch labels", async () => fixture(async (_root, sessions, memory) => {
  mkdirSync(sessions, { recursive: true });
  const user = row("u1", null, "user", "first");
  const answer = row("a1", "branch-label", "assistant", "done", undefined, "stop");
  const nextUser = row("u2", "a1", "user", "second", "2026-10-16T11:00:00.000Z");
  const nextAnswer = row("a2", "u2", "assistant", "done", "2026-10-16T11:01:00.000Z", "stop");
  writeFileSync(join(sessions, "original.jsonl"), `${JSON.stringify({ type: "session", id: "original" })}\n${JSON.stringify(user)}\n${JSON.stringify({ type: "label", id: "branch-label", parentId: "u1", timestamp: "2026-10-16T10:00:30.000Z", text: "temporary branch" })}\n${JSON.stringify(answer)}\n${JSON.stringify(nextUser)}\n${JSON.stringify(nextAnswer)}\n`);
  writeFileSync(join(sessions, "clone.jsonl"), `${JSON.stringify({ type: "session", id: "clone" })}\n${JSON.stringify(user)}\n${JSON.stringify({ ...answer, parentId: "u1" })}\n`);
  await assert.rejects(consolidate({ sessionsDir: sessions, memoryDir: memory, maxEntries: 2, model: validModel(), afterDigestWrite: () => { throw new Error("simulated crash"); } }), /simulated crash/);
  const prompts: string[] = [];
  await consolidate({ sessionsDir: sessions, memoryDir: memory, model: validModel((prompt) => prompts.push(prompt)) });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /"source":"original\/u2"/);
  assert.doesNotMatch(prompts[0], /"source":"clone\/(?:u1|a1)"/);
  assert.deepEqual(metadata(join(memory, "digests", "2026-10-16.md")).sources, [{ sessionId: "original", entryIds: ["u1", "a1", "u2", "a2"] }]);
}));

test("multi-day partial commit recovers from digest-before-state interruption without skipping dates", async () => fixture(async (_root, sessions, memory) => {
  writeSession(sessions, [row("u1", null, "user", "one", "2026-10-15T10:00:00Z"), row("a1", "u1", "assistant", "done", "2026-10-15T10:01:00Z", "stop"), row("u2", "a1", "user", "two", "2026-10-16T10:00:00Z"), row("a2", "u2", "assistant", "done", "2026-10-16T10:01:00Z", "stop")]);
  let written = 0;
  await assert.rejects(consolidate({ sessionsDir: sessions, memoryDir: memory, model: validModel(), afterDigestWrite: () => { if (++written === 1) throw new Error("interrupted between dates"); } }), /interrupted between dates/);
  assert.equal(existsSync(join(memory, "state.json")), false);
  assert.equal(existsSync(join(memory, "digests", "2026-10-15.md")), true);
  assert.equal(existsSync(join(memory, "digests", "2026-10-16.md")), false);
  const prompts: string[] = [];
  await consolidate({ sessionsDir: sessions, memoryDir: memory, model: validModel((prompt) => prompts.push(prompt)) });
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].includes('"source":"s-1/u2"'), true);
  assert.equal(existsSync(join(memory, "digests", "2026-10-16.md")), true);
}));

test("prepares every date before writing and leaves earlier state untouched on model failure", async () => fixture(async (_root, sessions, memory) => {
  writeSession(sessions, [row("u1", null, "user", "one", "2026-10-15T10:00:00Z"), row("a1", "u1", "assistant", "done", "2026-10-15T10:01:00Z", "stop"), row("u2", "a1", "user", "two", "2026-10-16T10:00:00Z"), row("a2", "u2", "assistant", "done", "2026-10-16T10:01:00Z", "stop")]);
  mkdirSync(memory, { recursive: true });
  const statePath = join(memory, "state.json");
  const oldState = '{"version":1,"processedIdentities":[],"lastSuccessfulRun":"2026-10-14T00:00:00Z"}\n';
  writeFileSync(statePath, oldState);
  let calls = 0;
  const model: ModelAdapter = { async consolidate(prompt) { calls++; if (calls === 2) throw new Error("model failed"); return validModel().consolidate(prompt); } };
  await assert.rejects(consolidate({ sessionsDir: sessions, memoryDir: memory, model }), /model failed/);
  assert.equal(readdirSync(memory).includes("digests"), true);
  assert.equal(readdirSync(join(memory, "digests")).length, 0);
  assert.equal(readFileSync(statePath, "utf8"), oldState);
}));

test("dry-run does not create store, invoke model, or write a lock", async () => fixture(async (_root, sessions, memory) => {
  writeSession(sessions, [row("u1", null, "user", "question"), row("a1", "u1", "assistant", "answer", undefined, "stop")]);
  let calls = 0;
  const result = await consolidate({ sessionsDir: sessions, memoryDir: memory, dryRun: true, model: validModel(() => calls++) });
  assert.match(result.plan.join("\n"), /2026-10-16: s-1 — u1\.\.a1/);
  assert.equal(calls, 0);
  assert.equal(existsSync(memory), false);
  getConsolidationStatus({ sessionsDir: sessions, memoryDir: memory });
  assert.equal(existsSync(memory), false);
}));

test("dry-run and status preserve an existing store byte-for-byte", async () => fixture(async (_root, sessions, memory) => {
  writeSession(sessions, [row("u1", null, "user", "question"), row("a1", "u1", "assistant", "answer", undefined, "stop")]);
  mkdirSync(join(memory, "digests"), { recursive: true });
  writeFileSync(join(memory, "state.json"), '{"version":1,"processedIdentities":[],"lastSuccessfulRun":null}\n');
  writeFileSync(join(memory, "digests", "old.md"), '---\ntype: digest\ndate: 2026-10-15\nderived: true\nprojects: []\ntags: []\nsources:\n  - sessionId: old-session\n    entryIds:\n      - old-entry\n---\n\n## Work undertaken\n- None recorded.\n');
  const snapshot = (directory: string): Array<[string, "directory" | Buffer]> => {
    const result: Array<[string, "directory" | Buffer]> = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { result.push([path, "directory"], ...snapshot(path)); }
      else result.push([path, readFileSync(path)]);
    }
    return result.sort(([a], [b]) => a.localeCompare(b));
  };
  const before = snapshot(memory);
  await consolidate({ sessionsDir: sessions, memoryDir: memory, dryRun: true });
  assert.deepEqual(snapshot(memory), before);
  getConsolidationStatus({ sessionsDir: sessions, memoryDir: memory });
  assert.deepEqual(snapshot(memory), before);
}));

test("a live lock blocks consolidation without writing store files", async () => fixture(async (_root, sessions, memory) => {
  writeSession(sessions, [row("u1", null, "user", "question"), row("a1", "u1", "assistant", "answer", undefined, "stop")]);
  mkdirSync(memory, { recursive: true });
  const lockPath = join(memory, ".consolidate.lock");
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));
  const before = readdirSync(memory).sort();
  await assert.rejects(consolidate({ sessionsDir: sessions, memoryDir: memory, model: validModel() }), /owner PID .*PID alive/);
  assert.deepEqual(readdirSync(memory).sort(), before);
  assert.equal(existsSync(join(memory, "digests")), false);
}));

test("an existing stale lock blocks consolidation and status reports it without writes", async () => fixture(async (_root, sessions, memory) => {
  writeSession(sessions, [row("u1", null, "user", "question"), row("a1", "u1", "assistant", "answer", undefined, "stop")]);
  mkdirSync(memory, { recursive: true });
  const lockPath = join(memory, ".consolidate.lock");
  writeFileSync(lockPath, JSON.stringify({ pid: 2_000_000_000 }));
  const before = readdirSync(memory).sort();
  const status = getConsolidationStatus({ sessionsDir: sessions, memoryDir: memory });
  assert.equal(status.lock?.path, lockPath);
  assert.equal(status.lock?.ownerPid, 2_000_000_000);
  assert.equal(status.lock?.ownerAlive, false);
  assert.equal(status.lock?.removeCommand, `rm -f -- '${lockPath}'`);
  assert.deepEqual(readdirSync(memory).sort(), before);
  await assert.rejects(consolidate({ sessionsDir: sessions, memoryDir: memory, model: validModel() }), new RegExp(`Consolidation lock exists at ${lockPath.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`));
  assert.equal(existsSync(lockPath), true);
  assert.deepEqual(readdirSync(memory).sort(), before);
}));

test("resolveMemoryDir applies explicit, nonempty environment, and default precedence", () => {
  const prior = process.env.SAMWISE_MEMORY_DIR;
  try {
    process.env.SAMWISE_MEMORY_DIR = "/tmp/env-memory";
    assert.equal(resolveMemoryDir("/tmp/explicit"), "/tmp/explicit");
    assert.equal(resolveMemoryDir(), "/tmp/env-memory");
    process.env.SAMWISE_MEMORY_DIR = "";
    assert.equal(resolveMemoryDir(), join(homedir(), ".samwise", "memory"));
  } finally {
    if (prior === undefined) delete process.env.SAMWISE_MEMORY_DIR;
    else process.env.SAMWISE_MEMORY_DIR = prior;
  }
});

test("consolidation status uses frozen source snapshot after commit", async () => fixture(async (_root, sessions, memory) => {
  writeSession(sessions, [row("u1", null, "user", "question"), row("a1", "u1", "assistant", "answer", undefined, "stop")]);
  const sessionPath = join(sessions, "session.jsonl");
  const result = await consolidate({ sessionsDir: sessions, memoryDir: memory, model: validModel(() => appendFileSync(sessionPath, "{malformed}\n")) });
  assert.equal(result.status.outstandingNewProcessable, 0);
  assert.throws(() => getConsolidationStatus({ sessionsDir: sessions, memoryDir: memory }), /Malformed JSONL/);
}));

test("status reports outstanding processable and deferred unfinished entries", () => fixture((_root, sessions, memory) => {
  writeSession(sessions, [row("u1", null, "user", "completed"), row("a1", "u1", "assistant", "answer", undefined, "stop"), row("u2", "a1", "user", "unfinished")]);
  const status = getConsolidationStatus({ sessionsDir: sessions, memoryDir: memory });
  assert.equal(status.outstandingNewProcessable, 2);
  assert.equal(status.deferredUnfinished, 1);
}));

test("prompt preserves provenance, labels, abandoned exploration, and tool details", async () => fixture(async (_root, sessions, memory) => {
  const toolCall = { type: "message", id: "tool", parentId: "u1", timestamp: "2026-10-16T10:01:00Z", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "shell", arguments: { cmd: "inspect" } }] } };
  writeSession(sessions, [row("u1", null, "user", "I choose A"), row("abandoned", "u1", "assistant", "abandoned exploration", "2026-10-16T10:00:30Z", "stop"), toolCall, { type: "message", id: "result", parentId: "tool", timestamp: "2026-10-16T10:02:00Z", message: { role: "toolResult", content: [{ type: "text", text: "observed result" }] } }, row("a1", "result", "assistant", "done", "2026-10-16T10:03:00Z", "stop")]);
  let prompt = "";
  await consolidate({ sessionsDir: sessions, memoryDir: memory, model: validModel((value) => { prompt = value; }) });
  assert.match(prompt, /Preserve uncertainty/);
  assert.match(prompt, /session-id\/entry-id/);
  assert.match(prompt, /shell/);
  assert.match(prompt, /observed result/);
  assert.match(prompt, /abandoned exploration/);
}));

test("status excludes deferred duplicate keys processable through a completed copy", () => fixture((_root, sessions, memory) => {
  mkdirSync(sessions, { recursive: true });
  const user = row("u1", null, "user", "question");
  const answer = row("a1", "u1", "assistant", "answer", undefined, "stop");
  writeFileSync(join(sessions, "unfinished.jsonl"), `${JSON.stringify({ type: "session", id: "unfinished" })}\n${JSON.stringify(user)}\n`);
  writeFileSync(join(sessions, "complete.jsonl"), `${JSON.stringify({ type: "session", id: "complete" })}\n${JSON.stringify(user)}\n${JSON.stringify(answer)}\n`);
  assert.equal(getConsolidationStatus({ sessionsDir: sessions, memoryDir: memory }).deferredUnfinished, 0);
}));

test("CLI status invocation reports JSON and honors directory flags", () => fixture((_root, sessions, memory) => {
  writeSession(sessions, [row("u1", null, "user", "question"), row("a1", "u1", "assistant", "answer", undefined, "stop")]);
  const output = execFileSync(process.execPath, ["--experimental-strip-types", new URL("../src/cli.ts", import.meta.url).pathname, "status", "--sessions-dir", sessions, "--memory-dir", memory], { encoding: "utf8" });
  assert.equal(JSON.parse(output).outstandingNewProcessable, 2);
}));

test("rejects non-string project and tag metadata on a later date without changing state", async () => fixture(async (_root, sessions, memory) => {
  writeSession(sessions, [row("u1", null, "user", "one", "2026-10-15T10:00:00Z"), row("a1", "u1", "assistant", "done", "2026-10-15T10:01:00Z", "stop"), row("u2", "a1", "user", "two", "2026-10-16T10:00:00Z"), row("a2", "u2", "assistant", "done", "2026-10-16T10:01:00Z", "stop")]);
  mkdirSync(memory, { recursive: true });
  const statePath = join(memory, "state.json");
  const oldState = '{"version":1,"processedIdentities":[],"lastSuccessfulRun":"2026-10-14T00:00:00Z"}\n';
  writeFileSync(statePath, oldState);
  let calls = 0;
  const model: ModelAdapter = { async consolidate(prompt) {
    if (++calls === 1) return validModel().consolidate(prompt);
    const headings = ["Work undertaken", "Outcomes", "Significant decisions", "Changes of plan and interruptions", "Carry-forward items"];
    return JSON.stringify({ projects: ["valid", 7], tags: ["valid", false], sections: Object.fromEntries(headings.map((heading) => [heading, [{ label: "observed", text: "ok", citations: ["s-1/u2"] }]])) });
  } };
  await assert.rejects(consolidate({ sessionsDir: sessions, memoryDir: memory, model }), /invalid projects or tags/);
  assert.equal(calls, 2);
  assert.equal(readFileSync(statePath, "utf8"), oldState);
  assert.equal(readdirSync(join(memory, "digests")).length, 0);
}));

test("rejects model citations outside source entries before writing", async () => fixture(async (_root, sessions, memory) => {
  writeSession(sessions, [row("u1", null, "user", "question"), row("a1", "u1", "assistant", "answer", undefined, "stop")]);
  const bad: ModelAdapter = { async consolidate() { return JSON.stringify({ projects: [], tags: [], sections: Object.fromEntries(["Work undertaken", "Outcomes", "Significant decisions", "Changes of plan and interruptions", "Carry-forward items"].map((name) => [name, [{ label: "made-up", text: "bad", citations: ["wrong/id"] }]])) }); } };
  await assert.rejects(consolidate({ sessionsDir: sessions, memoryDir: memory, model: bad }), /invalid item\/citation/);
  assert.equal(existsSync(join(memory, "state.json")), false);
}));
