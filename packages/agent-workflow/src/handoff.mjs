import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applyEdits, parseBlocks, prepareEdits } from "./blocks.mjs";
import { parseTask, validateEditable } from "./task-file.mjs";
export async function requestEdit(
	fetcher,
	url,
	key,
	model,
	prompt,
	retries = 1,
	{ reasoningEffort } = {},
) {
	let last;
	for (let n = 0; n <= retries; n++) {
		try {
			const r = await fetcher(url, {
				method: "POST",
				headers: {
					...(key ? { Authorization: `Bearer ${key}` } : {}),
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					messages: [{ role: "user", content: prompt }],
					...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
				}),
			});
			if (!r.ok) throw new Error(`provider returned ${r.status}`);
			const text = (await r.json()).choices?.[0]?.message?.content;
			if (typeof text !== "string")
				throw new Error("provider returned no text");
			return text;
		} catch (error) {
			last = error;
		}
	}
	throw last;
}
export function promptFor(task, root) {
	const files = [...task.editable]
		.map((f) => {
			validateEditable(root, f);
			return `FILE: ${f}\n${readFileSync(resolve(root, f), "utf8")}`;
		})
		.join("\n\n");
	// Name a real editable file: small models copy the example header verbatim.
	const example = [...task.editable][0] ?? "relative/file";
	return `${task.instruction}\n\nReturn only blocks:\n@@ ${example} @@\n<<<<<<< SEARCH\nexact text\n=======\nreplacement\n>>>>>>> REPLACE\n\n${files}`;
}
export function handoffEndpoint(env) {
	const generic =
		env.TOOLKIT_HANDOFF_API_URL !== undefined ||
		env.TOOLKIT_HANDOFF_MODEL !== undefined ||
		env.TOOLKIT_HANDOFF_API_KEY !== undefined;
	const url = generic
		? env.TOOLKIT_HANDOFF_API_URL
		: (env.DEEPSEEK_API_URL ?? "https://api.deepseek.com/chat/completions");
	const model = generic ? env.TOOLKIT_HANDOFF_MODEL : env.DEEPSEEK_MODEL;
	const key = generic ? env.TOOLKIT_HANDOFF_API_KEY : env.DEEPSEEK_API_KEY;
	if (!url) throw new Error("TOOLKIT_HANDOFF_API_URL is required");
	if (!model)
		throw new Error("TOOLKIT_HANDOFF_MODEL or DEEPSEEK_MODEL is required");
	if (!/^https?:\/\//.test(url))
		throw new Error("handoff API URL must use http or https");
	const local = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\//.test(
		url,
	);
	if (!local && !url.startsWith("https://"))
		throw new Error("remote handoff API URL must use https");
	if (!key && !local)
		throw new Error("handoff API key is required for non-local endpoints");
	// Optional OpenAI-style reasoning_effort, e.g. "none" to stop a local
	// thinking model from reasoning at length before it answers.
	const reasoningEffort = env.TOOLKIT_HANDOFF_REASONING_EFFORT || undefined;
	if (reasoningEffort && !/^[a-z]+$/.test(reasoningEffort))
		throw new Error(
			"TOOLKIT_HANDOFF_REASONING_EFFORT must be a single lowercase word",
		);
	return { url, model, key, ...(reasoningEffort ? { reasoningEffort } : {}) };
}
export async function main(
	args = process.argv.slice(2),
	env = process.env,
	fetcher = fetch,
) {
	const [taskDir, ...flags] = args;
	if (!taskDir)
		throw new Error("usage: node handoff.mjs TASK_DIRECTORY [--dry-run]");
	const root = resolve(env.TOOLKIT_ROOT ?? process.cwd()),
		directory = resolve(taskDir),
		task = parseTask(readFileSync(resolve(directory, "task.md"), "utf8"), root),
		prompt = promptFor(task, root);
	writeFileSync(
		resolve(directory, "request.json"),
		JSON.stringify({ editable: [...task.editable], prompt }, null, 2),
	);
	if (flags.includes("--dry-run")) return prompt;
	if (env.TOOLKIT_HANDOFF_ENABLED !== "on")
		throw new Error("TOOLKIT_HANDOFF_ENABLED must be on");
	const endpoint = handoffEndpoint(env);
	const text = await requestEdit(
		fetcher,
		endpoint.url,
		endpoint.key,
		endpoint.model,
		prompt,
		1,
		{ reasoningEffort: endpoint.reasoningEffort },
	);
	writeFileSync(resolve(directory, "response.md"), text);
	for (const file of task.editable) validateEditable(root, file);
	applyEdits(prepareEdits(root, parseBlocks(text, task.editable)));
	return "Applied bounded handoff edits. Review the diff.";
}
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
	main()
		.then(console.log)
		.catch((error) => {
			console.error(error.message);
			process.exitCode = 1;
		});
