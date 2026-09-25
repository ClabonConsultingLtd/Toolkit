#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { commandKind, summarize } from "./hooks/command-summary.mjs";

const command = process.argv.slice(2).join(" ").trim();
const candidate = commandKind(command);
if (!candidate) {
	console.error("Command is outside the narrow summary allowlist");
	process.exitCode = 2;
} else {
	const result = spawnSync(command, {
		shell: true,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	if (result.status !== 0 || result.error) {
		process.stdout.write(output);
		if (result.error) console.error(result.error.message);
		process.exitCode = result.status || 1;
	} else {
		const stateRoot = resolve(process.env.TOOLKIT_STATE_DIR ?? ".toolkit");
		const logDirectory = join(
			stateRoot,
			"claude-token-optimisation",
			"bash-summary-logs",
		);
		mkdirSync(logDirectory, { recursive: true });
		const logPath = join(logDirectory, `${Date.now()}-${candidate.kind}.log`);
		writeFileSync(logPath, output, "utf8");
		console.log(
			`${summarize(candidate.kind, output, candidate.testPath)}\n\nFull raw output: ${logPath}`,
		);
	}
}
