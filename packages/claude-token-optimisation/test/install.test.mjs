import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("installs agent, hooks and settings fragment", () => {
	const root = mkdtempSync(join(tmpdir(), "toolkit-")),
		cli = fileURLToPath(new URL("../install.mjs", import.meta.url)),
		r = spawnSync(process.execPath, [cli, root], { encoding: "utf8" });
	assert.equal(r.status, 0);
	for (const file of [
		"CONTEXT-POLICY.md",
		"agents/bulk-reader.md",
		"hooks/guard-large-read.mjs",
		"hooks/summarize-bash.mjs",
		"settings.toolkit-token-optimisation.json",
	])
		assert.ok(existsSync(join(root, ".claude", file)));
});
