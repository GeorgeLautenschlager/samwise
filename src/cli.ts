#!/usr/bin/env node
import { resolve } from "node:path";
import { consolidate, getConsolidationStatus } from "./consolidator.ts";
import { createPiModelAdapter } from "./model.ts";

function parseArgs(args: string[]): { command: string; sessionsDir?: string; memoryDir?: string; maxEntries?: number; dryRun: boolean } {
  const [command, ...rest] = args;
  if (!command || !["consolidate", "status"].includes(command)) throw new Error("Usage: samwise-memory <consolidate|status> [--sessions-dir DIR] [--memory-dir DIR] [--max-entries N] [--dry-run]");
  const options: { command: string; sessionsDir?: string; memoryDir?: string; maxEntries?: number; dryRun: boolean } = { command, dryRun: false };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--dry-run" && command === "consolidate") options.dryRun = true;
    else if (["--sessions-dir", "--memory-dir", "--max-entries"].includes(arg)) {
      const value = rest[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      if (arg === "--sessions-dir") options.sessionsDir = resolve(value);
      else if (arg === "--memory-dir") options.memoryDir = resolve(value);
      else {
        options.maxEntries = Number(value);
        if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) throw new Error("--max-entries must be a positive integer");
      }
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "status") console.log(JSON.stringify(getConsolidationStatus(args), null, 2));
  else {
    const result = await consolidate({ ...args, model: args.dryRun ? undefined : await createPiModelAdapter() });
    if (args.dryRun) console.log(result.plan.length ? result.plan.join("\n") : "No new entries to process.");
    else console.log(JSON.stringify({ processedEntries: result.processedEntries, ...result.status }, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
