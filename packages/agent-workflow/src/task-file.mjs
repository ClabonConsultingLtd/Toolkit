import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

function inside(root, path) {
	const r = relative(root, path);
	return r !== "" && !r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r);
}
export function parseTask(text, root) {
	const section =
		/^Editable:\s*\r?\n((?:\s*-\s+.+\r?\n?)+)/m.exec(text)?.[1] ?? "";
	const files = [...section.matchAll(/^\s*-\s+(.+?)\s*$/gm)].map((x) => x[1]);
	const instruction = /^## Instruction\s*\r?\n([\s\S]+)$/m
		.exec(text)?.[1]
		?.trim();
	if (!files.length) throw new Error("Task requires an Editable list");
	if (!instruction) throw new Error("Task requires an Instruction section");
	const editable = new Set(
		files.map((file) => {
			const target = resolve(root, file);
			if (!inside(resolve(root), target))
				throw new Error(`Editable path escapes root: ${file}`);
			return normalize(file).replaceAll("\\", "/");
		}),
	);
	return { editable, instruction };
}

export function validateEditable(root, file) {
	const target = resolve(root, file);
	if (
		!inside(resolve(root), target) ||
		!inside(realpathSync(root), realpathSync(target)) ||
		lstatSync(target).isSymbolicLink()
	)
		throw new Error(`Editable path escapes root or is a symlink: ${file}`);
}
