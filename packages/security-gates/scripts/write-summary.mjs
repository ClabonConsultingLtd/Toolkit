// Combines the <gate>.json results written by run-gate.mjs into one job
// summary table. A Gate with no result file is listed without counts.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { GATES } from "./run-gate.mjs";

export function summaryMarkdown(resultsDir) {
	const lines = [
		"## Security Gates",
		"",
		"| Gate | Result | Findings | Blocking | Suppressed | Expiring soon |",
		"| --- | --- | --- | --- | --- | --- |",
	];
	for (const [gate, spec] of Object.entries(GATES)) {
		const path = join(resultsDir, `${gate}.json`);
		if (!existsSync(path)) {
			lines.push(
				`| ${spec.title} (${spec.tool}) | no result: the job stopped before the scan finished | | | | |`,
			);
			continue;
		}
		const r = JSON.parse(readFileSync(path, "utf8"));
		const outcome = r.passed ? "passed" : r.error ? "error" : "failed";
		const suppressed = r.suppressionErrors
			? `${r.suppressed} (${r.suppressionErrors} invalid)`
			: `${r.suppressed}`;
		lines.push(
			`| ${spec.title} (${spec.tool}) | ${outcome} | ${r.findings} | ${r.blocking} | ${suppressed} | ${r.expiringSoon} |`,
		);
	}
	lines.push(
		"",
		"Each Gate's findings are in its job summary, and its SARIF is in the run's artifacts.",
	);
	return `${lines.join("\n")}\n`;
}

function main() {
	const { values } = parseArgs({ options: { results: { type: "string" } } });
	if (!values.results) {
		console.log("usage: write-summary.mjs --results <dir>");
		process.exit(2);
	}
	const markdown = summaryMarkdown(values.results);
	console.log(markdown);
	if (process.env.GITHUB_STEP_SUMMARY)
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
}

if (process.argv[1] === import.meta.filename) main();
