import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getConsolidationStatus, resolveMemoryDir } from "./consolidator.ts";
import { recall } from "./recall.ts";
import { resolveDefaultSessionsDir } from "./sessions.ts";

const MAX_CHILD_OUTPUT = 32_000;
const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url));
function runConsolidation(options: { sessionsDir?: string; maxEntries?: number } = {}, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["--experimental-strip-types", cliPath, "consolidate"];
    if (options.sessionsDir) args.push("--sessions-dir", options.sessionsDir);
    if (options.maxEntries !== undefined) args.push("--max-entries", String(options.maxEntries));
    const child = spawn(process.execPath, args, { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const stop = () => child.kill("SIGTERM");
    const finish = (error?: Error, result?: string) => { if (settled) return; settled = true; signal?.removeEventListener("abort", stop); error ? reject(error) : resolve(result ?? ""); };
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const current = target === "stdout" ? stdout : stderr;
      const next = current + chunk.toString("utf8");
      if (target === "stdout") stdout = next.slice(-MAX_CHILD_OUTPUT); else stderr = next.slice(-MAX_CHILD_OUTPUT);
    };
    child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code, terminationSignal) => {
      if (signal?.aborted) finish(new Error("Consolidation cancelled."));
      else if (code === 0) finish(undefined, stdout.trim() || "Consolidation completed.");
      else finish(new Error((stderr.trim() || stdout.trim() || `Consolidation failed (${terminationSignal ?? code}).`).slice(-MAX_CHILD_OUTPUT)));
    });
    if (signal?.aborted) stop(); else signal?.addEventListener("abort", stop, { once: true });
  });
}
function today(): string { return new Date().toLocaleString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
export default function (pi: ExtensionAPI): void {
  const sessionsDir = resolveDefaultSessionsDir();
  const memoryDir = resolveMemoryDir();
  pi.registerTool({
    name: "recall", label: "Memory recall",
    description: "Search Samwise's local derived memory by case-insensitive keywords and/or filters. Empty query lists filter matches. Use scope.type=digest, episode, or commitment; project matches a project exactly; status accepts one or more record statuses as an array or comma-separated string; from/to are inclusive YYYY-MM-DD dates compared to digest date, episode updated (fallback started), or commitment updated (fallback created). Results are bounded and explicitly derived, not fresh evidence. Use type=digest, empty query, limit=1 for the latest digest.",
    parameters: Type.Object({ query: Type.String({ description: "Case-insensitive keyword query; empty string lists filtered matches." }), scope: Type.Optional(Type.Object({ type: Type.Optional(Type.Union([Type.Literal("digest"), Type.Literal("episode"), Type.Literal("commitment")])), project: Type.Optional(Type.String({ description: "Exact project name, case-insensitive." })), status: Type.Optional(Type.Union([Type.String({ description: "One or more record statuses, comma-separated and case-insensitive; for example open, in-progress, blocked, deferred." }), Type.Array(Type.String({ description: "Record statuses to match, case-insensitively." }))])), from: Type.Optional(Type.String({ description: "Inclusive local record date YYYY-MM-DD." })), to: Type.Optional(Type.String({ description: "Inclusive local record date YYYY-MM-DD." })) })), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "Maximum results (default 5; hard cap 20)." })) }),
    async execute(_id, input) {
      const result = recall(input.query, input.scope, input.limit ?? 5, memoryDir);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
  pi.registerTool({ name: "memory_status", label: "Memory status", description: "Show current local weekday/date/time, the Samwise-only session folder, resolved memory folder, and existing local consolidation status. Missing session folders report an empty status. This makes no model request.", parameters: Type.Object({}), async execute() {
    const result = { localDateTime: today(), sessionsDir, memoryDir, status: getConsolidationStatus({ sessionsDir, memoryDir }) };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
  } });
  pi.registerTool({ name: "memory_consolidate", label: "Consolidate memory", description: "Run Samwise-only transcript consolidation using the existing CLI and configured model. This can send transcript content to the configured model provider and write derived Markdown. Do not use without explicit user authorization; invoking /end-workday, or George asking to consolidate, counts as authorization. Defaults to the Samwise-only Pi session folder and normal entry limit. Waits for completion; output includes processed-entry count, operation counts by kind, validation-correction diagnostics, and status, or bounded failure diagnostics. Honors the tool AbortSignal by terminating the child.", parameters: Type.Object({}), async execute(_id, _input, signal) {
    const output = await runConsolidation({}, signal);
    return { content: [{ type: "text", text: output }], details: output };
  } });
  pi.registerCommand("memory", { description: "Show memory status or start consolidation: /memory status | /memory consolidate", handler: async (args, ctx) => {
    const action = args.trim() || "status";
    if (action === "status") { ctx.ui.notify(JSON.stringify({ localDateTime: today(), sessionsDir, memoryDir, status: getConsolidationStatus({ sessionsDir, memoryDir }) }, null, 2), "info"); return; }
    if (action !== "consolidate") { ctx.ui.notify("Usage: /memory [status|consolidate]", "warning"); return; }
    ctx.ui.notify("Memory consolidation started.", "info");
    void runConsolidation().then((output) => pi.sendMessage({ customType: "samwise-memory", content: `Memory consolidation completed:\n${output}`, display: true })).catch((error) => pi.sendMessage({ customType: "samwise-memory", content: `Memory consolidation failed: ${error instanceof Error ? error.message : String(error)}`, display: true }));
  } });
}
