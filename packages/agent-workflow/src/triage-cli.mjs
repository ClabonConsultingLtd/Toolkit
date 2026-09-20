import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readTriageLabels, statusLabels } from "./triage-labels.mjs";
import { acquireTriageLock, releaseTriageLock } from "./triage-lock.mjs";

export function execute(command, input = {}) {
	if (command === "labels") {
		if (!input.path)
			throw new Error("path to the repo's triage-labels.md required");
		const mapping = readTriageLabels(resolve(input.path));
		return { mapping, statusLabels: statusLabels(mapping) };
	}
	if (command === "lock") {
		if (!input.lockDir) throw new Error("lockDir required");
		return acquireTriageLock(resolve(input.lockDir), { ttlMs: input.ttlMs });
	}
	if (command === "unlock") {
		if (!input.lockDir) throw new Error("lockDir required");
		return releaseTriageLock(resolve(input.lockDir));
	}
	throw new Error(`unknown command: ${command}`);
}

export function main(args = process.argv.slice(2)) {
	try {
		const [command, request] = args;
		if (!command || args.length > 2)
			throw new Error("usage: triage COMMAND [request.json|-]");
		const input = request
			? JSON.parse(readFileSync(request === "-" ? 0 : request, "utf8"))
			: {};
		console.log(JSON.stringify(execute(command, input), null, 2));
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
