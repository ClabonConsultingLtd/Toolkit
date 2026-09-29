import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveProvider } from "./ticket-providers.mjs";

function splitCommand(command) {
	const parts = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	return parts.map((part) =>
		(part.startsWith('"') && part.endsWith('"')) ||
		(part.startsWith("'") && part.endsWith("'"))
			? part.slice(1, -1)
			: part,
	);
}

function quoteIfNeeded(value) {
	return /[\s"'$`\\;&|<>()]/.test(value)
		? `'${value.replace(/'/g, `'\\''`)}'`
		: value;
}

const args = process.argv.slice(2),
	dry = args.includes("--dry-run"),
	n = args.indexOf("--config"),
	configPath = n >= 0 ? args[n + 1] : "toolkit-ticket.json",
	ticketArg = args.find((x, i) => i !== n && i !== n + 1 && x !== "--dry-run");
if (!ticketArg)
	throw new Error(
		"usage: node ticket-launch.mjs TICKET [--config FILE] [--dry-run]",
	);
let config;
try {
	config = JSON.parse(readFileSync(resolve(configPath), "utf8"));
} catch (error) {
	throw new Error(`cannot read ticket config: ${error.message}`);
}
if (
	typeof config.readyStatus !== "string" ||
	typeof config.command !== "string" ||
	!config.command
)
	throw new Error("ticket config requires string readyStatus and command");
const provider = resolveProvider(config);
const ticketRef = provider.resolveReference(ticketArg, process.cwd());
const status = provider.getStatus(ticketRef, config);
if (status !== config.readyStatus)
	throw new Error(`ticket status must be ${config.readyStatus}`);
const [commandName, ...commandArgs] = splitCommand(config.command);
if (dry) {
	console.log(`${config.command} ${quoteIfNeeded(ticketRef)}`);
	process.exit(0);
}
const result = spawnSync(commandName, [...commandArgs, ticketRef], {
	stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
