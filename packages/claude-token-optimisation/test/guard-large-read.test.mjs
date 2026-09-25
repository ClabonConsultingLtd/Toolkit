import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const hook = fileURLToPath(
	new URL("../hooks/guard-large-read.mjs", import.meta.url),
);

function runHook(toolInput, env = {}) {
	const r = spawnSync(process.execPath, [hook], {
		input: JSON.stringify({ tool_input: toolInput }),
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
	return r.stdout.trim() ? JSON.parse(r.stdout) : undefined;
}

function image(bytes) {
	const path = join(mkdtempSync(join(tmpdir(), "toolkit-")), "shot.png");
	writeFileSync(path, Buffer.alloc(bytes));
	return path;
}

test("denies an image read above the byte threshold, even with a limit", () => {
	const path = image(2048);
	const env = { READ_GUARD_MAX_IMAGE_BYTES: "1024" };
	for (const toolInput of [
		{ file_path: path },
		{ file_path: path, limit: 10 },
	]) {
		const output = runHook(toolInput, env);
		assert.equal(output?.hookSpecificOutput.permissionDecision, "deny");
		assert.match(
			output.hookSpecificOutput.permissionDecisionReason,
			/2048 bytes.*downscaled/,
		);
	}
});

test("allows a small image, and any image when the threshold is 0", () => {
	assert.equal(
		runHook({ file_path: image(512) }, { READ_GUARD_MAX_IMAGE_BYTES: "1024" }),
		undefined,
	);
	assert.equal(
		runHook({ file_path: image(2048) }, { READ_GUARD_MAX_IMAGE_BYTES: "0" }),
		undefined,
	);
});

test("still denies an untargeted large text read", () => {
	const path = join(mkdtempSync(join(tmpdir(), "toolkit-")), "big.txt");
	writeFileSync(path, "line\n".repeat(20));
	const output = runHook({ file_path: path }, { BULK_READER_MIN_LINES: "10" });
	assert.match(
		output.hookSpecificOutput.permissionDecisionReason,
		/20-line read/,
	);
	assert.equal(
		runHook({ file_path: path, limit: 5 }, { BULK_READER_MIN_LINES: "10" }),
		undefined,
	);
});
