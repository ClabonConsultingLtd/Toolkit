import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	parseTriageLabels,
	readTriageLabels,
	statusLabels,
} from "../src/triage-labels.mjs";

const TABLE = `# Triage Labels

| Label in mattpocock/skills | Label in our tracker | Meaning |
| --------------------------- | --------------------- | ------- |
| \`needs-triage\`              | \`triage-needed\`        | Maintainer needs to evaluate this issue |
| \`needs-info\`                | \`needs-info\`          | Waiting on reporter |
| \`ready-for-agent\`           | \`agent-ready\`     | Ready for an AFK agent |
| \`ready-for-human\`           | \`human-only\`     | Requires human implementation |
| \`wontfix\`                   | \`wontfix\`          | Will not be actioned |
`;

test("parseTriageLabels maps canonical roles to repo-specific labels", () => {
	const mapping = parseTriageLabels(TABLE);
	assert.deepEqual(mapping, {
		"needs-triage": "triage-needed",
		"needs-info": "needs-info",
		"ready-for-agent": "agent-ready",
		"ready-for-human": "human-only",
		wontfix: "wontfix",
	});
});

test("parseTriageLabels throws when a canonical role is missing", () => {
	const missingWontfix = TABLE.split("\n")
		.filter((line) => !line.includes("`wontfix`"))
		.join("\n");
	assert.throws(
		() => parseTriageLabels(missingWontfix),
		/missing a mapping for: wontfix/,
	);
});

test("statusLabels returns the five mapped labels in canonical order", () => {
	const mapping = parseTriageLabels(TABLE);
	assert.deepEqual(statusLabels(mapping), [
		"triage-needed",
		"needs-info",
		"agent-ready",
		"human-only",
		"wontfix",
	]);
});

test("readTriageLabels reads and parses a file on disk", () => {
	const root = mkdtempSync(join(tmpdir(), "triage-labels-"));
	const path = join(root, "triage-labels.md");
	writeFileSync(path, TABLE);
	assert.deepEqual(readTriageLabels(path)["needs-triage"], "triage-needed");
});

test("parseTriageLabels honors identity mappings (label strings unchanged)", () => {
	const identity = `
| Label in mattpocock/skills | Label in our tracker | Meaning |
| --- | --- | --- |
| \`needs-triage\` | \`needs-triage\` | x |
| \`needs-info\` | \`needs-info\` | x |
| \`ready-for-agent\` | \`ready-for-agent\` | x |
| \`ready-for-human\` | \`ready-for-human\` | x |
| \`wontfix\` | \`wontfix\` | x |
`;
	assert.deepEqual(parseTriageLabels(identity), {
		"needs-triage": "needs-triage",
		"needs-info": "needs-info",
		"ready-for-agent": "ready-for-agent",
		"ready-for-human": "ready-for-human",
		wontfix: "wontfix",
	});
});
