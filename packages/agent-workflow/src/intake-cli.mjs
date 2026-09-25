import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	comparePrompt,
	driftSummary,
	livePrompt,
	schedulePaths,
	schedulePrompt,
	scheduleSummary,
} from "./schedule-prompt.mjs";
import { intakeCommand } from "./ticket-intake.mjs";

const readInput = (source) => readFileSync(source === "-" ? 0 : source, "utf8");

function schedulePromptCommand(checkout, options) {
	const expected = schedulePrompt(checkout);
	if (!options.length) return process.stdout.write(expected);
	if (options.length !== 2 || options[0] !== "--check")
		throw new Error("usage: intake schedule-prompt CHECKOUT [--check FILE|-]");
	const drift = comparePrompt(expected, livePrompt(readInput(options[1])));
	if (drift.matches) return console.log(driftSummary(drift));
	console.error(driftSummary(drift));
	const paths = schedulePaths(checkout);
	console.error(
		`regenerate with: node ${paths.intakeHelper} schedule-prompt ${paths.checkout}`,
	);
	process.exitCode = 1;
}

export function main(args = process.argv.slice(2)) {
	try {
		const [command, checkout, request] = args;
		if (command === "schedule-prompt" && checkout)
			return schedulePromptCommand(checkout, args.slice(2));
		if (!command || !checkout || args.length > 3)
			throw new Error(
				"usage: intake COMMAND CHECKOUT [REQUEST.json|-] | schedule-prompt CHECKOUT [--check FILE|-]",
			);
		if (command === "schedule-summary") {
			if (!request)
				throw new Error(
					"usage: intake schedule-summary CHECKOUT SCHEDULE.json|-",
				);
			const summary = scheduleSummary(
				JSON.parse(readInput(request)),
				schedulePrompt(checkout),
			);
			return console.log(JSON.stringify(summary, null, 2));
		}
		const input = request ? JSON.parse(readInput(request)) : {};
		console.log(
			JSON.stringify(intakeCommand(command, checkout, input), null, 2),
		);
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
	main();
