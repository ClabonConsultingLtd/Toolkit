import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { intakeCommand } from "./ticket-intake.mjs";
export function main(args = process.argv.slice(2)) {
	try {
		const [command, checkout, request] = args;
		if (!command || !checkout || args.length > 3)
			throw new Error("usage: intake COMMAND CHECKOUT [REQUEST.json|-]");
		const input = request
			? JSON.parse(readFileSync(request === "-" ? 0 : request, "utf8"))
			: {};
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
