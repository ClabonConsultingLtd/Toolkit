import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	checkSuppressions,
	evaluate,
	osvSuppressions,
	parseCommentedIgnoreFile,
	TOOLS,
} from "../scripts/check-suppressions.mjs";

const TODAY = "2026-06-01";
const CLI = new URL("../scripts/check-suppressions.mjs", import.meta.url)
	.pathname;

function repoWith(files) {
	const root = mkdtempSync(join(tmpdir(), "security-gates-suppressions-"));
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), text);
	}
	return root;
}

function cli(root, tool) {
	return spawnSync(
		process.execPath,
		[CLI, "--tool", tool, "--root", root, "--today", TODAY],
		{ encoding: "utf8" },
	);
}

test("parseCommentedIgnoreFile reads the reason and expiry above each entry", () => {
	const text = [
		"# Secrets we accept for now",
		"# reason: fake key in a test fixture expires: 2026-12-31",
		"abc:tests/key.env:generic-api-key:3",
		"abc:tests/key.env:generic-api-key:4",
		"",
		"def:src/config.js:aws-access-token:9",
	].join("\n");
	assert.deepEqual(parseCommentedIgnoreFile(text), [
		{
			line: 3,
			entry: "abc:tests/key.env:generic-api-key:3",
			reason: "fake key in a test fixture",
			expires: "2026-12-31",
		},
		{
			line: 4,
			entry: "abc:tests/key.env:generic-api-key:4",
			reason: "fake key in a test fixture",
			expires: "2026-12-31",
		},
		{
			line: 6,
			entry: "def:src/config.js:aws-access-token:9",
			reason: undefined,
			expires: undefined,
		},
	]);
});

test("parseCommentedIgnoreFile accepts the reason and expiry on separate comment lines", () => {
	const [entry] = parseCommentedIgnoreFile(
		"# reason: generated code\n# expires: 2026-07-01\ngenerated/\n",
	);
	assert.equal(entry.reason, "generated code");
	assert.equal(entry.expires, "2026-07-01");
});

test("a comment after an entry starts a new group", () => {
	const entries = parseCommentedIgnoreFile(
		"# reason: first expires: 2026-12-31\nfirst/\n# reason: second\nsecond/\n",
	);
	assert.equal(entries[1].reason, "second");
	assert.equal(entries[1].expires, undefined);
});

test("evaluate fails a Suppression with no reason, no expiry, or a past expiry", () => {
	assert.deepEqual(evaluate({ expires: "2026-12-31" }, TODAY), {
		level: "error",
		message: "has no reason",
	});
	assert.deepEqual(evaluate({ reason: "x" }, TODAY), {
		level: "error",
		message: "has no expiry date",
	});
	assert.deepEqual(evaluate({ reason: "x", expires: "2026-05-31" }, TODAY), {
		level: "error",
		message: "expired on 2026-05-31",
	});
	assert.equal(
		evaluate({ reason: "x", expires: "31/12/2026" }, TODAY).level,
		"error",
	);
	assert.equal(
		evaluate({ reason: "x", expires: "2026-02-30" }, TODAY).level,
		"error",
	);
	assert.deepEqual(evaluate({}, TODAY), {
		level: "error",
		message: "has no reason, has no expiry date",
	});
});

test("evaluate warns within 14 days of expiry, including the expiry day itself", () => {
	assert.deepEqual(evaluate({ reason: "x", expires: "2026-06-01" }, TODAY), {
		level: "warning",
		message: "expires in 0 days (2026-06-01)",
	});
	assert.equal(
		evaluate({ reason: "x", expires: "2026-06-15" }, TODAY).level,
		"warning",
	);
	assert.equal(
		evaluate({ reason: "x", expires: "2026-06-16" }, TODAY).level,
		"ok",
	);
	assert.equal(
		evaluate({ reason: "x", expires: "2026-06-02T00:00:00Z" }, TODAY).level,
		"warning",
	);
});

test("osvSuppressions reads IgnoredVulns, and PackageOverrides that ignore something", () => {
	const text = `
# A comment
[[IgnoredVulns]]
id = "GHSA-aaaa-bbbb-cccc"
ignoreUntil = 2026-09-01T00:00:00Z
reason = "Only reachable from a dev script" # trailing comment

[[IgnoredVulns]]
id = 'CVE-2024-0001'
reason = """
Multi-line reason
"""

[[PackageOverrides]]
name = "left-pad"
ecosystem = "npm"
effectiveUntil = 2026-07-01
reason = "Awaiting the upstream release"
[PackageOverrides.vulnerability]
ignore = true

[[PackageOverrides]]
name = "some-lib"
reason = "Licence is really MIT"
[PackageOverrides.license]
override = ["MIT"]
`;
	assert.deepEqual(osvSuppressions(text), [
		{
			line: 3,
			entry: "GHSA-aaaa-bbbb-cccc",
			reason: "Only reachable from a dev script",
			expires: "2026-09-01T00:00:00Z",
		},
		{
			line: 8,
			entry: "CVE-2024-0001",
			reason: "Multi-line reason",
			expires: undefined,
		},
		{
			line: 14,
			entry: "package left-pad",
			reason: "Awaiting the upstream release",
			expires: "2026-07-01",
		},
	]);
});

test("the checker fails each of: no reason, no expiry, a past expiry", () => {
	for (const [name, comment] of [
		["no reason", "# expires: 2026-12-31"],
		["no expiry", "# reason: test fixture"],
		["past expiry", "# reason: test fixture expires: 2026-01-31"],
	]) {
		const root = repoWith({
			".gitleaksignore": `${comment}\nabc:key.env:generic-api-key:1\n`,
		});
		const result = cli(root, "gitleaks");
		assert.equal(result.status, 1, name);
		assert.match(
			result.stdout,
			/^::error file=\.gitleaksignore,line=2::/m,
			name,
		);
	}
});

test("the checker only warns about a Suppression expiring within 14 days", () => {
	const root = repoWith({
		".semgrepignore":
			"# reason: generated code expires: 2026-06-10\ngenerated/\n",
	});
	const result = cli(root, "opengrep");
	assert.equal(result.status, 0);
	assert.match(
		result.stdout,
		/^::warning file=\.semgrepignore,line=2::opengrep Suppression "generated\/" expires in 9 days/m,
	);
});

test("the checker finds osv-scanner.toml and .semgrepignore files in subdirectories", () => {
	const root = repoWith({
		"osv-scanner.toml":
			'[[IgnoredVulns]]\nid = "GHSA-1"\nignoreUntil = 2026-12-31\nreason = "ok"\n',
		"services/api/osv-scanner.toml":
			'[[IgnoredVulns]]\nid = "GHSA-2"\nreason = "no expiry"\n',
		"node_modules/pkg/osv-scanner.toml": '[[IgnoredVulns]]\nid = "GHSA-3"\n',
		"web/.semgrepignore": "# reason: build output expires: 2026-12-31\ndist/\n",
	});
	const osv = checkSuppressions("osv-scanner", root, TODAY);
	assert.deepEqual(
		osv.suppressions.map((s) => [s.file, s.level]),
		[
			["osv-scanner.toml", "ok"],
			["services/api/osv-scanner.toml", "error"],
		],
	);
	assert.equal(
		checkSuppressions("opengrep", root, TODAY).suppressions[0].file,
		"web/.semgrepignore",
	);
	const result = cli(root, "osv-scanner");
	assert.equal(result.status, 1);
	assert.match(
		result.stdout,
		/file=services\/api\/osv-scanner\.toml,line=1::osv-scanner Suppression "GHSA-2" has no expiry date/,
	);
});

test("the checker reads .trivyignore and .dockleignore at the repository root", () => {
	const root = repoWith({
		".trivyignore":
			"# reason: no fixed base image yet expires: 2026-12-31\nCVE-2021-36159\n\nCVE-2022-0001\n",
		".dockleignore":
			"# reason: runs as root until the migration expires: 2026-06-05\nCIS-DI-0001\n",
		"sub/.trivyignore": "CVE-2022-0002\n",
	});
	assert.deepEqual(
		checkSuppressions("trivy", root, TODAY).suppressions.map((s) => [
			s.file,
			s.entry,
			s.level,
		]),
		[
			[".trivyignore", "CVE-2021-36159", "ok"],
			[".trivyignore", "CVE-2022-0001", "error"],
		],
	);
	const trivy = cli(root, "trivy");
	assert.equal(trivy.status, 1);
	assert.match(
		trivy.stdout,
		/^::error file=\.trivyignore,line=4::trivy Suppression "CVE-2022-0001" has no reason, has no expiry date/m,
	);
	const dockle = cli(root, "dockle");
	assert.equal(dockle.status, 0);
	assert.match(
		dockle.stdout,
		/^::warning file=\.dockleignore,line=2::dockle Suppression "CIS-DI-0001" expires in 4 days/m,
	);
});

test("a repository without ignore files passes", () => {
	const root = repoWith({ "README.md": "hello\n" });
	for (const tool of TOOLS) {
		assert.equal(cli(root, tool).status, 0, tool);
	}
});
