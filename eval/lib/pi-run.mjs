// Run one Samwise session non-interactively (pi --mode json) and parse its
// JSONL event stream into the final answer and the tool calls made.
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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
	// The fence is macOS-only; elsewhere bin/samwise refuses to start without
	// this opt-in, so eval runs unfenced there.
	if (process.platform !== "darwin") extra.SAMWISE_UNSANDBOXED = "1";
	if (network) {
		extra.NETLOG_FILE = join(run.dir, "netlog.jsonl");
		extra.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --require ${join(repo, "eval/netlog.cjs")}`.trim();
	}
	const args = ["--mode", "json", "--model", model, "-e", join(repo, "eval/keystone-mock.ts"), ...prompts];
	return new Promise((resolve) => {
		// On macOS bin/samwise refuses SAMWISE_UNSANDBOXED whatever its value, so
		// drop one inherited from the caller's environment.
		const env = samwiseEnv(run.home, extra);
		if (process.platform === "darwin") delete env.SAMWISE_UNSANDBOXED;
		// Own process group, so the whole session (e.g. qmd searches pi-memory
		// gave up on) can be killed when it ends.
		const child = spawn(join(repo, "bin/samwise"), args, {
			cwd: run.workspace,
			env,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		const killGroup = () => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// group already gone
			}
		};
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
			killGroup();
		}, timeoutMs);
		child.on("close", (code) => {
			clearTimeout(timer);
			killGroup();
			resolve({ code, stdout, stderr, timedOut });
		});
	});
}

// Kill every process still running from a run: all of them inherit the run's
// SAMWISE_HOME, even those that left the process group (e.g. via setsid).
// Linux only (/proc); elsewhere the process-group kill in runPi is the cleanup.
export function reapRun(home) {
	let pids;
	try {
		pids = readdirSync("/proc").filter((d) => /^\d+$/.test(d) && Number(d) !== process.pid);
	} catch {
		return 0;
	}
	const marker = `SAMWISE_HOME=${home}\0`;
	let killed = 0;
	for (const pid of pids) {
		try {
			const env = readFileSync(`/proc/${pid}/environ`, "latin1");
			if (env.startsWith(marker) || env.includes(`\0${marker}`)) {
				process.kill(Number(pid), "SIGKILL");
				killed++;
			}
		} catch {
			// exited, or not ours to read
		}
	}
	return killed;
}
