import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STATUS = /^\*\*Status:\*\*\s*(.+)$/im;

function readJson(path, description) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`cannot read ${description} ${path}: ${error.message}`);
	}
}

export function loadManifest(path) {
	const manifest = readJson(path, "manifest");
	if (!Array.isArray(manifest.tickets) || manifest.tickets.length === 0)
		throw new Error("manifest requires a non-empty tickets array");
	if (typeof manifest.ticketConfig !== "string" || !manifest.ticketConfig)
		throw new Error("manifest requires a ticketConfig path");
	if (
		manifest.completeStatus !== undefined &&
		typeof manifest.completeStatus !== "string"
	)
		throw new Error("manifest completeStatus must be a string");
	if (!manifest.tickets.every((ticket) => typeof ticket === "string" && ticket))
		throw new Error("manifest tickets must be non-empty string paths");
	return manifest;
}

function status(path) {
	const found = STATUS.exec(readFileSync(path, "utf8"))?.[1]?.trim();
	if (!found) throw new Error(`ticket has no Status declaration: ${path}`);
	return found;
}

function saveState(path, state) {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
	renameSync(temporary, path);
}

export function runBatch({
	manifestPath,
	dryRun,
	continueOnFailure,
	max,
	launcher = spawnSync,
}) {
	const manifestFile = resolve(manifestPath);
	const manifest = loadManifest(manifestFile);
	const base = dirname(manifestFile);
	const config = resolve(base, manifest.ticketConfig);
	const completeStatus = manifest.completeStatus ?? "done";
	const statePath = resolve(
		base,
		manifest.state ?? ".toolkit/ticket-batch-state.json",
	);
	const state = existsSync(statePath)
		? readJson(statePath, "batch state")
		: { tickets: {} };
	if (!state.tickets || typeof state.tickets !== "object")
		throw new Error("batch state requires a tickets object");
	const launchPath = fileURLToPath(
		new URL("./ticket-launch.mjs", import.meta.url),
	);
	let launched = 0;
	for (const reference of manifest.tickets) {
		if (max !== undefined && launched >= max) break;
		const ticket = resolve(base, reference);
		const current = status(ticket);
		if (current === completeStatus) {
			state.tickets[reference] = { status: "complete", ticketStatus: current };
			if (!dryRun) saveState(statePath, state);
			continue;
		}
		if (dryRun) {
			console.log(`WOULD LAUNCH: ${reference} (current status: ${current})`);
			launched += 1;
			continue;
		}
		const result = launcher(
			process.execPath,
			[launchPath, ticket, "--config", config],
			{ stdio: "inherit" },
		);
		launched += 1;
		const after = status(ticket);
		const completed = result.status === 0 && after === completeStatus;
		state.tickets[reference] = {
			status: completed ? "complete" : "failed",
			ticketStatus: after,
			exitCode: result.status ?? 1,
		};
		saveState(statePath, state);
		if (!completed) {
			const message = `ticket did not complete: ${reference} (exit ${result.status ?? 1}, status ${after})`;
			if (!continueOnFailure) throw new Error(message);
			console.error(message);
		}
	}
	return state;
}

function main() {
	const args = process.argv.slice(2);
	const manifest = args.find((arg) => !arg.startsWith("--"));
	if (!manifest)
		throw new Error(
			"usage: node ticket-batch.mjs MANIFEST [--dry-run] [--continue-on-failure] [--max N]",
		);
	const maxIndex = args.indexOf("--max");
	const max = maxIndex === -1 ? undefined : Number(args[maxIndex + 1]);
	if (max !== undefined && (!Number.isInteger(max) || max < 1))
		throw new Error("--max must be a positive integer");
	runBatch({
		manifestPath: manifest,
		dryRun: args.includes("--dry-run"),
		continueOnFailure: args.includes("--continue-on-failure"),
		max,
	});
}

if (import.meta.url === `file://${process.argv[1].replaceAll("\\", "/")}`) {
	try {
		main();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
