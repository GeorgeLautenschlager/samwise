import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getConsolidationStatus } from "../src/consolidator.ts";
import { recall } from "../src/recall.ts";
import { resolveDefaultSessionsDir } from "../src/sessions.ts";

function fixture(root: string, kind: string, filename: string, frontmatter: string, body: string, sources = "  - sessionId: sess\n    entryIds: [e1]"): void {
  const dir = join(root, kind === "digest" ? "digests" : kind === "episode" ? "episodes" : "commitments");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), `---\ntype: ${kind}\n${frontmatter}\nderived: true\nsources:\n${sources}\n---\n${body}\n`);
}

test("recall filters, ranks by score, bounds results, and returns original excerpts", () => {
  const root = mkdtempSync(join(tmpdir(), "samwise-recall-"));
  try {
    fixture(root, "digest", "older.md", "date: 2025-01-02\nprojects: [Alpha]", `Prose before headings has searchable marker.\n\n${"filler ".repeat(70)}\n\n## Outcomes\n- Shared durable garden plan with clues.`);
    fixture(root, "digest", "newer.md", "date: 2025-02-02\nprojects: [Alpha]", "## Outcomes\n- Garden maintenance notes and garden plan.");
    fixture(root, "digest", "title-hit.md", "date: 2020-01-01\ntitle: Garden plan", "## Outcomes\n- Brief note.");
    fixture(root, "digest", "repeat-hit.md", "date: 2020-01-02", "garden garden garden plan plan.");
    fixture(root, "episode", "garden.md", "title: Garden episode\nstatus: open\nupdated: 2025-02-03\nprojects: [Beta]", "## Problem\n- GARDEN planning with useful details.");
    fixture(root, "commitment", "one.md", "title: Garden task\nstatus: blocked\nupdated: 2025-02-04\nprojects: [Alpha]", "## Description\n- garden task.");
    fixture(root, "commitment", "open.md", "title: Open commitment\nstatus: open\nupdated: 2025-02-05", "## Description\n- follow up.");
    fixture(root, "commitment", "old-open.md", "title: Old commitment\nstatus: open\nupdated: 2024-01-01", "## Description\n- archived.");
    fixture(root, "digest", "wrong-type.md", "type: episode\ndate: 2025-03-01", "garden plan");
    writeFileSync(join(root, "digests", "malformed.md"), "---\ntype: [broken\n---\ngarden plan");
    const large = "x".repeat(20_000);
    fixture(root, "digest", "huge.md", `date: 2025-03-02\nlarge_metadata: ${large}\nprojects: [Alpha]`, `${large} garden plan ${large}`);
    const longSources = Array.from({ length: 8 }, (_, source) => `  - sessionId: ${"s".repeat(80)}${source}\n    entryIds: [${Array.from({ length: 5 }, () => "e".repeat(80)).join(", ")}]`).join("\n");
    for (let index = 0; index < 25; index++) fixture(root, "episode", `many-${index}.md`, `title: Garden many ${index}\nstatus: open\nupdated: 2025-02-03\nprojects: [Beta]`, `garden plan ${"details ".repeat(50)}`, longSources);

    assert.equal(recall("", { type: "digest", project: "alpha" }, 10, root).length, 3);
    assert.equal(recall("garden plan", { status: "open", from: "2025-02-01", to: "2025-02-28" }, 10, root)[0]?.type, "episode");
    const ranked = recall("garden plan", { type: "digest" }, 10, root);
    assert.equal(ranked[0]?.titleOrDate, "Garden plan", "older title match outranks newer body-only result");
    assert.equal(ranked.find((item) => item.titleOrDate === "2020-01-02")?.path.endsWith("repeat-hit.md"), true, "older repeated hits outrank newer body-only result");
    assert.equal(ranked.find((item) => item.titleOrDate === "2025-01-02")?.excerpt.includes("garden"), true);
    assert.equal(recall("searchable", { type: "digest" }, 10, root)[0]?.excerpt.includes("Prose before headings"), true);
    assert.equal(ranked[0]?.derived, true);
    assert.match(ranked[0]?.note ?? "", /not fresh evidence/i);
    assert.ok(ranked.every((item) => item.excerpt.length <= 180 && item.path.length <= 240));
    assert.ok(recall("", { type: "commitment", status: "open" }, 10, root).some((item) => item.titleOrDate === "Open commitment"));
    assert.equal(recall("", { type: "commitment", status: "open", to: "2024-12-31" }, 10, root).length, 1);
    assert.equal(recall("", { type: "commitment", status: "open", from: "2025-01-01" }, 10, root).length, 1);
    assert.equal(recall("garden plan", { type: "digest", from: "2025-03-01" }, 10, root).some((item) => item.path.includes("wrong-type") || item.path.includes("malformed")), false);
    const bounded = recall("garden", {}, 20, root);
    assert.ok(bounded.length <= 20);
    assert.ok(JSON.stringify(bounded).length <= 8_000);
    assert.equal(recall("garden", { status: "missing" }, 10, root).length, 0);
    assert.equal(recall("garden", { from: "2030-01-01" }, 10, root).length, 0);
    assert.equal(recall("absent", {}, 10, root).length, 0);
    assert.equal(recall("garden", {}, 10, join(root, "missing")).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("default sessions directory is Samwise-only and cwd independent", () => {
  const original = process.cwd(), temp = mkdtempSync(join(tmpdir(), "samwise-cwd-"));
  try {
    const expected = resolveDefaultSessionsDir();
    process.chdir(temp);
    assert.equal(resolveDefaultSessionsDir(), expected);
    assert.equal(expected, join(homedir(), ".pi", "agent", "sessions", `--${join(homedir(), "Samwise").slice(1).replaceAll("/", "-")}--`));
    const agentDir = "/tmp/pi";
    assert.equal(resolveDefaultSessionsDir("/Users/george", agentDir), "/tmp/pi/sessions/--Users-george--");
    assert.equal(resolveDefaultSessionsDir("/Users/george/dev/samwise", agentDir), "/tmp/pi/sessions/--Users-george-dev-samwise--");
    assert.deepEqual(recall("", {}, 5, join(temp, "missing-memory")), []);
    assert.equal(getConsolidationStatus({ sessionsDir: join(temp, "missing-sessions"), memoryDir: join(temp, "missing-memory") }).outstandingNewProcessable, 0);
  } finally { process.chdir(original); rmSync(temp, { recursive: true, force: true }); }
});
