import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { handoffEndpoint, promptFor, requestEdit } from "../src/handoff.mjs";

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
