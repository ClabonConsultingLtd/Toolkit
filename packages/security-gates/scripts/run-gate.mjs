// Runs one Gate over a checked-out repository, applies its failure policy,
// and writes <gate>.sarif and <gate>.json into the output directory. Exits 1
// when the Gate fails.
//
//   secrets                Gitleaks. Any unsuppressed finding fails.
//   dependencies           OSV-Scanner. Fails on a vulnerability at or above
//                          the severity threshold (CVSS) that has a fix
//                          available.
//   static-analysis        Opengrep. Fails on ERROR findings.
//
// The opt-in image Gate scans a `docker save` tarball (--image) in two parts:
//   image-vulnerabilities  Trivy. The same policy as dependencies, for OS
//                          and application packages in the image.
//   image-lint             Dockle. Fails on FATAL findings, reports WARN.
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkSuppressions, report } from "./check-suppressions.mjs";

export const GATES = {
	secrets: { title: "Secrets", tool: "gitleaks" },
	dependencies: { title: "Dependencies", tool: "osv-scanner" },
	"static-analysis": { title: "Static analysis", tool: "opengrep" },
	"image-vulnerabilities": { title: "Image", tool: "trivy", optIn: true },
	"image-lint": { title: "Image", tool: "dockle", optIn: true },
};

// Lowest CVSS base score in each severity band.
export const SEVERITY_THRESHOLDS = {
	low: 0.1,
	medium: 4.0,
	high: 7.0,
	critical: 9.0,
};

// Used when an advisory has no CVSS score, only a severity label.
const LABEL_SCORES = {
	LOW: 0.1,
	MODERATE: 4.0,
	MEDIUM: 4.0,
	HIGH: 7.0,
	CRITICAL: 9.0,
};

const DEFAULT_RULES_DIR = new URL("../rules", import.meta.url).pathname;
const DETAIL_LIMIT = 50;

function run(command, args, { cwd, okStatuses = [0] }) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
	});
	if (result.error)
		throw new Error(`could not run ${command}: ${result.error.message}`);
	process.stderr.write(result.stderr);
	if (!okStatuses.includes(result.status)) {
		throw new Error(`${command} exited with status ${result.status}`);
	}
	return result;
}

function sarifResults(path) {
	const sarif = JSON.parse(readFileSync(path, "utf8"));
	return (sarif.runs ?? []).flatMap((run) => run.results ?? []);
}

function location(result) {
	const physical = result.locations?.[0]?.physicalLocation;
	return `${physical?.artifactLocation?.uri ?? "?"}:${physical?.region?.startLine ?? "?"}`;
}

// --- secrets -----------------------------------------------------------------

export function secretsFindings(results) {
	return results.map((result) => {
		const physical = result.locations?.[0]?.physicalLocation;
		const commit = result.partialFingerprints?.commitSha;
		const file = physical?.artifactLocation?.uri;
		const line = physical?.region?.startLine;
		const fingerprint = commit
			? `${commit}:${file}:${result.ruleId}:${line}`
			: `${file}:${result.ruleId}:${line}`;
		return {
			blocking: true,
			text: `${result.ruleId} at ${location(result)}, fingerprint ${fingerprint}`,
		};
	});
}

function runSecrets({ target, outDir, gitleaks, base, head }) {
	const sarif = join(outDir, "secrets.sarif");
	const args = [
		"git",
		"--no-banner",
		"--redact",
		"--ignore-gitleaks-allow",
		"--exit-code",
		"0",
		"--gitleaks-ignore-path",
		".",
		"--report-format",
		"sarif",
		"--report-path",
		sarif,
	];
	// Pull requests scan the commits they add; everything else scans history.
	if (base && head) args.push(`--log-opts=${base}..${head}`);
	args.push(".");
	run(gitleaks, args, { cwd: target });
	return { findings: secretsFindings(sarifResults(sarif)), sarif };
}

// --- dependencies ------------------------------------------------------------

export function severityScore(group, vulnerabilities) {
	const score = Number.parseFloat(group.max_severity);
	if (Number.isFinite(score)) return score;
	const labels = vulnerabilities.map(
		(v) =>
			LABEL_SCORES[String(v.database_specific?.severity ?? "").toUpperCase()],
	);
	const known = labels.filter((l) => l !== undefined);
	return known.length ? Math.max(...known) : undefined;
}

// A fix is available when an advisory in the group records a fixed version
// for this package.
export function hasFix(pkg, vulnerabilities) {
	return vulnerabilities.some((v) =>
		(v.affected ?? []).some(
			(a) =>
				a.package?.name === pkg.name &&
				(!a.package?.ecosystem ||
					!pkg.ecosystem ||
					a.package.ecosystem === pkg.ecosystem) &&
				(a.ranges ?? []).some((range) =>
					(range.events ?? []).some((event) => event.fixed),
				),
		),
	);
}

export function dependencyFindings(osv, threshold, root = "") {
	const findings = [];
	for (const source of osv.results ?? []) {
		const path =
			root && isAbsolute(source.source?.path ?? "")
				? relative(root, source.source.path)
				: source.source?.path;
		for (const entry of source.packages ?? []) {
			const pkg = entry.package ?? {};
			for (const group of entry.groups ?? []) {
				const vulnerabilities = (entry.vulnerabilities ?? []).filter(
					(v) => group.ids?.includes(v.id) || group.aliases?.includes(v.id),
				);
				const score = severityScore(group, vulnerabilities);
				const fixable = hasFix(pkg, vulnerabilities);
				const atThreshold = score !== undefined && score >= threshold;
				findings.push({
					blocking: atThreshold && fixable,
					text: `${pkg.name}@${pkg.version} (${pkg.ecosystem}) ${group.ids?.join(", ")}: severity ${score ?? "unknown"}, ${fixable ? "fix available" : "no fix available"} in ${path}`,
				});
			}
		}
	}
	return findings;
}

function runDependencies({ target, outDir, osvScanner, threshold }) {
	const json = join(outDir, "dependencies.osv.json");
	const sarif = join(outDir, "dependencies.sarif");
	const common = ["scan", "source", "--recursive", "--allow-no-lockfiles"];
	// Exit status 1 means vulnerabilities were found; the policy decides.
	run(
		osvScanner,
		[...common, "--licenses", "--format", "json", "--output-file", json, "."],
		{
			cwd: target,
			okStatuses: [0, 1],
		},
	);
	run(
		osvScanner,
		[...common, "--format", "sarif", "--output-file", sarif, "."],
		{ cwd: target, okStatuses: [0, 1] },
	);
	const osv = JSON.parse(readFileSync(json, "utf8"));
	return {
		findings: dependencyFindings(osv, threshold, resolve(target)),
		licences: (osv.license_summary ?? []).map((l) => ({
			name: l.name,
			count: l.count,
		})),
		sarif,
	};
}

// --- static analysis ---------------------------------------------------------

export function staticFindings(opengrep) {
	return (opengrep.results ?? []).map((result) => ({
		blocking: result.extra?.severity === "ERROR",
		text: `${result.extra?.severity} ${result.check_id.split(".").pop()} at ${result.path}:${result.start?.line}`,
	}));
}

function runStaticAnalysis({ target, outDir, opengrep, rulesDir }) {
	const json = join(outDir, "static-analysis.opengrep.json");
	const sarif = join(outDir, "static-analysis.sarif");
	const configs = ["--config", resolve(rulesDir)];
	if (existsSync(join(target, ".opengrep")))
		configs.push("--config", ".opengrep");
	// --disable-nosem: Suppressions belong in .semgrepignore, not inline.
	run(
		opengrep,
		[
			"scan",
			...configs,
			"--disable-nosem",
			"--disable-version-check",
			"--quiet",
			"--json-output",
			json,
			"--sarif-output",
			sarif,
			".",
		],
		{ cwd: target },
	);
	return {
		findings: staticFindings(JSON.parse(readFileSync(json, "utf8"))),
		sarif,
	};
}

// --- image -------------------------------------------------------------------

// The image to scan: a `docker save` tarball, or a directory (such as a
// downloaded artifact) holding exactly one file.
export function resolveImage(path) {
	if (!path) throw new Error("the image Gate needs --image");
	if (!statSync(path).isDirectory()) return path;
	const files = readdirSync(path, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));
	if (files.length !== 1) {
		throw new Error(
			`the image artifact must hold exactly one docker save tarball, but it holds ${files.length} files`,
		);
	}
	return files[0];
}

// Trivy's highest CVSS score for a vulnerability across its sources, or its
// severity label when there's no score.
export function imageSeverityScore(vulnerability) {
	const scores = Object.values(vulnerability.CVSS ?? {})
		.flatMap((cvss) => [cvss.V40Score, cvss.V3Score])
		.filter((score) => Number.isFinite(score) && score > 0);
	if (scores.length) return Math.max(...scores);
	return LABEL_SCORES[String(vulnerability.Severity ?? "").toUpperCase()];
}

export function imageVulnerabilityFindings(trivy, threshold) {
	const findings = [];
	for (const result of trivy.Results ?? []) {
		for (const v of result.Vulnerabilities ?? []) {
			const score = imageSeverityScore(v);
			const fixable = Boolean(v.FixedVersion);
			const atThreshold = score !== undefined && score >= threshold;
			findings.push({
				blocking: atThreshold && fixable,
				text: `${v.PkgName}@${v.InstalledVersion} (${result.Type}) ${v.VulnerabilityID}: severity ${score ?? "unknown"}, ${fixable ? `fix available in ${v.FixedVersion}` : "no fix available"} in ${result.Target}`,
			});
		}
	}
	return findings;
}

function imageName(trivy) {
	const { RepoTags = [], ImageID } = trivy.Metadata ?? {};
	return [...RepoTags, ImageID].filter(Boolean).join(", ") || undefined;
}

function runImageVulnerabilities({ target, outDir, trivy, image, threshold }) {
	const json = join(outDir, "image-vulnerabilities.trivy.json");
	const sarif = join(outDir, "image-vulnerabilities.sarif");
	// Trivy fails on a missing --ignorefile, and otherwise reads .trivyignore
	// from its working directory, so it runs in outDir.
	const ignoreFile = join(target, ".trivyignore");
	const ignore = existsSync(ignoreFile) ? ["--ignorefile", ignoreFile] : [];
	run(
		trivy,
		[
			"image",
			"--input",
			image,
			"--scanners",
			"vuln",
			"--no-progress",
			"--skip-version-check",
			"--timeout",
			"20m",
			...ignore,
			"--format",
			"json",
			"--output",
			json,
		],
		{ cwd: outDir },
	);
	run(
		trivy,
		["convert", ...ignore, "--format", "sarif", "--output", sarif, json],
		{ cwd: outDir },
	);
	const report = JSON.parse(readFileSync(json, "utf8"));
	return {
		findings: imageVulnerabilityFindings(report, threshold),
		image: imageName(report),
		sarif,
	};
}

export function imageLintFindings(dockle) {
	return (dockle.details ?? [])
		.filter((d) => d.level === "FATAL" || d.level === "WARN")
		.map((d) => ({
			blocking: d.level === "FATAL",
			text: `${d.level} ${d.code} ${d.title}: ${(d.alerts ?? []).join("; ")}`,
		}));
}

function runImageLint({ target, outDir, dockle, image }) {
	const json = join(outDir, "image-lint.dockle.json");
	const sarif = join(outDir, "image-lint.sarif");
	// Dockle reads .dockleignore from its working directory.
	for (const [format, output] of [
		["json", json],
		["sarif", sarif],
	]) {
		run(
			dockle,
			[
				"--exit-code",
				"0",
				"--format",
				format,
				"--output",
				output,
				"--input",
				image,
			],
			{ cwd: target },
		);
	}
	return {
		findings: imageLintFindings(JSON.parse(readFileSync(json, "utf8"))),
		sarif,
	};
}

// --- summary -----------------------------------------------------------------

export function gateMarkdown(result) {
	const lines = [
		`### ${result.title} Gate: ${result.passed ? "passed" : "failed"}`,
		"",
		`${result.findings} finding(s), ${result.blocking} blocking. ${result.suppressed} Suppression(s), ${result.expiringSoon} expiring soon, ${result.suppressionErrors} invalid.`,
	];
	if (result.image) lines.push("", `Image: ${result.image}`);
	if (result.error) lines.push("", `Error: ${result.error}`);
	const listed = result.details.slice(0, DETAIL_LIMIT);
	if (listed.length) {
		lines.push("", "| Blocks | Finding |", "| --- | --- |");
		for (const d of listed)
			lines.push(
				`| ${d.blocking ? "yes" : "no"} | ${d.text.replaceAll("|", "\\|")} |`,
			);
		if (result.details.length > DETAIL_LIMIT)
			lines.push(
				"",
				`${result.details.length - DETAIL_LIMIT} more in the SARIF artifact.`,
			);
	}
	if (result.licences?.length) {
		lines.push("", "Licences:", "", "| Licence | Packages |", "| --- | --- |");
		for (const l of result.licences) lines.push(`| ${l.name} | ${l.count} |`);
	}
	return `${lines.join("\n")}\n`;
}

export function runGate(gate, options) {
	const spec = GATES[gate];
	if (!spec)
		throw new Error(
			`unknown gate "${gate}"; choose from ${Object.keys(GATES).join(", ")}`,
		);
	const threshold = SEVERITY_THRESHOLDS[options.severity ?? "high"];
	if (threshold === undefined) {
		throw new Error(
			`severity must be one of ${Object.keys(SEVERITY_THRESHOLDS).join(", ")}`,
		);
	}
	const target = resolve(options.target ?? ".");
	const outDir = resolve(options.outDir);
	mkdirSync(outDir, { recursive: true });
	const bin = (tool) => (options.binDir ? join(options.binDir, tool) : tool);

	const suppressionCheck = checkSuppressions(spec.tool, target, options.today);
	report(suppressionCheck, {
		pathPrefix: options.pathPrefix ?? "",
		log: options.log ?? console.log,
	});

	const result = {
		gate,
		title: spec.title,
		tool: spec.tool,
		suppressed: suppressionCheck.suppressions.length,
		expiringSoon: suppressionCheck.expiringSoon,
		suppressionErrors: suppressionCheck.errors,
		findings: 0,
		blocking: 0,
		details: [],
	};
	try {
		let scan;
		if (gate === "secrets") {
			scan = runSecrets({
				target,
				outDir,
				gitleaks: bin("gitleaks"),
				base: options.base,
				head: options.head,
			});
		} else if (gate === "dependencies") {
			scan = runDependencies({
				target,
				outDir,
				osvScanner: bin("osv-scanner"),
				threshold,
			});
		} else if (gate === "static-analysis") {
			scan = runStaticAnalysis({
				target,
				outDir,
				opengrep: bin("opengrep"),
				rulesDir: options.rulesDir ?? DEFAULT_RULES_DIR,
			});
		} else if (gate === "image-vulnerabilities") {
			scan = runImageVulnerabilities({
				target,
				outDir,
				trivy: bin("trivy"),
				image: resolve(resolveImage(options.image)),
				threshold,
			});
		} else {
			scan = runImageLint({
				target,
				outDir,
				dockle: bin("dockle"),
				image: resolve(resolveImage(options.image)),
			});
		}
		result.findings = scan.findings.length;
		result.blocking = scan.findings.filter((f) => f.blocking).length;
		result.details = scan.findings.sort(
			(a, b) => Number(b.blocking) - Number(a.blocking),
		);
		if (scan.licences) result.licences = scan.licences;
		if (scan.image) result.image = scan.image;
	} catch (error) {
		result.error = error.message;
	}
	result.passed =
		!result.error && result.blocking === 0 && result.suppressionErrors === 0;
	writeFileSync(
		join(outDir, `${gate}.json`),
		`${JSON.stringify(result, null, "\t")}\n`,
	);
	return result;
}

const USAGE = `usage: run-gate.mjs <${Object.keys(GATES).join("|")}> --out <dir> [options]

options:
  --target <dir>      repository to scan (default: .)
  --bin <dir>         directory holding the scanner binaries (default: PATH)
  --severity <level>  ${Object.keys(SEVERITY_THRESHOLDS).join(", ")} (default: high)
  --image <path>      docker save tarball, or a directory holding one, for
                      the image Gate
  --base <sha> --head <sha>
                      scan only this commit range for secrets
  --rules <dir>       Opengrep rules (default: the bundled ruleset)
  --path-prefix <p>   prefix for annotation paths
  --today YYYY-MM-DD  date used for Suppression expiry`;

async function main() {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			out: { type: "string" },
			target: { type: "string" },
			bin: { type: "string" },
			severity: { type: "string" },
			base: { type: "string" },
			head: { type: "string" },
			rules: { type: "string" },
			image: { type: "string" },
			"path-prefix": { type: "string" },
			today: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help || positionals.length !== 1 || !values.out) {
		console.log(USAGE);
		process.exit(values.help ? 0 : 2);
	}
	const result = runGate(positionals[0], {
		outDir: values.out,
		target: values.target,
		binDir: values.bin,
		severity: values.severity,
		base: values.base,
		head: values.head,
		rulesDir: values.rules,
		image: values.image,
		pathPrefix: values["path-prefix"],
		today: values.today,
	});
	const markdown = gateMarkdown(result);
	console.log(markdown);
	if (process.env.GITHUB_STEP_SUMMARY)
		appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
	if (result.error)
		console.log(`::error::${result.title} Gate could not run: ${result.error}`);
	else if (!result.passed) console.log(`::error::${result.title} Gate failed`);
	process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === import.meta.filename) await main();
