#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	commandKind,
	limitOutput,
	summarize,
} from "./hooks/command-summary.mjs";

const command =
	process.argv[2] === "--encoded"
		? Buffer.from(process.argv[3] ?? "", "base64url")
				.toString("utf8")
				.trim()
		: process.argv.slice(2).join(" ").trim();
const candidate = commandKind(command);
if (!candidate) {
	console.error("Command is outside the narrow summary allowlist");
	process.exitCode = 2;
} else {
	const writeLog = (output) => {
		const stateRoot = resolve(process.env.TOOLKIT_STATE_DIR ?? ".toolkit");
		const logDirectory = join(
			stateRoot,
			"claude-token-optimisation",
			"bash-summary-logs",
		);
		mkdirSync(logDirectory, { recursive: true });
		const logPath = join(logDirectory, `${Date.now()}-${candidate.kind}.log`);
		writeFileSync(logPath, output, "utf8");
		return logPath;
	};
	// The normalised command drops any `| tail`/`| head`, so its exit status
	// cannot be masked by the pipeline.
	const result = spawnSync(`${candidate.run} 2>&1`, {
		shell: true,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	if (result.status !== 0 || result.error) {
		if (candidate.outputLimit && output) {
			process.stdout.write(limitOutput(output, candidate.outputLimit));
			console.error(`Full raw output: ${writeLog(output)}`);
		} else process.stdout.write(output);
		if (result.error) console.error(result.error.message);
		process.exitCode = result.status || 1;
	} else {
		console.log(
			`${summarize(candidate.kind, output, candidate.label)}\n\nFull raw output: ${writeLog(output)}`,
		);
	}
}
