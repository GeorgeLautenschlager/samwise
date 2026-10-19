import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { consolidate, type ModelAdapter } from "../src/consolidator.ts";

const headings = ["Work undertaken", "Outcomes", "Significant decisions", "Changes of plan and interruptions", "Carry-forward items"];
function fixture(run: (sessions: string, memory: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "samwise-retry-"));
  const sessions = join(root, "sessions"), memory = join(root, "memory");
  mkdirSync(sessions);
  const rows = [{ type: "session", id: "s-1" }, { type: "message", id: "u1", parentId: null, timestamp: "2026-10-16T10:00:00Z", message: { role: "user", content: [{ type: "text", text: "Record this" }] } }, { type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-16T10:01:00Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] } }];
  writeFileSync(join(sessions, "session.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return run(sessions, memory).finally(() => rmSync(root, { recursive: true, force: true }));
}
function output(citation: string): string {
  return JSON.stringify({ digest: { projects: [], tags: [], sections: Object.fromEntries(headings.map((heading) => [heading, [{ label: "observed", text: "Recorded activity", citations: [citation] }]])) }, operations: [] });
}
test("provides source timestamps and accepts due dates relative to the span date", () => fixture(async (sessions, memory) => {
  let prompt = "";
  const model: ModelAdapter = { async consolidate(value) {
    prompt = value;
    return JSON.stringify({ digest: JSON.parse(output("s-1/u1")).digest, operations: [{
      kind: "create-commitment", localKey: "tomorrow", fields: { title: "Record this", kind: "request", owner: "George", requested_by: "George", due: "2026-10-17", status: "open", next_action: "Record this", projects: [] },
      description: { label: "stated", text: "Record this tomorrow", citations: ["s-1/u1"] },
    }] });
  } };
  await consolidate({ sessionsDir: sessions, memoryDir: memory, model });
  assert.match(prompt, /Processing span local date: 2026-10-16/);
  assert.match(prompt, /"timestamp":"2026-10-16T10:00:00Z"/);
  assert.match(prompt, /not the current wall-clock date/);
  const record = readFileSync(join(memory, "commitments", readdirSync(join(memory, "commitments"))[0]), "utf8");
  assert.match(record, /due: 2026-10-17/);
}));
test("retries a validation error once with the validation error only", () => fixture(async (sessions, memory) => {
  const prompts: string[] = [];
  const model: ModelAdapter = { async consolidate(prompt) { prompts.push(prompt); return prompts.length === 1 ? output("session/id") : output("s-1/u1"); } };
  const result = await consolidate({ sessionsDir: sessions, memoryDir: memory, model });
  assert.deepEqual(result.validationCorrections, [{ date: "2026-10-16", error: "Model returned invalid item/citation in Work undertaken item 1: [redacted]", operationCounts: { "create-episode": 0, "update-episode": 0, "create-commitment": 0, "update-commitment": 0 } }]);
  assert.doesNotMatch(JSON.stringify(result), /session\/id/);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /invalid item\/citation in Work undertaken item 1: unknown citation "session\/id"/i);
  assert.match(prompts[1], /Validation error:/);
  assert.doesNotMatch(prompts[1], /Previous response/);
  assert.equal(readFileSync(join(memory, "digests", "2026-10-16.md"), "utf8").includes("session/id"), false);
  assert.equal(JSON.parse(readFileSync(join(memory, "state.json"), "utf8")).processedIdentities.length, 2);
}));
test("correction that drops a malformed episode reports the retry and zero episode creates", () => fixture(async (sessions, memory) => {
  const prompts: string[] = [];
  const commitment = { kind: "create-commitment", localKey: "record", fields: { title: "Record this", kind: "request", owner: "Samwise", requested_by: "George", status: "open", next_action: "Record this", projects: [] }, description: { label: "stated", text: "Record this", citations: ["s-1/u1"] } };
  const malformedEpisode = { kind: "create-episode", localKey: "decision", fields: { title: "Approach", status: "open", projects: [], tags: [] }, sections: { Outcome: "not an array" } };
  const model: ModelAdapter = { async consolidate(prompt) {
    prompts.push(prompt);
    return JSON.stringify({ digest: JSON.parse(output("s-1/u1")).digest, operations: prompts.length === 1 ? [malformedEpisode, commitment] : [commitment] });
  } };
  const result = await consolidate({ sessionsDir: sessions, memoryDir: memory, model });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Validation error: Invalid episode sections: Outcome must be an array/);
  assert.deepEqual(result.validationCorrections, [{ date: "2026-10-16", error: "Invalid episode sections: [redacted]", operationCounts: { "create-episode": 1, "update-episode": 0, "create-commitment": 1, "update-commitment": 0 } }]);
  assert.deepEqual(result.operationCounts, { "create-episode": 0, "update-episode": 0, "create-commitment": 1, "update-commitment": 0 });
  assert.equal(result.processedEntries, 2);
  assert.equal(existsSync(join(memory, "episodes")), false);
  assert.equal(readdirSync(join(memory, "commitments")).length, 1);
  assert.equal(JSON.parse(readFileSync(join(memory, "state.json"), "utf8")).processedIdentities.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /not an array|Record this|Approach/);
}));
test("rejected operation counts include only known kinds even when digest validation fails", () => fixture(async (sessions, memory) => {
  let calls = 0;
  const model: ModelAdapter = { async consolidate() {
    if (++calls > 1) return output("s-1/u1");
    return JSON.stringify({ ...JSON.parse(output("bad/id")), operations: [
      { kind: "create-episode" }, { kind: "create-episode" }, { kind: "update-episode" },
      { kind: "create-commitment" }, { kind: "update-commitment" },
      { kind: "private-model-value" }, { kind: "__proto__" }, { kind: "constructor" }, { kind: ["create-episode"] }, null,
    ] });
  } };
  const result = await consolidate({ sessionsDir: sessions, memoryDir: memory, model });
  assert.deepEqual(result.validationCorrections, [{ date: "2026-10-16", error: "Model returned invalid item/citation in Work undertaken item 1: [redacted]", operationCounts: { "create-episode": 2, "update-episode": 1, "create-commitment": 1, "update-commitment": 1 } }]);
  assert.doesNotMatch(JSON.stringify(result), /private-model-value|__proto__|constructor|bad\/id/);
}));
test("an invalid envelope omits rejected operation counts", () => fixture(async (sessions, memory) => {
  let calls = 0;
  const model: ModelAdapter = { async consolidate() { return ++calls === 1 ? '{"operations":[{"kind":"create-episode"}]}' : output("s-1/u1"); } };
  const result = await consolidate({ sessionsDir: sessions, memoryDir: memory, model });
  assert.deepEqual(result.validationCorrections, [{ date: "2026-10-16", error: "Model returned invalid consolidation envelope" }]);
}));
test("two invalid outputs fail without writing outputs, journal, or state", () => fixture(async (sessions, memory) => {
  let calls = 0;
  const model: ModelAdapter = { async consolidate() { calls++; return output("s-1/not-allowed"); } };
  await assert.rejects(consolidate({ sessionsDir: sessions, memoryDir: memory, model }), /^Error: Model returned invalid item\/citation in Work undertaken item 1: \[redacted\]$/);
  assert.equal(calls, 2);
  assert.equal(existsSync(join(memory, ".pending-consolidation.json")), false);
  assert.equal(existsSync(join(memory, "state.json")), false);
  assert.equal(readdirSync(join(memory, "digests")).length, 0);
}));
test("invalid record targets use ordinary validation retry and leave prior outputs untouched", async () => {
  for (const kind of ["episode", "commitment"] as const) await fixture(async (sessions, memory) => {
    const records = join(memory, kind === "episode" ? "episodes" : "commitments");
    let initialCalls = 0;
    const initialModel: ModelAdapter = { async consolidate() {
      initialCalls++;
      const digest = JSON.parse(output("s-1/u1")).digest;
      const operation = kind === "episode"
        ? { kind: "create-episode", localKey: "broken-target", fields: { title: "Target", status: "open", projects: [], tags: [] }, sections: { Outcome: [{ label: "observed", text: "Created", citations: ["s-1/u1"] }] } }
        : { kind: "create-commitment", localKey: "broken-target", fields: { title: "Target", kind: "request", owner: "George", requested_by: "George", status: "open", next_action: "Act", projects: [] }, description: { label: "stated", text: "Record this", citations: ["s-1/u1"] } };
      return JSON.stringify({ digest, operations: [operation] });
    } };
    await consolidate({ sessionsDir: sessions, memoryDir: memory, model: initialModel });
    assert.equal(initialCalls, 1);
    const recordPath = join(records, readdirSync(records)[0]);
    const originalRecord = readFileSync(recordPath, "utf8");
    const id = originalRecord.match(/^id: ([^\n]+)$/m)![1].replace(/^['"]|['"]$/g, "");
    const brokenRecord = originalRecord.replace("status: open", "status: invalid");
    writeFileSync(recordPath, brokenRecord);
    writeFileSync(join(sessions, "session.jsonl"), readFileSync(join(sessions, "session.jsonl"), "utf8") + [
      { type: "message", id: "u2", parentId: "a1", timestamp: "2026-10-16T10:02:00Z", message: { role: "user", content: [{ type: "text", text: "Update this" }] } },
      { type: "message", id: "a2", parentId: "u2", timestamp: "2026-10-16T10:03:00Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Done" }] } },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");
    const priorState = readFileSync(join(memory, "state.json"), "utf8");
    const priorDigest = readFileSync(join(memory, "digests", "2026-10-16.md"), "utf8");
    let calls = 0;
    const retryModel: ModelAdapter = { async consolidate() {
      calls++;
      const operation = kind === "episode"
        ? { kind: "update-episode", id, fields: { status: "resolved" }, sections: { Outcome: [{ label: "observed", text: "Updated", citations: ["s-1/u2"] }] } }
        : { kind: "update-commitment", id, changes: [{ field: "status", value: "done", label: "observed", citations: ["s-1/u2"] }] };
      return JSON.stringify({ digest: JSON.parse(output("s-1/u2")).digest, operations: [operation] });
    } };
    await assert.rejects(consolidate({ sessionsDir: sessions, memoryDir: memory, model: retryModel }), /invalid episode update target|Cannot update invalid record/);
    assert.equal(calls, 2);
    assert.equal(readFileSync(recordPath, "utf8"), brokenRecord);
    assert.equal(readFileSync(join(memory, "state.json"), "utf8"), priorState);
    assert.equal(readFileSync(join(memory, "digests", "2026-10-16.md"), "utf8"), priorDigest);
    assert.equal(existsSync(join(memory, ".pending-consolidation.json")), false);
  });
});
test("retries plain stream-aborted and request-timed-out errors once per span", async () => {
  for (const message of ["Stream aborted", "request timed out", "Configured model did not complete normally (aborted)"]) await fixture(async (sessions, memory) => {
    let calls = 0;
    const model: ModelAdapter = { async consolidate() { if (++calls === 1) throw new Error(message); return output("s-1/u1"); } };
    await consolidate({ sessionsDir: sessions, memoryDir: memory, model });
    assert.equal(calls, 2);
  });
});
test("exhausted transient provider retry fails after two calls", () => fixture(async (sessions, memory) => {
  let calls = 0;
  const model: ModelAdapter = { async consolidate() { calls++; throw Object.assign(new Error("aborted"), { name: "AbortError" }); } };
  await assert.rejects(consolidate({ sessionsDir: sessions, memoryDir: memory, model }), /aborted/);
  assert.equal(calls, 2);
}));
test("nontransient provider errors are not retried", () => fixture(async (sessions, memory) => {
  let calls = 0;
  const model: ModelAdapter = { async consolidate() { calls++; throw new Error("provider unavailable"); } };
  await assert.rejects(consolidate({ sessionsDir: sessions, memoryDir: memory, model }), /provider unavailable/);
  assert.equal(calls, 1);
}));
test("provider and validation retries are independently bounded in provider-then-validation order", () => fixture(async (sessions, memory) => {
  let calls = 0;
  const model: ModelAdapter = { async consolidate() {
    calls++;
    if (calls === 1) throw new Error("stream aborted");
    return calls === 2 ? output("bad/id") : output("s-1/u1");
  } };
  await consolidate({ sessionsDir: sessions, memoryDir: memory, model });
  assert.equal(calls, 3);
}));
test("provider and validation retries are independently bounded in validation-then-provider order", () => fixture(async (sessions, memory) => {
  let calls = 0;
  const model: ModelAdapter = { async consolidate() {
    calls++;
    if (calls === 1) return output("bad/id");
    if (calls === 2) throw new Error("request timed out");
    return output("s-1/u1");
  } };
  await consolidate({ sessionsDir: sessions, memoryDir: memory, model });
  assert.equal(calls, 3);
}));
test("malformed JSON gets one validation retry", () => fixture(async (sessions, memory) => {
  let calls = 0;
  const model: ModelAdapter = { async consolidate() { return ++calls === 1 ? "not json" : output("s-1/u1"); } };
  const result = await consolidate({ sessionsDir: sessions, memoryDir: memory, model });
  assert.equal(calls, 2);
  assert.deepEqual(result.validationCorrections, [{ date: "2026-10-16", error: "SyntaxError" }]);
  assert.doesNotMatch(JSON.stringify(result), /not json/);
}));
test("exhausted malformed JSON retry reports only the error name and keeps parser details in the retry prompt", () => fixture(async (sessions, memory) => {
  const prompts: string[] = [];
  const raw = "private-model-value is not JSON";
  let parserMessage = "";
  try { JSON.parse(raw); } catch (error) { parserMessage = (error as Error).message; }
  const model: ModelAdapter = { async consolidate(prompt) { prompts.push(prompt); return raw; } };
  await assert.rejects(consolidate({ sessionsDir: sessions, memoryDir: memory, model }), { message: "SyntaxError" });
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].endsWith(`Validation error: ${parserMessage}`));
  assert.equal(existsSync(join(memory, "state.json")), false);
  assert.equal(existsSync(join(memory, ".pending-consolidation.json")), false);
}));
test("failed multi-operation candidate does not leak virtual records into retry context", () => fixture(async (sessions, memory) => {
  const prompts: string[] = [];
  const model: ModelAdapter = { async consolidate(prompt) {
    prompts.push(prompt);
    if (prompts.length === 1) return JSON.stringify({ digest: { projects: [], tags: [], sections: Object.fromEntries(headings.map((heading) => [heading, []])) }, operations: [
      { kind: "create-episode", localKey: "candidate", fields: { title: "Candidate", status: "open", projects: [], tags: [] }, sections: { Outcome: [{ label: "observed", text: "Created", citations: ["s-1/u1"] }] } },
      { kind: "update-episode", id: "not-present", fields: { status: "resolved" }, sections: { Outcome: [{ label: "observed", text: "Invalid", citations: ["s-1/u1"] }] } },
    ] });
    const digest = JSON.parse(output("s-1/u1")).digest;
    return JSON.stringify({ digest, operations: [{ kind: "create-episode", localKey: "accepted", fields: { title: "Accepted", status: "open", projects: [], tags: [] }, sections: { Outcome: [{ label: "observed", text: "Created after retry", citations: ["s-1/u1"] }] } }] });
  } };
  await consolidate({ sessionsDir: sessions, memoryDir: memory, model });
  assert.equal(prompts.length, 2);
  const context = JSON.parse(prompts[1].split("\n").find((line) => line.startsWith("Existing records"))!.split(": ").slice(1).join(": "));
  assert.deepEqual(context.episodes, []);
  assert.equal(readdirSync(join(memory, "episodes")).length, 1);
}));
