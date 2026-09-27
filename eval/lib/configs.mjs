// Bake-off configs (D14). `prepare(run)` adjusts a built run before Pi starts.
// A further config (e.g. self-hosted Mem0) is another entry.
import { rm } from "node:fs/promises";
import { join } from "node:path";

export const CONFIGS = {
	A: {
		name: "A",
		description: "pi-memory + qmd, the production wiring",
		qmd: true,
		async prepare() {},
	},
	B: {
		name: "B",
		description: "pi-memory without qmd: no search, no selective injection",
		qmd: false,
		async prepare(run) {
			await rm(join(run.home, "tools"), { force: true }); // the symlink only
		},
	},
};
