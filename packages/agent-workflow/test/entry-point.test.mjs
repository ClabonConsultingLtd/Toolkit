import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A script path that is not a plain file URL (spaces here, `C:\` on Windows)
// must still be recognised as the entry point. A missed check exits 0 silently.
const source = join(import.meta.dirname, "..", "src");

for (const [script, usage] of [
	["ticket-batch.mjs", /usage: node ticket-batch\.mjs MANIFEST/],
	["handoff.mjs", /usage: node handoff\.mjs TASK_DIRECTORY/],
]) {
	test(`${script} runs when its path needs URL encoding`, () => {
		const copy = join(mkdtempSync(join(tmpdir(), "entry point ")), "src dir");
		cpSync(source, copy, { recursive: true });
		const result = spawnSync(process.execPath, [join(copy, script)], {
			encoding: "utf8",
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, usage);
	});
}
