// Aggregate scored runs into category rates and AC verdicts, and render the
// markdown report. Pure: no I/O.

export const TARGETS = { recall: 0.8, preference: 0.8, "stale-knowledge": 0.9 };
const CATEGORIES = ["recall", "preference", "stale-knowledge", "scope-leak"];

const pct = (rate) => (rate === null ? "–" : `${Math.round(rate * 100)}%`);
const cell = (text) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

function rateStatus(categories, names) {
	if (names.some((c) => categories[c].runs === 0)) return "not evaluated";
	return names.every((c) => categories[c].rate >= TARGETS[c]) ? "pass" : "fail";
}

function firstFailure(result) {
	return (
		result.error ??
		result.checks
			.filter((c) => !c.pass)
			.map((c) => `${c.key}: ${c.detail}`)
			.join("; ")
	);
}

function countDestinations(results) {
	const counts = new Map();
	for (const r of results) {
		for (const { host, port } of r.network) {
			const key = `${host}:${port}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	return [...counts]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([destination, connections]) => ({ destination, connections }));
}

// results: [{id, category, n, pass, checks, leaks, error, network}]
// meta: {config, configDescription, model, runsPerScenario, versions, skipped, network (bool), date}
export function summarize(results, meta) {
	const byId = new Map();
	for (const r of [...results].sort((a, b) => a.n - b.n)) {
		const s = byId.get(r.id) ?? { id: r.id, category: r.category, runs: 0, passed: 0, firstFailure: null };
		s.runs++;
		if (r.pass) s.passed++;
		else s.firstFailure ??= firstFailure(r);
		byId.set(r.id, s);
	}
	const scenarios = [...byId.values()].sort(
		(a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.id.localeCompare(b.id),
	);

	const categories = {};
	for (const c of CATEGORIES) {
		const runs = results.filter((r) => r.category === c);
		const passed = runs.filter((r) => r.pass).length;
		categories[c] = { runs: runs.length, passed, rate: runs.length ? passed / runs.length : null };
	}

	const leaks = results.flatMap((r) => r.leaks.map((l) => ({ id: r.id, n: r.n, ...l })));
	const ac = {
		AC2: { criterion: "recall ≥ 80% and preference ≥ 80%", status: rateStatus(categories, ["recall", "preference"]) },
		AC3: {
			criterion: "0 leaks to the personal scope across all runs",
			status: results.length === 0 ? "not evaluated" : leaks.length === 0 ? "pass" : "fail",
		},
		AC4: { criterion: "stale-knowledge ≥ 90%", status: rateStatus(categories, ["stale-knowledge"]) },
	};
	const statuses = Object.values(ac).map((a) => a.status);
	const verdict = statuses.every((s) => s === "pass") ? "PASS" : statuses.includes("fail") ? "FAIL" : "INCOMPLETE";

	return {
		...meta,
		network: meta.network ? countDestinations(results) : null,
		totalRuns: results.length,
		scenarios,
		categories,
		leaks,
		ac,
		verdict,
	};
}

export function renderMarkdown(s) {
	const lines = [
		`# Samwise memory eval: config ${s.config}`,
		"",
		`**Verdict: ${s.verdict}**`,
		"",
		`- Config: ${s.config} (${s.configDescription})`,
		`- Model: \`${s.model}\``,
		`- Runs per scenario: ${s.runsPerScenario} (${s.totalRuns} runs)`,
		`- Date: ${s.date}`,
		`- Versions: ${Object.entries(s.versions)
			.map(([name, version]) => `${name} ${version}`)
			.join(", ")}`,
		"",
		"## Acceptance criteria",
		"",
		"| Criterion | Target | Status |",
		"|---|---|---|",
		...Object.entries(s.ac).map(([name, a]) => `| ${name} | ${a.criterion} | ${a.status} |`),
		"",
		"## Categories",
		"",
		"| Category | Runs | Passed | Rate | Target |",
		"|---|---|---|---|---|",
		...Object.entries(s.categories).map(
			([c, v]) => `| ${c} | ${v.runs} | ${v.passed} | ${pct(v.rate)} | ${c in TARGETS ? `≥ ${pct(TARGETS[c])}` : "0 leaks"} |`,
		),
		"",
		"## Scenarios",
		"",
		"| Scenario | Category | Passed | First failure |",
		"|---|---|---|---|",
		...s.scenarios.map((x) => `| ${x.id} | ${x.category} | ${x.passed}/${x.runs} | ${cell(x.firstFailure ?? "")} |`),
		"",
	];
	if (s.skipped.length > 0) {
		lines.push("## Skipped", "", ...s.skipped.map((x) => `- ${x.id} (${x.category}): requires ${x.requires.join(", ")}`), "");
	}
	lines.push("## Leaks", "", ...(s.leaks.length ? s.leaks.map((l) => `- ${l.id} #${l.n}: '${l.term}' in ${l.path}`) : ["None."]), "");
	if (s.network) {
		lines.push(
			"## Network (AC5)",
			"",
			"Outbound connections from Pi and its Node child processes during the runs. Non-Node processes (e.g. a `curl` the model runs) are not captured.",
			"",
			"| Destination | Connections |",
			"|---|---|",
			...s.network.map((d) => `| ${d.destination} | ${d.connections} |`),
			"",
		);
	}
	return lines.join("\n");
}
