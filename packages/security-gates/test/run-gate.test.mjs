import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	dependencyFindings,
	GATES,
	gateMarkdown,
	hasFix,
	imageLintFindings,
	imageSeverityScore,
	imageVulnerabilityFindings,
	resolveImage,
	SEVERITY_THRESHOLDS,
	secretsFindings,
	severityScore,
	staticFindings,
} from "../scripts/run-gate.mjs";
import { summaryMarkdown } from "../scripts/write-summary.mjs";

function advisory(id, { fixed = true, name = "lodash", severity } = {}) {
	return {
		id,
		affected: [
			{
				package: { name, ecosystem: "npm" },
				ranges: [
					{
						type: "SEMVER",
						events: [
							{ introduced: "0" },
							...(fixed ? [{ fixed: "4.17.21" }] : []),
						],
					},
				],
			},
		],
		...(severity ? { database_specific: { severity } } : {}),
	};
}

function osvReport(groups) {
	return {
		results: [
			{
				source: { path: "/repo/web/package-lock.json", type: "lockfile" },
				packages: [
					{
						package: { name: "lodash", version: "4.17.20", ecosystem: "npm" },
						vulnerabilities: groups.map((g) => g.vuln),
						groups: groups.map((g) => ({
							ids: [g.vuln.id],
							aliases: [],
							max_severity: g.score,
						})),
					},
				],
			},
		],
	};
}

const HIGH = SEVERITY_THRESHOLDS.high;

test("a fixable vulnerability at or above the threshold blocks", () => {
	const [finding] = dependencyFindings(
		osvReport([{ vuln: advisory("GHSA-a"), score: "7.0" }]),
		HIGH,
		"/repo",
	);
	assert.equal(finding.blocking, true);
	assert.match(
		finding.text,
		/lodash@4\.17\.20 \(npm\) GHSA-a: severity 7, fix available in web\/package-lock\.json/,
	);
});

test("an unfixable high vulnerability is reported but doesn't block", () => {
	const [finding] = dependencyFindings(
		osvReport([{ vuln: advisory("GHSA-b", { fixed: false }), score: "9.8" }]),
		HIGH,
	);
	assert.equal(finding.blocking, false);
	assert.match(finding.text, /no fix available/);
});

test("the severity input sets the blocking threshold", () => {
	const report = osvReport([{ vuln: advisory("GHSA-c"), score: "5.3" }]);
	assert.equal(dependencyFindings(report, HIGH)[0].blocking, false);
	assert.equal(
		dependencyFindings(report, SEVERITY_THRESHOLDS.medium)[0].blocking,
		true,
	);
	assert.equal(
		dependencyFindings(report, SEVERITY_THRESHOLDS.critical)[0].blocking,
		false,
	);
});

test("severityScore falls back to the advisory's severity label when there's no CVSS score", () => {
	assert.equal(
		severityScore({ max_severity: "" }, [advisory("x", { severity: "HIGH" })]),
		7.0,
	);
	assert.equal(
		severityScore({ max_severity: "" }, [
			advisory("x", { severity: "MODERATE" }),
		]),
		4.0,
	);
	assert.equal(severityScore({ max_severity: "" }, [advisory("x")]), undefined);
	const [finding] = dependencyFindings(
		osvReport([
			{ vuln: advisory("GHSA-d", { severity: "CRITICAL" }), score: "" },
		]),
		HIGH,
	);
	assert.equal(finding.blocking, true);
});

test("hasFix only counts fixed versions recorded for the same package", () => {
	const pkg = { name: "lodash", ecosystem: "npm" };
	assert.equal(hasFix(pkg, [advisory("x")]), true);
	assert.equal(hasFix(pkg, [advisory("x", { name: "lodash-es" })]), false);
	assert.equal(
		hasFix({ name: "lodash", ecosystem: "PyPI" }, [advisory("x")]),
		false,
	);
});

test("staticFindings blocks on ERROR and reports WARNING and INFO", () => {
	const findings = staticFindings({
		results: [
			{
				check_id: "rules.js-eval-dynamic",
				path: "a.js",
				start: { line: 3 },
				extra: { severity: "ERROR" },
			},
			{
				check_id: "rules.js-dom-html-sink",
				path: "b.js",
				start: { line: 5 },
				extra: { severity: "WARNING" },
			},
			{
				check_id: "rules.py-weak-hash",
				path: "c.py",
				start: { line: 7 },
				extra: { severity: "INFO" },
			},
		],
	});
	assert.deepEqual(
		findings.map((f) => [f.blocking, f.text]),
		[
			[true, "ERROR js-eval-dynamic at a.js:3"],
			[false, "WARNING js-dom-html-sink at b.js:5"],
			[false, "INFO py-weak-hash at c.py:7"],
		],
	);
});

test("secretsFindings blocks on every finding and gives the fingerprint to suppress it", () => {
	const [finding] = secretsFindings([
		{
			ruleId: "generic-api-key",
			locations: [
				{
					physicalLocation: {
						artifactLocation: { uri: "settings.env" },
						region: { startLine: 2 },
					},
				},
			],
			partialFingerprints: { commitSha: "abc123" },
		},
	]);
	assert.equal(finding.blocking, true);
	assert.match(
		finding.text,
		/fingerprint abc123:settings\.env:generic-api-key:2$/,
	);
});

test("gateMarkdown lists blocking findings first and escapes table pipes", () => {
	const markdown = gateMarkdown({
		title: "Static analysis",
		passed: false,
		findings: 2,
		blocking: 1,
		suppressed: 1,
		expiringSoon: 0,
		suppressionErrors: 0,
		details: [
			{ blocking: true, text: "ERROR x at a|b.js:1" },
			{ blocking: false, text: "WARNING y at c.js:2" },
		],
	});
	assert.match(markdown, /### Static analysis Gate: failed/);
	assert.match(markdown, /\| yes \| ERROR x at a\\\|b\.js:1 \|/);
});

test("summaryMarkdown writes one row per Core Gate", () => {
	const dir = mkdtempSync(join(tmpdir(), "security-gates-summary-"));
	const base = {
		findings: 0,
		blocking: 0,
		suppressed: 0,
		expiringSoon: 0,
		suppressionErrors: 0,
		details: [],
	};
	writeFileSync(
		join(dir, "secrets.json"),
		JSON.stringify({ ...base, gate: "secrets", passed: true }),
	);
	writeFileSync(
		join(dir, "dependencies.json"),
		JSON.stringify({
			...base,
			gate: "dependencies",
			passed: false,
			findings: 3,
			blocking: 1,
			suppressed: 2,
			suppressionErrors: 1,
			expiringSoon: 1,
		}),
	);
	const markdown = summaryMarkdown(dir);
	assert.match(
		markdown,
		/\| Gate \| Result \| Findings \| Blocking \| Suppressed \| Expiring soon \|/,
	);
	assert.match(
		markdown,
		/\| Secrets \(gitleaks\) \| passed \| 0 \| 0 \| 0 \| 0 \|/,
	);
	assert.match(
		markdown,
		/\| Dependencies \(osv-scanner\) \| failed \| 3 \| 1 \| 2 \(1 invalid\) \| 1 \|/,
	);
	assert.match(
		markdown,
		/\| Static analysis \(opengrep\) \| no result: the job stopped before the scan finished \|/,
	);
	assert.equal(Object.values(GATES).filter((spec) => !spec.optIn).length, 3);
});

function trivyReport(vulnerabilities) {
	return {
		Results: [
			{
				Target: "image.tar (alpine 3.14.0)",
				Type: "alpine",
				Vulnerabilities: vulnerabilities.map((v) => ({
					PkgName: "apk-tools",
					InstalledVersion: "2.12.5-r1",
					...v,
				})),
			},
		],
	};
}

test("an image vulnerability at or above the threshold with a fix blocks", () => {
	const findings = imageVulnerabilityFindings(
		trivyReport([
			{
				VulnerabilityID: "CVE-2021-36159",
				FixedVersion: "2.12.6-r0",
				Severity: "CRITICAL",
				CVSS: { nvd: { V3Score: 9.1 } },
			},
			{
				VulnerabilityID: "CVE-2000-0002",
				FixedVersion: "",
				Severity: "CRITICAL",
				CVSS: { nvd: { V3Score: 9.8 } },
			},
			{
				VulnerabilityID: "CVE-2000-0003",
				FixedVersion: "2.12.6-r0",
				Severity: "MEDIUM",
				CVSS: { nvd: { V3Score: 5.3 } },
			},
		]),
		HIGH,
	);
	assert.deepEqual(
		findings.map((f) => f.blocking),
		[true, false, false],
	);
	assert.match(
		findings[0].text,
		/apk-tools@2\.12\.5-r1 \(alpine\) CVE-2021-36159: severity 9\.1, fix available in 2\.12\.6-r0/,
	);
	assert.match(findings[1].text, /no fix available/);
});

test("imageSeverityScore takes the highest CVSS score, then falls back to the label", () => {
	assert.equal(
		imageSeverityScore({
			Severity: "LOW",
			CVSS: { nvd: { V3Score: 9.8 }, redhat: { V3Score: 5.5, V40Score: 6.1 } },
		}),
		9.8,
	);
	assert.equal(imageSeverityScore({ Severity: "HIGH" }), 7.0);
	assert.equal(
		imageSeverityScore({ Severity: "UNKNOWN", CVSS: { nvd: {} } }),
		undefined,
	);
	const [unscored] = imageVulnerabilityFindings(
		trivyReport([
			{ VulnerabilityID: "DLA-1", FixedVersion: "1", Severity: "UNKNOWN" },
		]),
		SEVERITY_THRESHOLDS.low,
	);
	assert.equal(unscored.blocking, false);
	assert.match(unscored.text, /severity unknown/);
});

test("imageLintFindings blocks on FATAL, reports WARN and leaves out INFO", () => {
	const findings = imageLintFindings({
		details: [
			{
				code: "CIS-DI-0010",
				title: "Do not store credential in environment variables/files",
				level: "FATAL",
				alerts: ["Suspicious ENV key found : DATABASE_PASSWORD"],
			},
			{
				code: "CIS-DI-0001",
				title: "Create a user for the container",
				level: "WARN",
				alerts: ["Last user should not be root"],
			},
			{ code: "CIS-DI-0006", title: "Add HEALTHCHECK", level: "INFO" },
			{ code: "DKL-LI-0001", title: "Avoid empty password", level: "SKIP" },
		],
	});
	assert.deepEqual(
		findings.map((f) => [f.blocking, f.text.split(" ").slice(0, 2).join(" ")]),
		[
			[true, "FATAL CIS-DI-0010"],
			[false, "WARN CIS-DI-0001"],
		],
	);
});

test("resolveImage takes a tarball, or a directory holding exactly one file", () => {
	const dir = mkdtempSync(join(tmpdir(), "security-gates-image-"));
	assert.throws(() => resolveImage(undefined), /needs --image/);
	assert.throws(() => resolveImage(dir), /holds 0 files/);
	mkdirSync(join(dir, "nested"));
	writeFileSync(join(dir, "nested", "app.tar"), "tar");
	assert.equal(resolveImage(dir), join(dir, "nested", "app.tar"));
	assert.equal(
		resolveImage(join(dir, "nested", "app.tar")),
		join(dir, "nested", "app.tar"),
	);
	writeFileSync(join(dir, "other.tar"), "tar");
	assert.throws(() => resolveImage(dir), /holds 2 files/);
});

test("summaryMarkdown lists the image Gate only when it's on", () => {
	const dir = mkdtempSync(join(tmpdir(), "security-gates-summary-"));
	writeFileSync(
		join(dir, "image-lint.json"),
		JSON.stringify({
			gate: "image-lint",
			passed: false,
			findings: 2,
			blocking: 1,
			suppressed: 0,
			expiringSoon: 0,
			suppressionErrors: 0,
		}),
	);
	const off = summaryMarkdown(dir);
	assert.doesNotMatch(off, /Image/);
	assert.equal(
		off.match(/^\| (Secrets|Dependencies|Static analysis) /gm).length,
		3,
	);
	const on = summaryMarkdown(dir, { image: true });
	assert.match(on, /\| Image \(dockle\) \| failed \| 2 \| 1 \| 0 \| 0 \|/);
	assert.match(on, /\| Image \(trivy\) \| no result/);
});
