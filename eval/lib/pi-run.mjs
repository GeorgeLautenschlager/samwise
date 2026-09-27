// Run one Samwise session non-interactively (pi --mode json) and parse its
// JSONL event stream into the final answer and the tool calls made.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { samwiseEnv } from "./sandbox.mjs";

const blocks = (message) => (Array.isArray(message.content) ? message.content : []);

// Returns { finalText, toolCalls: [{name, args}] } from Pi's JSONL stream.
export function parseTranscript(jsonl) {
	const assistant = [];
	for (const line of jsonl.split("\n")) {
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event?.type === "message_end" && event.message?.role === "assistant") assistant.push(event.message);
	}
	const toolCalls = assistant.flatMap((m) =>
		blocks(m)
			.filter((b) => b.type === "toolCall")
			.map((b) => ({ name: b.name, args: b.arguments ?? {} })),
	);
	const texts = assistant
		.map((m) =>
			blocks(m)
				.filter((b) => b.type === "text" && b.text.trim() !== "")
				.map((b) => b.text)
				.join("\n"),
		)
		.filter((t) => t !== "");
	return { finalText: texts.at(-1) ?? "", toolCalls };
}

// Runs bin/samwise in run.workspace; resolves { code, stdout, stderr, timedOut }.
export function runPi({ repo, run, model, prompts, network, timeoutMs }) {
	const extra = { KEYSTONE_MOCK_FILE: run.keystone, PI_MEMORY_EXIT_SUMMARY: "0" };
	if (network) {
		extra.NETLOG_FILE = join(run.dir, "netlog.jsonl");
		extra.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --require ${join(repo, "eval/netlog.cjs")}`.trim();
	}
	const args = ["--mode", "json", "--model", model, "-e", join(repo, "eval/keystone-mock.ts"), ...prompts];
	return new Promise((resolve) => {
		const child = spawn(join(repo, "bin/samwise"), args, {
			cwd: run.workspace,
			env: samwiseEnv(run.home, extra),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut });
		});
	});
}
