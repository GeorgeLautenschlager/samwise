import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const hook = join(import.meta.dirname, "../netlog.cjs");

test("logs host and port of each outbound TCP connection", async () => {
	const server = createServer((s) => s.end()).listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address();
	const log = join(mkdtempSync(join(tmpdir(), "netlog-")), "net.jsonl");
	const child = spawn(
		process.execPath,
		["--require", hook, "-e", `require("net").connect(${port}, "127.0.0.1").on("connect", function () { this.end(); })`],
		{ env: { ...process.env, NETLOG_FILE: log } },
	);
	await once(child, "exit");
	server.close();
	const entries = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	assert.deepEqual(entries.map(({ host, port: p }) => ({ host, port: p })), [{ host: "127.0.0.1", port }]);
});
