// Preloaded with NODE_OPTIONS=--require: appends {pid, host, port} as one JSON
// line to $NETLOG_FILE for every outbound TCP connection made by this Node
// process (and, since NODE_OPTIONS is inherited, its Node children). AC5 evidence.
const fs = require("node:fs");
const net = require("node:net");

const file = process.env.NETLOG_FILE;
if (file) {
	const connect = net.Socket.prototype.connect;
	net.Socket.prototype.connect = function (...args) {
		try {
			const first = Array.isArray(args[0]) ? args[0][0] : args[0];
			const options =
				typeof first === "object" && first !== null
					? first
					: { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
			if (!options.path) {
				const entry = { pid: process.pid, host: options.host ?? "localhost", port: Number(options.port) };
				fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
			}
		} catch {
			// Logging must never break the connection.
		}
		return connect.apply(this, args);
	};
}
