import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

function inside(root, path) {
	const r = relative(root, path);
	return r !== "" && !r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r);
}
function fileList(text, label) {
	const section = new RegExp(`^${label}:\\s*\\r?\\n((?:\\s*-\\s+.+\\r?\\n?)+)`, "m").exec(
		text,
	)?.[1];
	return [...(section ?? "").matchAll(/^\s*-\s+(.+?)\s*$/gm)].map((x) => x[1]);
}

function normalizeFiles(files, root, label) {
	return new Set(
		files.map((file) => {
			const target = resolve(root, file);
			if (!inside(resolve(root), target))
				throw new Error(`${label} path escapes root: ${file}`);
			return normalize(file).replaceAll("\\", "/");
		}),
	);
}

export function parseTask(text, root) {
	const editableFiles = fileList(text, "Editable");
	const contextFiles = fileList(text, "Context");
	const instruction = /^## Instruction\s*\r?\n([\s\S]+)$/m
		.exec(text)?.[1]
		?.trim();
	if (!editableFiles.length) throw new Error("Task requires an Editable list");
	if (!instruction) throw new Error("Task requires an Instruction section");
	const editable = normalizeFiles(editableFiles, root, "Editable");
	const context = normalizeFiles(contextFiles, root, "Context");
	for (const file of context)
		if (editable.has(file))
			throw new Error(`Path listed as both Editable and Context: ${file}`);
	return { editable, context, instruction };
}

export function validatePath(root, file) {
	const target = resolve(root, file);
	if (
		!inside(resolve(root), target) ||
		!inside(realpathSync(root), realpathSync(target)) ||
		lstatSync(target).isSymbolicLink()
	)
		throw new Error(`Path escapes root or is a symlink: ${file}`);
}
