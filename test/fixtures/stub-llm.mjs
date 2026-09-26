// Minimal OpenAI-compatible streaming stub for Pi. The first turn calls
// pi-memory's memory_write (daily) with <note>; once a tool result is present
// it answers "done". Every request body is appended to <request-log>.
// Prints the listening port on stdout.
// Usage: node test/fixtures/stub-llm.mjs <note> <request-log>
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const [note, requestLog] = process.argv.slice(2);
if (!note || !requestLog) {
	console.error("usage: stub-llm.mjs <note> <request-log>");
	process.exit(2);
}

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
		const answered = messages.some((m) => m.role === "tool");
		const delta = answered
			? { role: "assistant", content: "done" }
			: {
					role: "assistant",
					content: null,
					tool_calls: [
						{
							index: 0,
							id: "call_1",
							type: "function",
							function: {
								name: "memory_write",
								arguments: JSON.stringify({ target: "daily", content: note }),
							},
						},
					],
				};
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(chunk(delta, null));
		res.write(chunk({}, answered ? "stop" : "tool_calls"));
		res.end("data: [DONE]\n\n");
	});
});

server.listen(0, "127.0.0.1", () => console.log(server.address().port));
