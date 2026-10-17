import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { consolidate, getConsolidationStatus, type ModelAdapter } from "../src/consolidator.ts";

const digestHeadings = ["Work undertaken", "Outcomes", "Significant decisions", "Changes of plan and interruptions", "Carry-forward items"];
function emptyDigest() { return { projects: [], tags: [], sections: Object.fromEntries(digestHeadings.map((heading) => [heading, []])) }; }
function row(id: string, parentId: string | null, role: string, text: string, timestamp: string, stop = false) {
  return { type: "message", id, parentId, timestamp, message: { role, ...(stop ? { stopReason: "stop" } : {}), content: [{ type: "text", text }] } };
}
function rowPair(day: number, text: string) {
  const date = `2026-10-${String(day).padStart(2, "0")}`;
  return [row(`u${day}`, day === 15 ? null : `a${day - 1}`, "user", text, `${date}T10:00:00.000Z`), row(`a${day}`, `u${day}`, "assistant", "Acknowledged", `${date}T10:01:00.000Z`, true)];
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "samwise-slice2-"));
  const sessions = join(root, "sessions"); const memory = join(root, "memory"); mkdirSync(sessions);
  writeFileSync(join(sessions, "session.jsonl"), `${JSON.stringify({ type: "session", id: "s" })}\n`);
  return { root, sessions, memory };
}
function clean(root: string) { rmSync(root, { recursive: true, force: true }); }
function appendRows(sessions: string, rows: unknown[]) { appendFileSync(join(sessions, "session.jsonl"), `${rows.map((item) => JSON.stringify(item)).join("\n")}\n`); }
function allowedId(prompt: string) { return [...prompt.matchAll(/"source":"([^"]+)"/g)].map((match) => match[1]).at(-1)!; }
function existing(prompt: string) { const line = prompt.split("\n").find((item) => item.startsWith("Existing records (derived context, not new evidence): "))!; return JSON.parse(line.slice(line.indexOf(": ") + 2)); }
function recordFiles(memory: string, folder: string) { const path = join(memory, folder); return existsSync(path) ? readdirSync(path).filter((name) => name.endsWith(".md")).map((name) => join(path, name)) : []; }
function metadata(path: string): any { return parse(readFileSync(path, "utf8").split("---\n")[1].split("\n---")[0]); }
function manualEdit(path: string) {
  const raw = readFileSync(path, "utf8").replace(/^(id: .*)$/m, "$1\nhuman_custom: keep me").replace("## Description", "# Human note\n\n## Description");
  writeFileSync(path, `${raw}\nManual body edit\n`);
}

test("single-span rendered journal recovers every output crash boundary without a model replay", async () => {
  for (let crashAt = 1; crashAt <= 4; crashAt++) {
    const { root, sessions, memory } = setup();
    try {
      appendRows(sessions, rowPair(15, "Work began"));
      let calls = 0;
      const model: ModelAdapter = { async consolidate(prompt) {
        calls++;
        const citation = allowedId(prompt);
        return JSON.stringify({ digest: emptyDigest(), operations: [{
          kind: "create-episode", localKey: "e", fields: { title: "Work item", status: "open", projects: [], tags: [] },
          sections: { Problem: [{ label: "observed", text: "Work started", citations: [citation] }] },
        }, {
          kind: "create-commitment", localKey: "c", fields: { title: "Review results", kind: "request", owner: "George", requested_by: "Samwise", status: "open", next_action: "Review", projects: [] },
          description: { label: "observed", text: "Review requested", citations: [citation] },
        }] });
      } };
      await assert.rejects(consolidate({ sessionsDir: sessions, memoryDir: memory, model, afterOutputWrite: (_kind, index) => { if (index === crashAt) throw new Error(`crash ${crashAt}`); } }), new RegExp(`crash ${crashAt}`));
      await consolidate({ sessionsDir: sessions, memoryDir: memory, model: { async consolidate() { throw new Error("unexpected model replay"); } } });
      assert.equal(calls, 1);
      assert.equal(recordFiles(memory, "episodes").length, 1);
      assert.equal(recordFiles(memory, "commitments").length, 1);
      assert.equal(recordFiles(memory, "digests").length, 1);
      assert.equal(JSON.parse(readFileSync(join(memory, "state.json"), "utf8")).version, 1);
      assert.equal(getConsolidationStatus({ sessionsDir: sessions, memoryDir: memory }).outstandingNewProcessable, 0);
      const episode = readFileSync(recordFiles(memory, "episodes")[0]!, "utf8");
      const commitment = readFileSync(recordFiles(memory, "commitments")[0]!, "utf8");
      assert.doesNotMatch(episode + commitment, /samwise-operation/);
      assert.match(episode, /Work started/); assert.match(commitment, /created \(\*\*observed\*\*\)/);
    } finally { clean(root); }
  }
});

test("routine request progresses through acceptance, blocked, and done across four model runs", async () => {
  const { root, sessions, memory } = setup();
  try {
    const states = ["open", "in-progress", "blocked", "done"] as const; let id = ""; let calls = 0; let coPath = "";
    for (let day = 15; day <= 18; day++) {
      appendRows(sessions, rowPair(day, ["Please review this request", "I accept the request", "The work is blocked pending approval", "The work is complete"][day - 15]));
      const desired = states[day - 15];
      const model: ModelAdapter = { async consolidate(prompt) {
        calls++;
        assert.match(prompt, /routine exchanges do not create episodes/i);
        if (day === 15) {
          assert.match(prompt, /Still record supported requests and commitments/i);
          return JSON.stringify({ digest: emptyDigest(), operations: [{ kind: "create-commitment", localKey: "routine", fields: { title: "Review request", kind: "request", owner: "George", requested_by: "Samwise", status: "open", next_action: "Decide whether to accept", projects: [] }, description: { label: "stated", text: "Please review this request", citations: [allowedId(prompt)] } }] });
        }
        const prior = existing(prompt); assert.equal(prior.commitments.length, 1); assert.equal(prior.commitments[0].id, id); assert.equal(prior.commitments[0].title, "Review request"); assert.equal(prior.commitments[0].owner, "George");
        assert.equal(prior.commitments[0].status, states[day - 16]); assert.ok(prior.commitments[0].next_action);
        const changes: any[] = [{ field: "status", value: desired, label: "observed", citations: [allowedId(prompt)] }, { field: "next_action", value: ["Review", "Begin review", "Obtain approval", "None"][day - 15], label: "observed", citations: [allowedId(prompt)] }];
        if (day === 16) changes.push({ field: "kind", value: "commitment", label: "observed", citations: [allowedId(prompt)] });
        if (day === 17) changes.push({ field: "blocked_on", value: "approval", label: "observed", citations: [allowedId(prompt)] });
        return JSON.stringify({ digest: emptyDigest(), operations: [{ kind: "update-commitment", id, changes }] });
      } };
      await consolidate({ sessionsDir: sessions, memoryDir: memory, model });
      const paths = recordFiles(memory, "commitments"); assert.equal(paths.length, 1); coPath = paths[0];
      const co = metadata(coPath);
      if (day === 15) { id = co.id; assert.equal(co.kind, "request"); manualEdit(coPath); }
      assert.equal(co.status, desired); assert.equal(recordFiles(memory, "episodes").length, 0);
      assert.deepEqual(getConsolidationStatus({ sessionsDir: sessions, memoryDir: memory }).commitments, { open: desired === "open" ? 1 : 0, "in-progress": desired === "in-progress" ? 1 : 0, blocked: desired === "blocked" ? 1 : 0, deferred: 0 });
    }
    assert.equal(calls, 4);
    const raw = readFileSync(coPath, "utf8"); const co = metadata(coPath);
    assert.equal(co.kind, "commitment"); assert.equal(co.status, "done"); assert.equal(co.blocked_on, "approval");
    assert.match(raw, /human_custom: keep me/); assert.match(raw, /Human note/); assert.match(raw, /Manual body edit/);
    for (const token of ["s/a15", "s/a16", "s/a17", "s/a18"]) assert.ok(raw.includes(token));
    for (const marker of ["kind: commitment (**observed**)", "status: in-progress (**observed**)", "status: blocked (**observed**)", "status: done (**observed**)"]) assert.equal(raw.split(marker).length - 1, 1);
    assert.deepEqual(getConsolidationStatus({ sessionsDir: sessions, memoryDir: memory }).commitments, { open: 0, "in-progress": 0, blocked: 0, deferred: 0 });
  } finally { clean(root); }
});

test("pending rendered output refuses a record edited after prepare", async () => {
  const { root, sessions, memory } = setup();
  try {
    appendRows(sessions, rowPair(15, "Please review"));
    const create: ModelAdapter = { async consolidate(prompt) { return JSON.stringify({ digest: emptyDigest(), operations: [{ kind: "create-commitment", localKey: "c", fields: { title: "Review", kind: "request", owner: "George", requested_by: "Samwise", status: "open", next_action: "Review", projects: [] }, description: { label: "stated", text: "Review requested", citations: [allowedId(prompt)] } }] }); } };
    await consolidate({ sessionsDir: sessions, memoryDir: memory, model: create });
    appendRows(sessions, rowPair(16, "Review is complete"));
    const path = recordFiles(memory, "commitments")[0]!;
    const update: ModelAdapter = { async consolidate(prompt) { const id = metadata(path).id; return JSON.stringify({ digest: emptyDigest(), operations: [{ kind: "update-commitment", id, changes: [{ field: "status", value: "done", label: "observed", citations: [allowedId(prompt)] }] }] }); } };
    await assert.rejects(consolidate({ sessionsDir: sessions, memoryDir: memory, model: update, afterPrepare: () => appendFileSync(path, "\\nHuman edit after prepare\\n") }), /edited since prepare; re-run after review/);
  } finally { clean(root); }
});

test("invalid model commitment operations leave prior files untouched", async (t) => {
  await t.test("unknown id", async () => invalidOperation("unknown"));
  await t.test("invalid status", async () => invalidOperation("status"));
  await t.test("forged span citation", async () => invalidOperation("forged"));
  await t.test("context-only prior citation", async () => invalidOperation("context"));
});

async function invalidOperation(kind: "unknown" | "status" | "forged" | "context") {
  const { root, sessions, memory } = setup();
  try {
    appendRows(sessions, rowPair(15, "Please review this request"));
    let id = "";
    const create: ModelAdapter = { async consolidate(prompt) { return JSON.stringify({ digest: emptyDigest(), operations: [{ kind: "create-commitment", localKey: "original", fields: { title: "Review request", kind: "request", owner: "George", requested_by: "Samwise", status: "open", next_action: "Review", projects: [] }, description: { label: "observed", text: "Request", citations: [allowedId(prompt)] } }] }); } };
    await consolidate({ sessionsDir: sessions, memoryDir: memory, model: create });
    const path = recordFiles(memory, "commitments")[0]!; id = metadata(path).id;
    appendRows(sessions, rowPair(16, "A later request update"));
    const before = { record: readFileSync(path), state: readFileSync(join(memory, "state.json")), digest: readFileSync(join(memory, "digests", "2026-10-15.md")) };
    const bad: ModelAdapter = { async consolidate(prompt) {
      const cited = kind === "context" ? "s/a15" : kind === "forged" ? "outside/id" : allowedId(prompt);
      const target = kind === "unknown" ? "missing-id" : id;
      const value = kind === "status" ? "not-a-status" : "done";
      return JSON.stringify({ digest: emptyDigest(), operations: [{ kind: "update-commitment", id: target, changes: [{ field: "status", value, label: "observed", citations: [cited] }] }] });
    } };
    await assert.rejects(consolidate({ sessionsDir: sessions, memoryDir: memory, model: bad }));
    assert.deepEqual(readFileSync(path), before.record); assert.deepEqual(readFileSync(join(memory, "state.json")), before.state); assert.deepEqual(readFileSync(join(memory, "digests", "2026-10-15.md")), before.digest);
    assert.equal(existsSync(join(memory, ".pending-consolidation.json")), false);
  } finally { clean(root); }
}
