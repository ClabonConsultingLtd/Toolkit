import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// orchestrate-tickets, triage-tickets and report-tickets each ship a whole
// directory (SKILL.md plus references/ and scripts/), not just a single
// SKILL.md like bounded-handoff. Following the same self-contained-copy
// pattern (see the bounded-handoff test in handoff.test.mjs) means the whole
// claude/skills/<name> and codex/skills/<name> trees must stay byte-identical:
// installing either directory only changes which provider runs the
// controller itself, never the instructions or helper behavior.
const skillNames = ["orchestrate-tickets", "triage-tickets", "report-tickets"];

function listFiles(root) {
	const out = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir).sort()) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) walk(full);
			else out.push(full.slice(root.length + 1));
		}
	};
	walk(root);
	return out;
}

for (const name of skillNames) {
	test(`${name}: claude and codex skill trees are byte-identical`, () => {
		const claudeRoot = new URL(`../claude/skills/${name}`, import.meta.url)
			.pathname;
		const codexRoot = new URL(`../codex/skills/${name}`, import.meta.url)
			.pathname;
		const claudeFiles = listFiles(claudeRoot);
		const codexFiles = listFiles(codexRoot);
		assert.deepEqual(
			claudeFiles,
			codexFiles,
			`${name}: claude/ and codex/ must contain the same files`,
		);
		assert.ok(claudeFiles.includes("SKILL.md"));
		for (const relative of claudeFiles) {
			const claudeContent = readFileSync(join(claudeRoot, relative), "utf8");
			const codexContent = readFileSync(join(codexRoot, relative), "utf8");
			assert.equal(
				claudeContent,
				codexContent,
				`${name}/${relative} differs between claude/ and codex/`,
			);
		}
	});

	test(`${name}: SKILL.md does not pin the controller's own runtime to Codex`, () => {
		const skill = readFileSync(
			new URL(`../codex/skills/${name}/SKILL.md`, import.meta.url),
			"utf8",
		);
		assert.doesNotMatch(
			skill,
			/Codex-only/,
			"the controller helper itself must not claim to be Codex-only",
		);
	});
}
