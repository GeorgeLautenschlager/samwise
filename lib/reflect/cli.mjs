// samwise-reflect: the helper behind /reflect (procedure: pi/prompts/reflect.md).
//   status [--json]                  unreflected days of logs; is a proposal pending?
//   context                          logs to review, wisdom entries with ids, vocabulary
//   propose                          read a proposal (JSON) on stdin, store it, print the diff
//   apply [--skip N,.. | --only N,..] write + commit approved items, clear the proposal
//   discard                          drop the pending proposal
//   nudge                            print a once-a-day reminder if one is due
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildProposal, renderDiff } from "./proposal.mjs";
import { applyApproved, dailyDates, fingerprint, loadState, newRunId, paths, reflectedThrough, today } from "./repo.mjs";

const USAGE = "usage: samwise-reflect status [--json] | context | propose | apply [--skip N,.. | --only N,..] | discard | nudge";

function status(p, date) {
	const through = reflectedThrough(p.memory);
	return {
		reflectedThrough: through,
		unreflectedDays: dailyDates(p.daily).filter((d) => (!through || d > through) && d < date),
		pending: existsSync(p.pending),
	};
}

// Logs to review: from the last reflected day (inclusive, to catch later
// same-day entries) onwards; every log if /reflect never ran.
function reviewDates(p) {
	const through = reflectedThrough(p.memory);
	return dailyDates(p.daily).filter((d) => !through || d >= through);
}

function context(p) {
	const state = loadState(p);
	const out = ["# Daily logs to review", ""];
	const dates = reviewDates(p);
	if (dates.length === 0) out.push("(none)", "");
	for (const d of dates) out.push(`## ${d}`, "", readFileSync(join(p.daily, `${d}.md`), "utf8").trimEnd(), "");
	out.push("# Wisdom entries", "");
	for (const [title, entries] of [
		["Thanx scope (MEMORY.md)", state.thanx.entries],
		["Personal scope (WORKING-WITH-GEORGE.md)", state.personal.entries],
	]) {
		out.push(`## ${title}`, "");
		if (entries.length === 0) out.push("(none)", "");
		for (const e of entries) out.push(`[${e.id}]`, e.text, "");
	}
	out.push("# Known Thanx vocabulary", "", state.vocabulary.length ? state.vocabulary.map((t) => `- ${t}`).join("\n") : "(none)");
	return out.join("\n");
}

function propose(p, date) {
	let input;
	try {
		input = JSON.parse(readFileSync(0, "utf8"));
	} catch (e) {
		throw new Error(`proposal is not valid JSON: ${e.message}`);
	}
	const proposal = buildProposal(input, loadState(p), date);
	const replaced = existsSync(p.pending);
	const pending = {
		id: newRunId(date),
		date,
		reflectedThrough: reviewDates(p).at(-1) ?? reflectedThrough(p.memory) ?? date,
		fingerprint: fingerprint(p),
		...proposal,
	};
	mkdirSync(dirname(p.pending), { recursive: true });
	writeFileSync(p.pending, `${JSON.stringify(pending, null, 2)}\n`);
	console.log(renderDiff(proposal, date));
	if (replaced) console.log("\n(This replaces the previously pending proposal.)");
}

function invalidProposal(reason) {
	throw new Error(`pending proposal is invalid: ${reason}; run /reflect again`);
}

function validatePending(p, pending) {
	const state = loadState(p);
	const control = /[\u0000-\u0009\u000b-\u001f\u007f]/;
	const badString = (value) => typeof value === "string" && control.test(value);
	if (!Array.isArray(pending.items)) invalidProposal("items must be an array");
	const numbers = new Set();
	for (const item of pending.items) {
		if (!item || !Number.isInteger(item.n) || item.n <= 0) invalidProposal("item numbers must be positive integers");
		if (numbers.has(item.n)) invalidProposal(`duplicate item number ${item.n}`);
		numbers.add(item.n);
		if (!["add", "edit", "retire"].includes(item.op)) invalidProposal(`invalid operation for item ${item.n}`);
		if (!["thanx", "personal"].includes(item.scope)) invalidProposal(`invalid scope for item ${item.n}`);
		if (["add", "edit"].includes(item.op) && typeof item.text !== "string") invalidProposal(`item ${item.n} needs text`);
		if (["edit", "retire"].includes(item.op) && !state[item.scope].entries.some((entry) => entry.id === item.target)) invalidProposal(`item ${item.n} target is not in its scope`);
		for (const value of [item.text, item.title, item.target]) if (badString(value)) invalidProposal(`control character in item ${item.n}`);
	}
	if (!Array.isArray(pending.vocabulary) || pending.vocabulary.some((term) => typeof term !== "string" || term.includes("\n") || badString(term))) invalidProposal("invalid vocabulary");
	if (typeof pending.reflectedThrough !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(pending.reflectedThrough) || Number.isNaN(Date.parse(`${pending.reflectedThrough}T00:00:00Z`)) || new Date(`${pending.reflectedThrough}T00:00:00Z`).toISOString().slice(0, 10) !== pending.reflectedThrough || pending.reflectedThrough > today()) invalidProposal("invalid reflected-through date");
	if (typeof pending.fingerprint !== "string" || typeof pending.date !== "string" || typeof pending.id !== "string") invalidProposal("missing proposal metadata");
}

function apply(p, args) {
	if (!existsSync(p.pending)) throw new Error("nothing pending; run propose first");
	const pending = JSON.parse(readFileSync(p.pending, "utf8"));
	const all = pending.items.map((i) => i.n);
	validatePending(p, pending);
	const [flag, value] = args;
	let approved = all;
	if (flag !== undefined) {
		if (flag !== "--skip" && flag !== "--only") throw new Error(`unknown option ${flag}\n${USAGE}`);
		const list = (value ?? "").split(",").filter(Boolean).map(Number);
		if (list.length === 0 || list.some((n) => !all.includes(n))) throw new Error(`${flag} needs item numbers from ${all.join(",")}`);
		approved = all.filter((n) => (flag === "--skip" ? !list.includes(n) : list.includes(n)));
	}
	if (approved.length === 0) {
		rmSync(p.pending);
		console.log("Nothing approved; proposal discarded.");
		return;
	}
	if (fingerprint(p) !== pending.fingerprint) {
		throw new Error("wisdom files changed since the proposal; run context and propose again");
	}
	const selected = pending.items.filter((item) => approved.includes(item.n));
	const state = loadState(p);
	for (const item of selected) {
		const title = item.title ?? (item.op === "add" ? item.text.match(/^### (.+)$/m)?.[1] : item.target);
		console.log(`Applying [${item.n}] ${item.op} ${item.scope}: ${title}`);
		if (item.op === "edit" || item.op === "retire") {
			const entry = state[item.scope].entries.find((e) => e.id === item.target);
			console.log(entry.text.split("\n").map((line) => `    - ${line}`).join("\n"));
		}
		if (item.op === "add" || item.op === "edit") console.log(item.text.split("\n").map((line) => `    + ${line}`).join("\n"));
	}
	if (pending.vocabulary.length) console.log(`New vocabulary (thanx scope): ${pending.vocabulary.join(", ")}`);
	console.log(`Reflected through: ${pending.reflectedThrough}`);
	const commits = applyApproved(p, pending, approved);
	rmSync(p.pending);
	console.log(`Applied items ${approved.join(",")}; committed in ${commits.join(" and ")}.`);
}

function nudge(p, date) {
	let last = "";
	try {
		last = readFileSync(p.nudged, "utf8").trim();
	} catch {
		// never nudged
	}
	if (last === date) return;
	const s = status(p, date);
	const days = s.unreflectedDays.length;
	const message = s.pending
		? "A /reflect proposal is waiting for your approval."
		: days > 0
			? `${days} unreflected day${days === 1 ? "" : "s"} of logs: run /reflect.`
			: "";
	if (!message) return;
	mkdirSync(dirname(p.nudged), { recursive: true });
	writeFileSync(p.nudged, `${date}\n`);
	console.log(message);
}

function main([command, ...args]) {
	const p = paths();
	const date = today();
	switch (command) {
		case "status": {
			const s = status(p, date);
			if (args.includes("--json")) console.log(JSON.stringify(s));
			else {
				const days = s.unreflectedDays;
				console.log(
					`${days.length} unreflected day(s)${days.length ? `: ${days.join(", ")}` : ""}; ${s.pending ? "a proposal is pending" : "nothing pending"}`,
				);
			}
			return;
		}
		case "context":
			console.log(context(p));
			return;
		case "propose":
			propose(p, date);
			return;
		case "apply":
			apply(p, args);
			return;
		case "discard":
			if (existsSync(p.pending)) {
				rmSync(p.pending);
				console.log("Proposal discarded; nothing was written.");
			} else console.log("Nothing pending.");
			return;
		case "nudge":
			nudge(p, date);
			return;
		default:
			throw new Error(USAGE);
	}
}

try {
	main(process.argv.slice(2));
} catch (e) {
	console.error(`samwise-reflect: ${e.message}`);
	process.exit(1);
}
