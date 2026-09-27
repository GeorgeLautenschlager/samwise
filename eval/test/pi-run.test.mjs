import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTranscript } from "../lib/pi-run.mjs";

const jsonl = `${[
	{ type: "session", id: "x" },
	{ type: "message_end", message: { role: "user", content: [{ type: "text", text: "q" }] } },
	{ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }] } },
	{ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "out" }] } },
	{ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } },
	{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "first" }] } },
	{ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "final answer" }] } },
	{ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "memory_write", arguments: { target: "daily" } }] } },
]
	.map((e) => JSON.stringify(e))
	.join("\n")}\nnot json\n`;

test("final text is the last assistant message with text; tool calls are collected in order", () => {
	const t = parseTranscript(jsonl);
	assert.equal(t.finalText, "final answer");
	assert.deepEqual(t.toolCalls, [
		{ name: "bash", args: { command: "ls" } },
		{ name: "memory_write", args: { target: "daily" } },
	]);
});

test("an empty or unparseable stream yields no text and no calls", () => {
	assert.deepEqual(parseTranscript("garbage\n"), { finalText: "", toolCalls: [] });
});
