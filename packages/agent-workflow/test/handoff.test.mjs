import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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
