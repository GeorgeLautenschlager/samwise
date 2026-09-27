// Build a /reflect proposal from Samwise's JSON: validate it against the
// current wisdom entries, stamp as-of dates (D9), reroute leaky personal items
// to the thanx scope (D11), and render the numbered diff (D10). Pure.
import { formatEntry } from "./entries.mjs";
import { leakReason } from "./leak.mjs";

const FILES = { thanx: "MEMORY.md", personal: "WORKING-WITH-GEORGE.md" };
const scopeOf = (id) => (id.startsWith("T") ? "thanx" : "personal");
const hasText = (v) => typeof v === "string" && v.trim() !== "";

// state: { thanx, personal } from parseWisdom, plus vocabulary: [terms].
// Returns { items: [{ n, op, scope, target?, before?, text?, reason?, rerouted? }],
// vocabulary: [terms not yet known] }. Throws listing every problem.
export function buildProposal(input, state, today) {
	const errors = [];
	const entries = new Map([...state.thanx.entries, ...state.personal.entries].map((e) => [e.id, e]));
	const used = new Set();
	const items = [];
	const list = Array.isArray(input?.items) ? input.items : [];
	if (list.length === 0) errors.push("items must be a non-empty list");

	list.forEach((item, i) => {
		const where = `item ${i + 1}`;
		const resolveTarget = () => {
			const entry = entries.get(item.target);
			if (!entry) errors.push(`${where}: unknown target '${item.target}'`);
			else if (used.has(entry.id)) errors.push(`${where}: target '${item.target}' used twice`);
			else {
				used.add(entry.id);
				return entry;
			}
			return null;
		};
		const entryText = () => {
			if (hasText(item.title) && hasText(item.body)) return formatEntry(item.title, today, item.body);
			errors.push(`${where}: ${item.op} needs title and body`);
			return null;
		};

		if (item?.op === "add") {
			const scopeOk = Object.hasOwn(FILES, item.scope ?? "");
			if (!scopeOk) errors.push(`${where}: add needs scope thanx or personal`);
			const text = entryText();
			if (scopeOk && text) items.push({ op: "add", scope: item.scope, text });
		} else if (item?.op === "edit") {
			const entry = resolveTarget();
			const text = entryText();
			if (entry && text) items.push({ op: "edit", scope: scopeOf(entry.id), target: entry.id, before: entry.text, text });
		} else if (item?.op === "retire") {
			const entry = resolveTarget();
			const reason = hasText(item.reason) ? item.reason.trim() : "";
			if (entry) items.push({ op: "retire", scope: scopeOf(entry.id), target: entry.id, before: entry.text, reason });
		} else {
			errors.push(`${where}: unknown op '${item?.op}'`);
		}
	});
	if (errors.length > 0) throw new Error(errors.join("\n"));

	const known = state.vocabulary.map((t) => t.toLowerCase());
	const fresh = [];
	for (const raw of Array.isArray(input.vocabulary) ? input.vocabulary : []) {
		const term = String(raw).trim();
		if (term && !known.includes(term.toLowerCase())) {
			known.push(term.toLowerCase());
			fresh.push(term);
		}
	}
	const terms = [...state.vocabulary, ...fresh];

	const resolved = items.flatMap((item) => {
		if (item.op === "retire" || item.scope !== "personal") return [item];
		const reason = leakReason(item.text, terms);
		if (!reason) return [item];
		const add = { op: "add", scope: "thanx", text: item.text, rerouted: reason };
		if (item.op === "add") return [add];
		return [{ op: "retire", scope: "personal", target: item.target, before: item.before, reason: `rerouted to thanx: ${reason}` }, add];
	});
	return { items: resolved.map((item, i) => ({ n: i + 1, ...item })), vocabulary: fresh };
}

// New { thanx, personal } entry lists with `items` applied (ids from `state`).
export function applyItems(state, items) {
	const next = { thanx: structuredClone(state.thanx), personal: structuredClone(state.personal) };
	for (const item of items) {
		const list = next[item.scope].entries;
		if (item.op === "add") {
			list.push({ id: null, text: item.text });
			continue;
		}
		const i = list.findIndex((e) => e.id === item.target);
		if (item.op === "retire") list.splice(i, 1);
		else list[i] = { id: item.target, text: item.text };
	}
	return next;
}

const block = (sign, text) =>
	text
		.split("\n")
		.map((line) => `  ${sign} ${line}`.trimEnd())
		.join("\n");

export function renderDiff(proposal, today) {
	const count = proposal.items.length;
	const out = [`/reflect proposal ${today}: ${count} item${count === 1 ? "" : "s"}`, ""];
	for (const item of proposal.items) {
		let note = "";
		if (item.rerouted) note = `  ↪ rerouted from personal: ${item.rerouted}`;
		else if (item.target) note = `  ${item.target}${item.reason ? `: ${item.reason}` : ""}`;
		out.push(`[${item.n}] ${item.op}  ${item.scope}  ${FILES[item.scope]}${note}`);
		if (item.before) out.push(block("-", item.before));
		if (item.text) out.push(block("+", item.text));
		out.push("");
	}
	if (proposal.vocabulary.length > 0) out.push(`New vocabulary (thanx scope): ${proposal.vocabulary.join(", ")}`, "");
	out.push('Approve all, some (e.g. "all but 2"), or none.');
	return out.join("\n");
}
