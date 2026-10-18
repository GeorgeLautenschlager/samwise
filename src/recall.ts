import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDocument } from "yaml";
import { resolveMemoryDir } from "./consolidator.ts";

export type MemoryType = "digest" | "episode" | "commitment";
export interface RecallScope { type?: MemoryType; project?: string; status?: string | string[]; from?: string; to?: string }
export interface RecallResult { path: string; type: MemoryType; titleOrDate: string; excerpt: string; sources: string[]; derived: true; note: string }
const MAX_RESULTS = 20;
const MAX_EXCERPT = 180;
const MAX_TOTAL = 8_000;
function files(dir: string, type: MemoryType): string[] {
  const root = join(dir, type === "digest" ? "digests" : type === "episode" ? "episodes" : "commitments");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).filter((item) => item.isFile() && item.name.endsWith(".md")).map((item) => join(root, item.name));
}
function dateFor(meta: Record<string, unknown>): string {
  for (const key of ["date", "updated", "created", "started"]) if (typeof meta[key] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(meta[key] as string)) return meta[key] as string;
  return "";
}
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 20).map((item) => item.slice(0, 100)) : []; }
function extract(path: string, dir: string): { meta: Record<string, unknown>; body: string; relativePath: string } | undefined {
  try {
    const text = readFileSync(path, "utf8");
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) return undefined;
    const doc = parseDocument(match[1]!);
    if (doc.errors.length) return undefined;
    const meta = doc.toJSON();
    return meta && typeof meta === "object" && !Array.isArray(meta) ? { meta, body: match[2]!, relativePath: relative(dir, path) } : undefined;
  } catch { return undefined; }
}
function flatten(meta: Record<string, unknown>, body: string): string {
  const prose = body.replace(/^#{1,6}\s+/gm, "").replace(/\s+/g, " ").trim();
  const metadata = Object.entries(meta).filter(([key]) => !["sources", "derived"].includes(key)).map(([key, value]) => `${key}: ${String(value)}`).join(" ");
  return `${prose} ${metadata}`.trim();
}
function excerptFor(text: string, terms: string[]): string {
  const lower = text.toLocaleLowerCase();
  const first = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  let start = Math.max(0, first - 60), end = Math.min(text.length, start + MAX_EXCERPT);
  if (end < text.length) { const boundary = text.lastIndexOf(" ", end); if (boundary > first) end = boundary; }
  if (start > 0) { const boundary = text.indexOf(" ", start); if (boundary >= 0 && boundary < first) start = boundary + 1; }
  const prefix = start > 0 ? "…" : "", suffix = end < text.length ? "…" : "";
  const available = MAX_EXCERPT - prefix.length - suffix.length;
  return `${prefix}${text.slice(start, Math.min(end, start + available))}${suffix}`;
}
export function recall(query: string, scope: RecallScope = {}, limit = 5, memoryDir?: string): RecallResult[] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("limit must be a positive integer");
  const dir = resolveMemoryDir(memoryDir), needle = query.trim().toLocaleLowerCase(), terms = needle.split(/\s+/).filter(Boolean);
  const candidates: Array<{ result: RecallResult; score: number; date: string }> = [];
  const types: MemoryType[] = scope.type ? [scope.type] : ["digest", "episode", "commitment"];
  for (const type of types) for (const path of files(dir, type)) {
    const parsed = extract(path, dir); if (!parsed) continue;
    const { meta, body, relativePath } = parsed;
    if (meta.type !== type) continue;
    const projects = strings(meta.projects);
    if (scope.project && !projects.some((project) => project.toLocaleLowerCase() === scope.project!.toLocaleLowerCase())) continue;
    const statuses = Array.isArray(scope.status) ? scope.status : typeof scope.status === "string" ? scope.status.split(",").map((status) => status.trim()).filter(Boolean) : [];
    if (statuses.length > 0 && !statuses.some((status) => String(meta.status ?? "").toLocaleLowerCase() === status.toLocaleLowerCase())) continue;
    const date = dateFor(meta);
    if (scope.from && (!date || date < scope.from)) continue;
    if (scope.to && (!date || date > scope.to)) continue;
    const title = typeof meta.title === "string" ? meta.title : date || path.split("/").at(-1)!.replace(/\.md$/, "");
    const searchable = `${title} ${projects.join(" ")} ${body}`.toLocaleLowerCase();
    if (terms.some((term) => !searchable.includes(term))) continue;
    const score = terms.reduce((total, term) => {
      const count = searchable.split(term).length - 1;
      return total + Math.min(count, 20);
    }, 0) + (terms.length > 0 && terms.every((term) => title.toLocaleLowerCase().includes(term)) ? 10 : 0);
    const text = flatten(meta, body);
    const sources = Array.isArray(meta.sources) ? meta.sources.slice(0, 5).map((source: any) => `${String(source?.sessionId ?? "").slice(0, 80)}/${Array.isArray(source?.entryIds) ? source.entryIds.slice(0, 5).map((id: unknown) => String(id).slice(0, 80)).join(",") : ""}`.slice(0, 180)) : [];
    candidates.push({ score, date, result: { path: relativePath.slice(0, 240), type, titleOrDate: title.slice(0, 160), excerpt: excerptFor(text, terms), sources, derived: true, note: "Derived memory, not fresh evidence." } });
  }
  candidates.sort((a, b) => b.score - a.score || b.date.localeCompare(a.date) || a.result.path.localeCompare(b.result.path));
  const output: RecallResult[] = [];
  for (const item of candidates.slice(0, Math.min(limit, MAX_RESULTS))) {
    const candidate = item.result;
    if (JSON.stringify([...output, candidate]).length > MAX_TOTAL) break;
    output.push(candidate);
  }
  return output;
}
