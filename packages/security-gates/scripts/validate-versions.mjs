// Checks a scanner-versions.json file's shape with install-scanners.mjs's
// own parser, without downloading or running anything. Used by the bump
// workflow's pull-request job, which holds push credentials and must not
// execute a scanner binary it hasn't itself verified.
import { readFileSync } from "node:fs";
import { DEFAULT_VERSIONS_PATH, parseVersions } from "./install-scanners.mjs";

const USAGE = "usage: validate-versions.mjs [file]";

function main() {
	const [, , arg, extra] = process.argv;
	if (arg === "-h" || arg === "--help" || extra !== undefined) {
		console.log(USAGE);
		process.exit(arg === "-h" || arg === "--help" ? 0 : 2);
	}
	const path = arg ?? DEFAULT_VERSIONS_PATH;
	try {
		parseVersions(readFileSync(path, "utf8"));
	} catch (error) {
		console.error(`::error::${error.message}`);
		process.exit(1);
	}
	console.log(`${path}: shape OK`);
}

if (process.argv[1] === import.meta.filename) main();
