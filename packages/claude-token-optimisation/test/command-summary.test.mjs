import assert from "node:assert/strict";
import test from "node:test";
import {
	commandKind,
	limitOutput,
	normaliseCommand,
	summarize,
} from "../hooks/command-summary.mjs";

test("normalises timeout, stderr merge and a tail pipeline", () => {
	assert.deepEqual(
		normaliseCommand(
			"timeout 180 pnpm exec vitest run src/a.test.ts 2>&1 | tail -60",
		),
		{
			core: "pnpm exec vitest run src/a.test.ts",
			run: "timeout 180 pnpm exec vitest run src/a.test.ts",
			outputLimit: { from: "tail", lines: 60 },
		},
	);
});

test("normalises cd and pipefail prefixes and a head -n pipeline", () => {
	assert.deepEqual(
		normaliseCommand(
			'cd "/tmp/work tree" && set -o pipefail; timeout 90s git status 2>&1 | head -n 20',
		),
		{
			core: "git status",
			run: 'cd "/tmp/work tree" && timeout 90s git status',
			outputLimit: { from: "head", lines: 20 },
		},
	);
	assert.equal(
		normaliseCommand("set -o pipefail && git status | tail -5").core,
		"git status",
	);
	assert.equal(normaliseCommand("git status 2>&1").core, "git status");
});

test("matches wrapped vitest, vitest -t and tsc --noEmit shapes", () => {
	const wrapped = commandKind(
		"timeout 180 pnpm exec vitest run src/a.test.ts 2>&1 | tail -60",
	);
	assert.equal(wrapped.kind, "vitest-single-file");
	assert.equal(wrapped.label, "src/a.test.ts");
	assert.equal(wrapped.run, "timeout 180 pnpm exec vitest run src/a.test.ts");

	const named = commandKind(
		"npx vitest run src/a.spec.tsx -t 'renders the header'",
	);
	assert.equal(named.kind, "vitest-single-file");
	assert.equal(named.label, "src/a.spec.tsx -t 'renders the header'");
	assert.equal(
		commandKind('vitest run src/a.test.ts --testNamePattern="parses input"')
			?.kind,
		"vitest-single-file",
	);

	for (const command of [
		"tsc --noEmit",
		"pnpm exec tsc --noEmit",
		"npx tsc --noEmit -p packages/app",
		"timeout 300 pnpm exec tsc --noEmit 2>&1 | tail -40",
	])
		assert.equal(commandKind(command)?.kind, "tsc-no-emit", command);
});

test("still rejects commands outside the allowlist after normalisation", () => {
	for (const command of [
		"timeout 60 git diff 2>&1 | tail -5",
		"vitest run 2>&1 | tail -60",
		"vitest run src/a.test.ts; rm -rf build",
		"git status | grep modified",
		"tsc --noEmit && echo done",
		"vitest run src/a.test.ts -t $(whoami)",
	])
		assert.equal(commandKind(command), null, command);
});

test("limitOutput keeps the requested end of the output", () => {
	const output = "1\n2\n3\n4\n";
	assert.equal(limitOutput(output, { from: "tail", lines: 2 }), "3\n4\n");
	assert.equal(limitOutput(output, { from: "head", lines: 2 }), "1\n2\n");
	assert.equal(limitOutput(output, undefined), output);
});

test("summarizes a clean tsc --noEmit run", () => {
	assert.equal(
		summarize("tsc-no-emit", "", "pnpm exec tsc --noEmit"),
		"pnpm exec tsc --noEmit: exit 0, no type errors",
	);
});
