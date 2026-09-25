#!/usr/bin/env node

/**
 * Route untargeted, large primary-session reads to a concise read-only agent,
 * and ask for a cropped or downscaled copy of a large image.
 * A guard failure deliberately allows the original read to continue.
 */
import { existsSync, readFileSync, statSync } from "node:fs";

const DEFAULT_MIN_LINES = 350;
const DEFAULT_MAX_IMAGE_BYTES = 512 * 1024;
const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|bmp)$/i;

function deny(reason) {
	console.log(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: reason,
			},
		}),
	);
}

// 0 disables the image check.
function maximumImageBytes() {
	const configured = Number.parseInt(
		process.env.READ_GUARD_MAX_IMAGE_BYTES ?? "",
		10,
	);
	return Number.isSafeInteger(configured) && configured >= 0
		? configured
		: DEFAULT_MAX_IMAGE_BYTES;
}

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
if (!filePath || !existsSync(filePath)) process.exit(0);

// Offset and limit do not reduce an image read, so they do not bypass this.
if (IMAGE_EXTENSION.test(filePath)) {
	const maximum = maximumImageBytes();
	let bytes = 0;
	try {
		bytes = statSync(filePath).size;
	} catch {
		process.exit(0);
	}
	if (maximum === 0 || bytes <= maximum) process.exit(0);
	deny(
		`This image is ${bytes} bytes (threshold: ${maximum}). ` +
			"Read its dimensions or metadata first, then view a cropped or downscaled copy of the region you need.",
	);
	process.exit(0);
}

if (offset !== undefined || limit !== undefined) process.exit(0);

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

deny(
	`This is an untargeted ${lines}-line read (threshold: ${minimum}). ` +
		"Delegate factual, broad analysis to the bulk-reader subagent. " +
		"For an edit or verification, retry with an offset or limit for the exact section.",
);
