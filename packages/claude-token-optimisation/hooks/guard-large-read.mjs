#!/usr/bin/env node

/**
 * Route untargeted, large primary-session reads to a concise read-only agent.
 * A guard failure deliberately allows the original read to continue.
 */
import { existsSync, readFileSync } from "node:fs";

const DEFAULT_MIN_LINES = 350;

function minimumLines() {
	const configured = Number.parseInt(
		process.env.BULK_READER_MIN_LINES ?? "",
		10,
	);
	return Number.isSafeInteger(configured) && configured > 0
		? configured
		: DEFAULT_MIN_LINES;
}

async function readHookInput() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

let input;
try {
	input = await readHookInput();
} catch {
	process.exit(0);
}

// Reads initiated by the designated analyst do not enter the primary context.
if (input.agent_id) process.exit(0);

const { file_path: filePath, offset, limit } = input.tool_input ?? {};
if (
	!filePath ||
	offset !== undefined ||
	limit !== undefined ||
	!existsSync(filePath)
) {
	process.exit(0);
}

let lines = 0;
try {
	const content = readFileSync(filePath);
	if (content.includes(0)) process.exit(0);
	for (const byte of content) if (byte === 10) lines += 1;
	if (content.length > 0 && content.at(-1) !== 10) lines += 1;
} catch {
	process.exit(0);
}

const minimum = minimumLines();
if (lines <= minimum) process.exit(0);

console.log(
	JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason:
				`This is an untargeted ${lines}-line read (threshold: ${minimum}). ` +
				"Delegate factual, broad analysis to the bulk-reader subagent. " +
				"For an edit or verification, retry with an offset or limit for the exact section.",
		},
	}),
);
