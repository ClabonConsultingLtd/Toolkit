import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveProvider } from "../src/ticket-providers.mjs";

test("local-markdown provider reads the Status declaration", () => {
	const root = mkdtempSync(join(tmpdir(), "ticket-provider-"));
	const ticket = join(root, "a.md");
	writeFileSync(ticket, "**Status:** ready\n");
	const provider = resolveProvider({ provider: "local-markdown" });
	const ref = provider.resolveReference("a.md", root);
	assert.equal(ref, ticket);
	assert.equal(provider.getStatus(ref, {}), "ready");
});

test("local-markdown provider honors a custom statusPattern", () => {
	const root = mkdtempSync(join(tmpdir(), "ticket-provider-"));
	const ticket = join(root, "a.md");
	writeFileSync(ticket, "Status: ready-for-agent\n");
	const provider = resolveProvider({ provider: "local-markdown" });
	const ref = provider.resolveReference("a.md", root);
	assert.equal(
		provider.getStatus(ref, { statusPattern: "^Status:\\s*(.+)$" }),
		"ready-for-agent",
	);
});

test("github provider derives status from a status: label", () => {
	const calls = [];
	const provider = resolveProvider(
		{ provider: "github" },
		{
			exec: (args) => {
				calls.push(args);
				return JSON.stringify({
					labels: [{ name: "status:ready" }],
					state: "OPEN",
				});
			},
		},
	);
	const ref = provider.resolveReference("#42");
	assert.equal(ref, "42");
	assert.equal(provider.getStatus(ref, {}), "ready");
	assert.deepEqual(calls[0], ["issue", "view", "42", "--json", "labels,state"]);
});

test("github provider falls back to closedStatus when unlabeled and closed", () => {
	const provider = resolveProvider(
		{ provider: "github" },
		{
			exec: () => JSON.stringify({ labels: [], state: "CLOSED" }),
		},
	);
	assert.equal(provider.getStatus("42", { closedStatus: "done" }), "done");
});

test("github provider throws when no status label and issue is open", () => {
	const provider = resolveProvider(
		{ provider: "github" },
		{
			exec: () => JSON.stringify({ labels: [], state: "OPEN" }),
		},
	);
	assert.throws(() => provider.getStatus("42", {}), /no status: label/);
});

test("unknown provider is rejected", () => {
	assert.throws(
		() => resolveProvider({ provider: "jira" }),
		/unknown ticket provider: jira/,
	);
});
