import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("worktree dry run does not create state", () => {
	const root = mkdtempSync(join(tmpdir(), "worktree-")),
		cli = fileURLToPath(new URL("../src/worktree-launch.mjs", import.meta.url)),
		r = spawnSync(process.execPath, [cli, "task.md", root, "--dry-run"], {
			encoding: "utf8",
		});
	assert.equal(r.status, 0);
	assert.match(r.stdout, /git worktree add/);
});
