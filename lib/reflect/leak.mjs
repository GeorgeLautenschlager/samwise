// Deterministic leak check for personal-bound text: the D11 backstop behind
// Samwise's own D5 judgement. The vocabulary lives in the thanx scope's
// VOCABULARY.md and grows with every /reflect run.

// Public standards that look like ticket IDs (SHA-256, RFC-9110, ...).
const PUBLIC_ID_PREFIXES = new Set(["AES", "CVE", "HTTP", "IEEE", "ISO", "RFC", "SHA", "TLS", "UTF"]);
const ID = /\b([A-Z]{2,})-\d{2,}\b/g;
const PATTERNS = [
	{ name: "a Keystone pointer", re: /keystone:/i },
	{ name: "a URL", re: /https?:\/\//i },
	{ name: "a PR reference", re: /#\d{2,}\b/ },
];

// Why `text` looks Thanx-specific, or null if it looks portable.
export function leakReason(text, vocabulary) {
	const lower = text.toLowerCase();
	const term = vocabulary.find((t) => t.trim() !== "" && lower.includes(t.trim().toLowerCase()));
	if (term) return `contains "${term}"`;
	for (const { name, re } of PATTERNS) {
		const match = re.exec(text);
		if (match) return `contains ${name} ("${match[0]}")`;
	}
	for (const match of text.matchAll(ID)) {
		if (!PUBLIC_ID_PREFIXES.has(match[1])) return `contains an ID ("${match[0]}")`;
	}
	return null;
}

export function parseVocabulary(content) {
	return content
		.split("\n")
		.map((line) => /^- (.+)$/.exec(line)?.[1].trim())
		.filter(Boolean);
}

export function serializeVocabulary(terms) {
	return [
		"# Thanx vocabulary",
		"",
		"Thanx-specific names (systems, customers, people, incidents, metrics). /reflect keeps",
		"them out of the personal scope and adds new ones here.",
		"",
		...terms.map((t) => `- ${t}`),
		"",
	].join("\n");
}
