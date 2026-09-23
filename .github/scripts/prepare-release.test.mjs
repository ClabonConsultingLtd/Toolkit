import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Prepare release configures local Git identity before rebasing a candidate", () => {
	const workflow = readFileSync(
		new URL("../workflows/prepare-release.yml", import.meta.url),
		"utf8",
	);
	const identityStep = workflow.indexOf("- name: Configure Git identity");
	const pendingStep = workflow.indexOf("- id: pending");
	const rebase = workflow.indexOf("git rebase origin/main");
	const localName = workflow.indexOf(
		'git config --local user.name "github-actions[bot]"',
	);
	const localEmail = workflow.indexOf(
		'git config --local user.email "41898282+github-actions[bot]@users.noreply.github.com"',
	);

	assert.notEqual(identityStep, -1, "workflow has a dedicated identity step");
	assert.notEqual(pendingStep, -1, "workflow checks for a pending candidate");
	assert.notEqual(rebase, -1, "workflow rebases an existing candidate");
	assert.ok(
		identityStep < pendingStep,
		"identity step precedes pending-candidate operations",
	);
	assert.ok(
		pendingStep < rebase,
		"rebase remains in the pending-candidate step",
	);
	assert.ok(localName > identityStep && localName < pendingStep);
	assert.ok(localEmail > identityStep && localEmail < pendingStep);
});
