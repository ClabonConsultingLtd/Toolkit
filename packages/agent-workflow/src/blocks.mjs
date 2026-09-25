import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
export function parseBlocks(text, editable) {
	const found = [
		...text.matchAll(
			/^@@\s+(.+?)\s+@@\r?\n<<<<<<< SEARCH\r?\n([\s\S]*?)\r?\n=======\r?\n([\s\S]*?)\r?\n>>>>>>> REPLACE$/gm,
		),
	];
	if (!found.length)
		throw new Error("No file-qualified SEARCH/REPLACE blocks returned");
	return found.map((m) => {
		const file = m[1].replaceAll("\\", "/");
		if (!editable.has(file))
			throw new Error(`Response edits undeclared file: ${file}`);
		return { file, search: m[2], replace: m[3] };
	});
}
export function prepareEdits(root, blocks) {
	const next = new Map();
	for (const b of blocks) {
		const path = resolve(root, b.file);
		const before = next.get(b.file) ?? readFileSync(path, "utf8");
		const n = before.indexOf(b.search);
		if (n < 0 || before.indexOf(b.search, n + 1) >= 0)
			throw new Error(`SEARCH text is absent or ambiguous in ${b.file}`);
		// Splice rather than String#replace, which expands $$, $&, $1… in the
		// replacement and would corrupt shell, regex, or template text.
		next.set(
			b.file,
			before.slice(0, n) + b.replace + before.slice(n + b.search.length),
		);
	}
	return [...next].map(([file, content]) => ({
		path: resolve(root, file),
		content,
	}));
}
export function applyEdits(edits) {
	const staged = [];
	const backups = [];
	try {
		for (const edit of edits) {
			const temporary = `${edit.path}.toolkit-new`;
			writeFileSync(temporary, edit.content, "utf8");
			staged.push({ path: edit.path, temporary });
		}
		for (const edit of staged) {
			const backup = `${edit.path}.toolkit-old`;
			renameSync(edit.path, backup);
			backups.push({ path: edit.path, backup });
			renameSync(edit.temporary, edit.path);
		}
	} catch (error) {
		for (const stagedEdit of staged) {
			try {
				unlinkSync(stagedEdit.temporary);
			} catch {}
		}
		for (const backup of backups.reverse()) {
			try {
				unlinkSync(backup.path);
			} catch {}
			try {
				renameSync(backup.backup, backup.path);
			} catch {}
		}
		throw error;
	}
	for (const backup of backups) unlinkSync(backup.backup);
}
