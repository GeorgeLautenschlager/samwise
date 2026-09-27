// Scripted OpenAI-compatible streaming stub for eval tests. Each rule's `when`
// is matched against the latest user message; its `steps` are replayed one per
// assistant turn after that message: {"tool": {"name", "args"}} or {"text"}.
// Unmatched prompts get "no script". Request bodies are appended to <request-log>.
// Prints the listening port on stdout.
// Usage: node test/fixtures/scripted-llm.mjs <script.json> <request-log>
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const [scriptPath, requestLog] = process.argv.slice(2);
if (!scriptPath || !requestLog) {
	console.error("usage: scripted-llm.mjs <script.json> <request-log>");
	process.exit(2);
}
const { rules } = JSON.parse(readFileSync(scriptPath, "utf8"));

const textOf = (content) =>
	typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p.text ?? "").join("") : "";

function chunk(delta, finishReason) {
	const body = {
		id: "stub",
		object: "chat.completion.chunk",
		created: 0,
		model: "stub-model",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
	return `data: ${JSON.stringify(body)}\n\n`;
}

const server = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => {
		body += c;
	});
	req.on("end", () => {
		appendFileSync(requestLog, `${body}\n`);
		const { messages = [] } = JSON.parse(body || "{}");
		const lastUser = messages.map((m) => m.role).lastIndexOf("user");
		const userText = textOf(messages[lastUser]?.content);
		const turn = messages.slice(lastUser + 1).filter((m) => m.role === "assistant").length;
		const rule = rules.find((r) => userText.includes(r.when));
		const step = rule?.steps[turn] ?? { text: rule ? "done" : "no script" };
		const delta = step.tool
			? {
					role: "assistant",
					content: null,
					tool_calls: [
						{
							index: 0,
							id: `call_${turn}`,
							type: "function",
							function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args ?? {}) },
						},
					],
				}
			: { role: "assistant", content: step.text };
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(chunk(delta, null));
		res.write(chunk({}, step.tool ? "tool_calls" : "stop"));
		res.end("data: [DONE]\n\n");
	});
});

server.listen(0, "127.0.0.1", () => console.log(server.address().port));
