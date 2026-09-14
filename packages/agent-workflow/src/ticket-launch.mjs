import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2),
	dry = args.includes("--dry-run"),
	n = args.indexOf("--config"),
	configPath = n >= 0 ? args[n + 1] : "toolkit-ticket.json",
	ticket = args.find((x, i) => i !== n && i !== n + 1 && x !== "--dry-run");
if (!ticket)
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
const path = resolve(ticket),
	status = /^\*\*Status:\*\*\s*(.+)$/im
		.exec(readFileSync(path, "utf8"))?.[1]
		?.trim();
if (status !== config.readyStatus)
	throw new Error(`ticket status must be ${config.readyStatus}`);
if (dry) {
	console.log(`${config.command} ${path}`);
	process.exit(0);
}
const result = spawnSync(config.command, [path], {
	stdio: "inherit",
	shell: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
