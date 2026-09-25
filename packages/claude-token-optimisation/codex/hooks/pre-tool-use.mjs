#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { commandKind } from "../../hooks/command-summary.mjs";

function shellQuote(value) {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export function rewrite(input) {
	if (input?.tool_name !== "Bash") return null;
	const command = input.tool_input?.command;
	if (typeof command !== "string" || !commandKind(command.trim())) return null;
	const wrapper = fileURLToPath(
		new URL("../../summarize-command.mjs", import.meta.url),
	);
	const encoded = Buffer.from(command, "utf8").toString("base64url");
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "allow",
			updatedInput: {
				...input.tool_input,
				command: `node ${shellQuote(wrapper)} --encoded ${encoded}`,
			},
		},
	};
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	try {
		const result = rewrite(JSON.parse(Buffer.concat(chunks).toString("utf8")));
		if (result) console.log(JSON.stringify(result));
	} catch {
		// A malformed hook input leaves the original tool call unchanged.
	}
}
