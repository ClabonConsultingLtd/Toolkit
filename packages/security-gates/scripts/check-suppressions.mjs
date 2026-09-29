// Checks that every Suppression in a consumer repository has a reason and an
// expiry date that hasn't passed, and warns when one expires soon.
//
// Suppressions live in each tool's own ignore file:
//   gitleaks     .gitleaksignore at the repository root
//   opengrep     .semgrepignore files
//   osv-scanner  osv-scanner.toml files, using the native reason and
//                ignoreUntil (or effectiveUntil) fields
//   trivy        .trivyignore at the repository root
//   dockle       .dockleignore at the repository root
//
// In the other files, each entry carries a comment on the line directly above
// it:
//   # reason: <text> expires: YYYY-MM-DD
// A comment covers the consecutive entries below it, up to a blank line.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

export const WARN_WITHIN_DAYS = 14;
export const TOOLS = ["gitleaks", "opengrep", "osv-scanner", "trivy", "dockle"];

// Tools whose ignore file is a single file at the repository root.
const ROOT_IGNORE_FILES = {
	gitleaks: ".gitleaksignore",
	trivy: ".trivyignore",
	dockle: ".dockleignore",
};

const SKIP_DIRS = new Set([".git", "node_modules"]);

function walk(root, name, dir = root, found = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name))
				walk(root, name, join(dir, entry.name), found);
		} else if (entry.name === name) {
			found.push(relative(root, join(dir, entry.name)));
		}
	}
	return found.sort();
}

export function ignoreFiles(tool, root) {
	const rootFile = ROOT_IGNORE_FILES[tool];
	if (rootFile) return existsSync(join(root, rootFile)) ? [rootFile] : [];
	if (tool === "opengrep") return walk(root, ".semgrepignore");
	if (tool === "osv-scanner") return walk(root, "osv-scanner.toml");
	throw new Error(`unknown tool "${tool}"; choose from ${TOOLS.join(", ")}`);
}

// Parses the "# reason: <text> expires: YYYY-MM-DD" convention. Returns the
// Suppressions, one per entry line, with the reason and expiry found (or
// undefined).
export function parseCommentedIgnoreFile(text) {
	const suppressions = [];
	let reason;
	let expires;
	let afterEntry = false;
	for (const [index, raw] of text.split(/\r?\n/).entries()) {
		const line = raw.trim();
		if (line === "") {
			reason = expires = undefined;
			afterEntry = false;
			continue;
		}
		if (line.startsWith("#")) {
			if (afterEntry) {
				reason = expires = undefined;
				afterEntry = false;
			}
			const body = line.replace(/^#+\s*/, "");
			const reasonMatch = /^reason:\s*(.*?)\s*(?:\bexpires:.*)?$/i.exec(body);
			const expiresMatch = /\bexpires:\s*(\S*)/i.exec(body);
			if (reasonMatch) reason = reasonMatch[1] || undefined;
			if (expiresMatch) expires = expiresMatch[1] || undefined;
			continue;
		}
		suppressions.push({ line: index + 1, entry: line, reason, expires });
		afterEntry = true;
	}
	return suppressions;
}

function parseTomlValue(raw) {
	const value = raw.trim();
	const quoted = /^"((?:[^"\\]|\\.)*)"|^'([^']*)'/.exec(value);
	if (quoted)
		return quoted[1] !== undefined ? JSON.parse(`"${quoted[1]}"`) : quoted[2];
	const bare = value.replace(/\s+#.*$/, "");
	if (bare === "true" || bare === "false") return bare === "true";
	return bare;
}

// Reads the tables osv-scanner.toml uses for Suppressions. This is not a
// general TOML parser: it understands [[IgnoredVulns]], [[PackageOverrides]]
// and their [PackageOverrides.*] sub-tables, with one key per line.
export function parseOsvConfig(text) {
	const tables = [];
	let current;
	let prefix = "";
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index].trim();
		if (line === "" || line.startsWith("#")) continue;
		const arrayTable = /^\[\[\s*([\w.-]+)\s*\]\]/.exec(line);
		if (arrayTable) {
			current = { table: arrayTable[1], line: index + 1, fields: {} };
			tables.push(current);
			prefix = "";
			continue;
		}
		const table = /^\[\s*([\w.-]+)\s*\]/.exec(line);
		if (table) {
			const [parent, ...rest] = table[1].split(".");
			if (current && parent === current.table && rest.length > 0) {
				prefix = `${rest.join(".")}.`;
			} else {
				current = undefined;
			}
			continue;
		}
		const pair = /^([\w-]+)\s*=\s*(.*)$/.exec(line);
		if (!pair || !current) continue;
		let raw = pair[2];
		const multi = /^("""|''')/.exec(raw);
		if (multi) {
			let body = raw.slice(3);
			while (!body.includes(multi[1]) && index + 1 < lines.length)
				body += `\n${lines[++index]}`;
			current.fields[prefix + pair[1]] = body
				.slice(0, body.indexOf(multi[1]))
				.trim();
			continue;
		}
		raw = parseTomlValue(raw);
		current.fields[prefix + pair[1]] = raw;
	}
	return tables;
}

// Turns osv-scanner.toml tables into Suppressions. PackageOverrides only
// counts when it ignores something; licence corrections aren't Suppressions.
export function osvSuppressions(text) {
	const suppressions = [];
	for (const { table, line, fields } of parseOsvConfig(text)) {
		if (table === "IgnoredVulns") {
			suppressions.push({
				line,
				entry: fields.id ?? "(no id)",
				reason: fields.reason || undefined,
				expires: fields.ignoreUntil || undefined,
			});
		} else if (
			table === "PackageOverrides" &&
			(fields.ignore === true ||
				fields["vulnerability.ignore"] === true ||
				fields["license.ignore"] === true)
		) {
			suppressions.push({
				line,
				entry: `package ${fields.name ?? "(any)"}${fields.version ? `@${fields.version}` : ""}`,
				reason: fields.reason || undefined,
				expires: fields.effectiveUntil || undefined,
			});
		}
	}
	return suppressions;
}

function parseDate(value) {
	const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(value ?? "");
	if (!match) return undefined;
	const date = Date.UTC(
		Number(match[1]),
		Number(match[2]) - 1,
		Number(match[3]),
	);
	return new Date(date)
		.toISOString()
		.startsWith(`${match[1]}-${match[2]}-${match[3]}`)
		? date
		: undefined;
}

// Classifies one Suppression against today's date (YYYY-MM-DD). A Suppression
// is valid through its expiry date and expired from the day after.
export function evaluate(suppression, today) {
	const problems = [];
	if (!suppression.reason) problems.push("has no reason");
	if (!suppression.expires) {
		problems.push("has no expiry date");
	} else {
		const expires = parseDate(suppression.expires);
		const now = parseDate(today);
		if (expires === undefined) {
			problems.push(
				`has an expiry "${suppression.expires}" that isn't a YYYY-MM-DD date`,
			);
		} else if (expires < now) {
			problems.push(`expired on ${suppression.expires.slice(0, 10)}`);
		} else {
			const days = Math.round((expires - now) / 86_400_000);
			if (problems.length === 0 && days <= WARN_WITHIN_DAYS) {
				return {
					level: "warning",
					message: `expires in ${days} day${days === 1 ? "" : "s"} (${suppression.expires.slice(0, 10)})`,
				};
			}
		}
	}
	return problems.length
		? { level: "error", message: problems.join(", ") }
		: { level: "ok" };
}

export function checkSuppressions(
	tool,
	root,
	today = new Date().toISOString().slice(0, 10),
) {
	const results = [];
	for (const file of ignoreFiles(tool, root)) {
		const text = readFileSync(join(root, file), "utf8");
		const suppressions =
			tool === "osv-scanner"
				? osvSuppressions(text)
				: parseCommentedIgnoreFile(text);
		for (const suppression of suppressions)
			results.push({ file, ...suppression, ...evaluate(suppression, today) });
	}
	return {
		tool,
		suppressions: results,
		errors: results.filter((r) => r.level === "error").length,
		expiringSoon: results.filter((r) => r.level === "warning").length,
	};
}

function escapeData(text) {
	return text
		.replaceAll("%", "%25")
		.replaceAll("\r", "%0D")
		.replaceAll("\n", "%0A");
}

function escapeProperty(text) {
	return escapeData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

// Prints GitHub workflow annotations. pathPrefix maps files back to their
// repository path when the scan root isn't the working directory.
export function report(result, { pathPrefix = "", log = console.log } = {}) {
	for (const s of result.suppressions) {
		if (s.level === "ok") continue;
		const file = escapeProperty(`${pathPrefix}${s.file}`);
		const text = escapeData(
			`${result.tool} Suppression "${s.entry}" ${s.message}`,
		);
		log(`::${s.level} file=${file},line=${s.line}::${text}`);
	}
	log(
		`${result.tool}: ${result.suppressions.length} Suppression(s), ${result.errors} invalid, ${result.expiringSoon} expiring within ${WARN_WITHIN_DAYS} days`,
	);
}

const USAGE = `usage: check-suppressions.mjs --tool <${TOOLS.join("|")}> [--root <dir>] [--today YYYY-MM-DD]`;

function main() {
	const { values } = parseArgs({
		options: {
			tool: { type: "string" },
			root: { type: "string", default: "." },
			today: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help || !TOOLS.includes(values.tool)) {
		console.log(USAGE);
		process.exit(values.help ? 0 : 2);
	}
	const result = checkSuppressions(values.tool, values.root, values.today);
	report(result);
	process.exit(result.errors > 0 ? 1 : 0);
}

if (process.argv[1] === import.meta.filename) main();
