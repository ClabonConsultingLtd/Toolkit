import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	buildDigest,
	readBatches,
	readCursor,
	renderMarkdown,
	writeCursor,
} from "./digest.mjs";
import { atomicWriteText } from "./orchestration.mjs";
import { recommendation } from "./orchestration-github.mjs";

function gh(args) {
	return execFileSync("gh", args, {
		encoding: "utf8",
		timeout: 60_000,
		stdio: ["ignore", "pipe", "pipe"],
	});
}
export function fetchRecommendation(repository, number, exec = gh) {
	const data = JSON.parse(
		exec(["issue", "view", String(number), "--repo", repository, "--json", "body"]),
	);
	return recommendation(data.body);
}
function cachedRecommendationFor(exec) {
	const cache = new Map();
	return (state, ticket) => {
		const key = `${state.repository}#${ticket.number}`;
		if (!cache.has(key)) {
			try {
				cache.set(key, fetchRecommendation(state.repository, ticket.number, exec));
			} catch {
				cache.set(key, null);
			}
		}
		return cache.get(key);
	};
}
export function run(checkoutDir, input = {}, options = {}) {
	const base = resolve(checkoutDir);
	const orchestrationDir = join(base, ".toolkit", "orchestration");
	const reportDir = join(base, ".toolkit", "report-tickets");
	const cursorPath = join(reportDir, "cursor.json");
	const readBatchesFn = options.readBatches ?? readBatches;
	const readCursorFn = options.readCursor ?? readCursor;
	const writeCursorFn = options.writeCursor ?? writeCursor;
	const writeFile = options.writeFile ?? atomicWriteText;
	const states = readBatchesFn(orchestrationDir);
	const cursor = readCursorFn(cursorPath);
	const activity = input.activity ?? {};
	const digest = buildDigest(states, {
		now: input.now ?? Date.now(),
		cursor,
		stuckHours: input.stuckHours ?? 24,
		activity: (agentId) => activity[agentId] ?? null,
		recommendationFor: options.recommendationFor ?? cachedRecommendationFor(options.exec ?? gh),
	});
	const markdown = renderMarkdown(digest);
	writeFile(join(reportDir, "digest.json"), `${JSON.stringify(digest, null, 2)}\n`);
	writeFile(join(reportDir, "digest.md"), `${markdown}\n`);
	writeCursorFn(cursorPath, { lastDigestAt: digest.generatedAt });
	return { ...digest, markdown };
}
export function main(args = process.argv.slice(2)) {
	try {
		const [checkoutDir, request] = args;
		if (!checkoutDir || args.length > 2)
			throw new Error("usage: digest CHECKOUT_DIR [REQUEST.json|-]");
		const input = request
			? JSON.parse(readFileSync(request === "-" ? 0 : request, "utf8"))
			: {};
		console.log(JSON.stringify(run(checkoutDir, input), null, 2));
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
