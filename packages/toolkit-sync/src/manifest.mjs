/** Convert one glob pattern (`*`, `**`, literal segments) into an anchored RegExp. */
export function globToRegExp(glob) {
	let pattern = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i];
		if (char === "*" && glob[i + 1] === "*") {
			if (glob[i + 2] === "/") {
				pattern += "(?:.*/)?";
				i += 2;
			} else {
				pattern += ".*";
				i += 1;
			}
		} else if (char === "*") {
			pattern += "[^/]*";
		} else if ("\\^$.|?+()[]{}".includes(char)) {
			pattern += `\\${char}`;
		} else {
			pattern += char;
		}
	}
	return new RegExp(`^${pattern}$`);
}

/** Return the subset of `paths` matched by any glob in `patterns`. */
export function matchManifest(paths, patterns) {
	const regexes = patterns.map(globToRegExp);
	return paths.filter((path) => regexes.some((regex) => regex.test(path)));
}

/** Parse and validate a manifest file's JSON contents: `{ "include": ["glob", ...] }`. */
export function parseManifest(raw) {
	const data = JSON.parse(raw);
	if (!Array.isArray(data.include) || data.include.length === 0) {
		throw new Error(
			'manifest must declare a non-empty "include" array of globs',
		);
	}
	return data;
}
