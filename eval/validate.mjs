// Validate every golden-set scenario under <golden-dir> (default: eval/golden).
// Prints one line per scenario and a summary; exits 1 if any is invalid.
// Usage: node eval/validate.mjs [golden-dir]
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES, loadLexicon, loadScenario, validateScenario } from "./lib/scenario.mjs";

const golden = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "golden");
const lexicon = loadLexicon(join(golden, "lexicon.yml"));
const files = readdirSync(golden, { recursive: true })
	.filter((f) => f.endsWith(".md"))
	.sort();

const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
let valid = 0;
let invalid = 0;
let judgeScored = 0;
let requiresReflect = 0;

for (const file of files) {
	let scenario;
	let result;
	try {
		scenario = loadScenario(join(golden, file));
		result = validateScenario(scenario, lexicon);
	} catch (e) {
		result = { errors: [e.message], judgeScored: false };
	}
	if (result.errors.length > 0) {
		invalid++;
		for (const error of result.errors) console.log(`FAIL ${file}: ${error}`);
		continue;
	}
	valid++;
	counts[scenario.frontMatter.category]++;
	if (result.judgeScored) judgeScored++;
	if (scenario.frontMatter.requires?.includes("reflect")) requiresReflect++;
	console.log(`ok ${file}`);
}

const split = CATEGORIES.map((c) => `${c} ${counts[c]}`).join(", ");
console.log(`${valid} valid scenarios: ${split}; judge-scored ${judgeScored}; requires reflect ${requiresReflect}`);
if (invalid > 0) {
	console.log(`${invalid} invalid`);
	process.exit(1);
}
