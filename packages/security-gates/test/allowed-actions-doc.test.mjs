import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const REPO_ROOT = new URL("../../../", import.meta.url);
const WORKFLOW_PATH = new URL(
	".github/workflows/security-gates.yml",
	REPO_ROOT,
);
const README_PATH = new URL("../README.md", import.meta.url);
const REUSABLE_WORKFLOW =
	"ClabonConsultingLtd/Toolkit/.github/workflows/security-gates.yml";

function actionsUsedByReusableWorkflow() {
	const text = readFileSync(WORKFLOW_PATH, "utf8");
	const actions = new Set();
	for (const match of text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)@/gm)) {
		actions.add(match[1]);
	}
	return actions;
}

function restrictingActionsSection() {
	const text = readFileSync(README_PATH, "utf8");
	const match = text.match(
		/## Restricting allowed actions\n([\s\S]*?)(?:\n## |\n### |$)/,
	);
	assert.ok(
		match,
		"README.md must have a 'Restricting allowed actions' section",
	);
	return match[1];
}

test("the README lists every action the reusable workflow uses", () => {
	const actions = actionsUsedByReusableWorkflow();
	assert.ok(
		actions.size > 0,
		"expected the workflow to use at least one action",
	);
	const section = restrictingActionsSection();
	assert.match(
		section,
		new RegExp(
			`${REUSABLE_WORKFLOW.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@\\*`,
		),
		"the section must list the reusable workflow with an @* pattern",
	);
	for (const action of actions) {
		assert.ok(
			section.includes(action),
			`the 'Restricting allowed actions' section doesn't list ${action}, which the reusable workflow uses`,
		);
	}
});
