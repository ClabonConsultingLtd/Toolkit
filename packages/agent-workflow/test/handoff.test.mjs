import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handoffEndpoint, main, promptFor, requestEdit } from "../src/handoff.mjs";

function taskDirectory(root, taskMd) {
	const directory = mkdtempSync(join(root, "task-"));
	writeFileSync(join(directory, "task.md"), taskMd);
	return directory;
}
function fetcherReturning(...contents) {
	let call = 0;
	return async () => ({
		ok: true,
		json: async () => ({
			choices: [{ message: { content: contents[call++] ?? contents.at(-1) } }],
		}),
	});
}

test("provider helper retries then returns content", async () => {
	let calls = 0;
	const text = await requestEdit(
		async () => {
			calls++;
			if (calls === 1) throw new Error("temporary");
			return {
				ok: true,
				json: async () => ({ choices: [{ message: { content: "edit" } }] }),
			};
		},
		"url",
		"key",
		"model",
		"prompt",
	);
	assert.equal(text, "edit");
	assert.equal(calls, 2);
});

test("generic endpoint accepts an unauthenticated local model", async () => {
	const endpoint = handoffEndpoint({
		TOOLKIT_HANDOFF_API_URL: "http://localhost:11434/v1/chat/completions",
		TOOLKIT_HANDOFF_MODEL: "llama3.2",
	});
	let headers;
	await requestEdit(
		async (_, options) => {
			headers = options.headers;
			return {
				ok: true,
				json: async () => ({ choices: [{ message: { content: "edit" } }] }),
			};
		},
		endpoint.url,
		endpoint.key,
		endpoint.model,
		"prompt",
	);
	assert.equal(headers.Authorization, undefined);
	assert.equal(endpoint.model, "llama3.2");
});

test("remote endpoints require a key and legacy DeepSeek settings still work", () => {
	assert.throws(
		() =>
			handoffEndpoint({
				TOOLKIT_HANDOFF_API_URL: "http://example.com/v1/chat/completions",
				TOOLKIT_HANDOFF_MODEL: "model",
				TOOLKIT_HANDOFF_API_KEY: "secret",
			}),
		/https/,
	);
	assert.throws(
		() =>
			handoffEndpoint({
				TOOLKIT_HANDOFF_API_URL: "https://example.com/v1/chat/completions",
				TOOLKIT_HANDOFF_MODEL: "model",
			}),
		/key/,
	);
	assert.throws(
		() =>
			handoffEndpoint({
				TOOLKIT_HANDOFF_API_URL: "https://example.com/v1/chat/completions",
				TOOLKIT_HANDOFF_MODEL: "model",
				DEEPSEEK_API_KEY: "must-not-leak",
			}),
		/key/,
	);
	assert.deepEqual(
		handoffEndpoint({
			DEEPSEEK_API_KEY: "secret",
			DEEPSEEK_MODEL: "deepseek-chat",
		}),
		{
			url: "https://api.deepseek.com/chat/completions",
			model: "deepseek-chat",
			key: "secret",
		},
	);
});

test("handoff refuses symlinked editable files before including their content", () => {
	const root = mkdtempSync(join(tmpdir(), "handoff-root-"));
	const outside = join(
		mkdtempSync(join(tmpdir(), "handoff-outside-")),
		"secret.txt",
	);
	writeFileSync(outside, "private data");
	symlinkSync(outside, join(root, "linked.txt"));
	assert.throws(
		() =>
			promptFor(
				{ editable: new Set(["linked.txt"]), instruction: "edit" },
				root,
			),
		/symlink|escapes/,
	);
});
test("bounded-handoff skills are self-contained when copied into a skills directory", () => {
	const skill = (provider) =>
		readFileSync(
			new URL(
				`../${provider}/skills/bounded-handoff/SKILL.md`,
				import.meta.url,
			),
			"utf8",
		);
	const claude = skill("claude");
	assert.doesNotMatch(claude, /\]\(\.\.?\//);
	assert.match(claude, /Editable:/);
	assert.equal(skill("codex"), claude);
});

test("prompt example names a real editable file, not a placeholder", () => {
	const root = mkdtempSync(join(tmpdir(), "handoff-"));
	writeFileSync(join(root, "a.ts"), "x\n");
	const prompt = promptFor(
		{ instruction: "Do it.", editable: new Set(["a.ts"]) },
		root,
	);
	// Small models copy the example header verbatim, so it must be valid.
	assert.match(prompt, /Return only blocks:\n@@ a\.ts @@\n/);
	assert.doesNotMatch(prompt, /relative\/file/);
});
test("optional reasoning effort is sent only when configured", async () => {
	const bodies = [];
	const fetcher = async (_, options) => {
		bodies.push(JSON.parse(options.body));
		return {
			ok: true,
			json: async () => ({ choices: [{ message: { content: "edit" } }] }),
		};
	};
	const base = {
		TOOLKIT_HANDOFF_API_URL: "http://localhost:11434/v1/chat/completions",
		TOOLKIT_HANDOFF_MODEL: "gemma4",
	};
	const plain = handoffEndpoint(base);
	const none = handoffEndpoint({
		...base,
		TOOLKIT_HANDOFF_REASONING_EFFORT: "none",
	});
	for (const e of [plain, none])
		await requestEdit(fetcher, e.url, e.key, e.model, "p", 1, {
			reasoningEffort: e.reasoningEffort,
		});
	assert.equal("reasoning_effort" in bodies[0], false);
	assert.equal(bodies[1].reasoning_effort, "none");
	assert.throws(
		() =>
			handoffEndpoint({
				...base,
				TOOLKIT_HANDOFF_REASONING_EFFORT: "none; rm -rf",
			}),
		/TOOLKIT_HANDOFF_REASONING_EFFORT/,
	);
});

test("prompt includes read-only context files and the model cannot edit them", async () => {
	const root = mkdtempSync(join(tmpdir(), "handoff-root-"));
	writeFileSync(join(root, "a.ts"), "before\n");
	writeFileSync(join(root, "template.ts"), "template\n");
	const directory = taskDirectory(
		root,
		"Editable:\n- a.ts\n\nContext:\n- template.ts\n\n## Instruction\nFollow the template.",
	);
	const prompt = await main([directory, "--dry-run"], { TOOLKIT_ROOT: root });
	assert.match(prompt, /CONTEXT \(read-only/);
	assert.match(prompt, /FILE: template\.ts\ntemplate/);
	const { parseBlocks } = await import("../src/blocks.mjs");
	assert.throws(
		() =>
			parseBlocks(
				"@@ template.ts @@\n<<<<<<< SEARCH\ntemplate\n=======\nchanged\n>>>>>>> REPLACE",
				new Set(["a.ts"]),
			),
		/undeclared file/,
	);
});

test("retries once with the applier's feedback before giving up", async () => {
	const root = mkdtempSync(join(tmpdir(), "handoff-root-"));
	writeFileSync(join(root, "a.ts"), "before\n");
	const directory = taskDirectory(
		root,
		"Editable:\n- a.ts\n\n## Instruction\nReplace before with after.",
	);
	let calls = 0;
	const fetcher = async () => {
		calls++;
		const content =
			calls === 1
				? "not a block at all"
				: "@@ a.ts @@\n<<<<<<< SEARCH\nbefore\n=======\nafter\n>>>>>>> REPLACE";
		return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
	};
	const result = await main([directory], {
		TOOLKIT_ROOT: root,
		TOOLKIT_HANDOFF_ENABLED: "on",
		TOOLKIT_HANDOFF_API_URL: "http://localhost:1/x",
		TOOLKIT_HANDOFF_MODEL: "m",
	}, fetcher);
	assert.equal(calls, 2);
	assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "after\n");
	assert.match(result, /Applied/);
});

test("a second malformed response still fails after the retry", async () => {
	const root = mkdtempSync(join(tmpdir(), "handoff-root-"));
	writeFileSync(join(root, "a.ts"), "before\n");
	const directory = taskDirectory(
		root,
		"Editable:\n- a.ts\n\n## Instruction\nReplace before with after.",
	);
	const fetcher = fetcherReturning("nope", "still nope");
	await assert.rejects(
		main(
			[directory],
			{
				TOOLKIT_ROOT: root,
				TOOLKIT_HANDOFF_ENABLED: "on",
				TOOLKIT_HANDOFF_API_URL: "http://localhost:1/x",
				TOOLKIT_HANDOFF_MODEL: "m",
			},
			fetcher,
		),
		/No file-qualified SEARCH\/REPLACE blocks/,
	);
});

test("post-apply gates run and their output lands in result.md, not as an apply failure", async () => {
	const root = mkdtempSync(join(tmpdir(), "handoff-root-"));
	writeFileSync(join(root, "a.ts"), "before\n");
	mkdirSync(join(root, "scripts"));
	writeFileSync(
		join(root, "scripts", "gate.mjs"),
		"console.log('checked', ...process.argv.slice(2)); process.exitCode = 1;\n",
	);
	writeFileSync(
		join(root, "toolkit-handoff.json"),
		JSON.stringify({ version: 1, gates: ["scripts/gate.mjs"] }),
	);
	const directory = taskDirectory(
		root,
		"Editable:\n- a.ts\n\n## Instruction\nReplace before with after.",
	);
	const fetcher = fetcherReturning(
		"@@ a.ts @@\n<<<<<<< SEARCH\nbefore\n=======\nafter\n>>>>>>> REPLACE",
	);
	const result = await main(
		[directory],
		{
			TOOLKIT_ROOT: root,
			TOOLKIT_HANDOFF_ENABLED: "on",
			TOOLKIT_HANDOFF_API_URL: "http://localhost:1/x",
			TOOLKIT_HANDOFF_MODEL: "m",
		},
		fetcher,
	);
	assert.match(result, /Applied/);
	const report = readFileSync(join(directory, "result.md"), "utf8");
	assert.match(report, /information, not acceptance/);
	assert.match(report, /checked a\.ts/);
	assert.match(report, /Exit: 1/);
});

test("refuses to run outside its configured hours unless overridden", async () => {
	const root = mkdtempSync(join(tmpdir(), "handoff-root-"));
	writeFileSync(join(root, "a.ts"), "before\n");
	const allDays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
	const today = allDays[new Date().getUTCDay()];
	const otherDay = allDays.find((day) => day !== today);
	writeFileSync(
		join(root, "toolkit-handoff.json"),
		JSON.stringify({
			version: 1,
			allowedHours: { days: [otherDay], start: "00:00", end: "23:59" },
		}),
	);
	const directory = taskDirectory(
		root,
		"Editable:\n- a.ts\n\n## Instruction\nReplace before with after.",
	);
	const env = {
		TOOLKIT_ROOT: root,
		TOOLKIT_HANDOFF_ENABLED: "on",
		TOOLKIT_HANDOFF_API_URL: "http://localhost:1/x",
		TOOLKIT_HANDOFF_MODEL: "m",
	};
	const fetcher = fetcherReturning(
		"@@ a.ts @@\n<<<<<<< SEARCH\nbefore\n=======\nafter\n>>>>>>> REPLACE",
	);
	await assert.rejects(main([directory], env, fetcher), /outside its configured hours/);
	const result = await main(
		[directory],
		{ ...env, TOOLKIT_HANDOFF_ALLOW_OFFHOURS: "on" },
		fetcher,
	);
	assert.match(result, /Applied/);
});
