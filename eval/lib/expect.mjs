// Score one eval run against a scenario's expect block (semantics in
// eval/README.md). Pure: no I/O.

// Each key of `want` must match `args`: strings as substrings, others by equality.
export function argsMatch(want = {}, args = {}) {
	return Object.entries(want).every(([key, value]) =>
		typeof value === "string"
			? typeof args[key] === "string" && args[key].includes(value)
			: JSON.stringify(args[key]) === JSON.stringify(value),
	);
}

function callMatches(item, call) {
	const want = typeof item === "string" ? { name: item } : item;
	return call.name === want.name && argsMatch(want.args_include, call.args);
}

const describe = (item) => (typeof item === "string" ? item : JSON.stringify(item));

// Every lexicon term (case-insensitive) in every personal-scope file: [{path, term}].
export function findLeaks(personalFiles, lexicon) {
	return personalFiles.flatMap(({ path, text }) => {
		const lower = text.toLowerCase();
		return lexicon.filter((term) => lower.includes(term.toLowerCase())).map((term) => ({ path, term }));
	});
}

// outcome: { finalText, toolCalls: [{name, args}], personalFiles: [{path, text}] }
// Returns { pass, checks: [{key, pass, detail}], leaks }. Leaks are always
// computed (AC3 counts them in every category); only personal_scope_clean
// makes them fail the run.
export function scoreRun(expect, { finalText, toolCalls, personalFiles }, lexicon) {
	const text = finalText.toLowerCase();
	const leaks = findLeaks(personalFiles, lexicon);
	const checks = Object.entries(expect).map(([key, value]) => {
		switch (key) {
			case "response_includes": {
				const missing = value.filter((s) => !text.includes(s.toLowerCase()));
				return { key, pass: missing.length === 0, detail: missing.length ? `missing: ${missing.join(", ")}` : "" };
			}
			case "response_excludes": {
				const found = value.filter((s) => text.includes(s.toLowerCase()));
				return { key, pass: found.length === 0, detail: found.length ? `found: ${found.join(", ")}` : "" };
			}
			case "tool_called": {
				const missing = value.filter((item) => !toolCalls.some((call) => callMatches(item, call)));
				return {
					key,
					pass: missing.length === 0,
					detail: missing.length ? `not called: ${missing.map(describe).join(", ")}` : "",
				};
			}
			case "tool_not_called": {
				const called = value.filter((item) => toolCalls.some((call) => callMatches(item, call)));
				return { key, pass: called.length === 0, detail: called.length ? `called: ${called.map(describe).join(", ")}` : "" };
			}
			case "personal_scope_clean":
				return { key, pass: leaks.length === 0, detail: leaks.map((l) => `${l.term} in ${l.path}`).join(", ") };
			default:
				return { key, pass: false, detail: `${key} is not machine-scored` };
		}
	});
	return { pass: checks.every((c) => c.pass), checks, leaks };
}
