// At session start, at most once a day, remind George to run /reflect when
// daily logs are unreflected or a proposal awaits approval (D10: one
// interruption). The logic lives in `samwise-reflect nudge`; failures are silent.
import { execFile } from "node:child_process";

export default function (pi: any) {
	pi.on("session_start", async (_event: any, ctx: any) => {
		if (!ctx.hasUI) return;
		execFile("samwise-reflect", ["nudge"], (error, stdout) => {
			if (!error && stdout.trim()) ctx.ui.notify(stdout.trim(), "info");
		});
	});
}
