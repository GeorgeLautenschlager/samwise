// Mock Keystone for evals, loaded with `pi -e`. Registers keystone_search and
// keystone_get over the docs in $KEYSTONE_MOCK_FILE (a scenario's
// keystone_mock). The real interface is unknown; see eval/README.md.
import { readFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";

interface Doc {
	id: string;
	title: string;
	match: string[];
	content: string;
}

export default function (pi: any) {
	const file = process.env.KEYSTONE_MOCK_FILE;
	const docs: Doc[] = file ? JSON.parse(readFileSync(file, "utf8")) : [];
	const reply = (text: string) => ({ content: [{ type: "text", text }], details: {} });

	pi.registerTool({
		name: "keystone_search",
		label: "Keystone Search",
		description:
			"Search Keystone, the company knowledge base (systems, people, docs, processes). Returns matching document ids and titles.",
		parameters: Type.Object({ query: Type.String({ description: "What to search for" }) }),
		async execute(_toolCallId: string, params: { query: string }) {
			const query = params.query.toLowerCase();
			const hits = docs.filter((d) => d.match.every((k) => query.includes(k.toLowerCase())));
			return reply(hits.length ? hits.map((d) => `${d.id}: ${d.title}`).join("\n") : "No results.");
		},
	});

	pi.registerTool({
		name: "keystone_get",
		label: "Keystone Get",
		description: "Fetch a Keystone document by id.",
		parameters: Type.Object({ id: Type.String({ description: "Document id, e.g. KS-1234" }) }),
		async execute(_toolCallId: string, params: { id: string }) {
			const doc = docs.find((d) => d.id === params.id);
			return reply(doc ? `${doc.title}\n\n${doc.content}` : `No document ${params.id}.`);
		},
	});
}
