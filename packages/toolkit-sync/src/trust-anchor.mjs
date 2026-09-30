import { spawnSync } from "node:child_process";

/** The package that vendors the Trust anchor, and the anchor's path inside it. */
export const TRUST_ANCHOR_PACKAGE = "toolkit-sync";
export const TRUST_ANCHOR_FILE = "allowed_signers";

/** Split `text` on `separator` characters that aren't inside double quotes. */
function splitOutsideQuotes(text, separator) {
	const parts = [];
	let current = "";
	let quoted = false;
	for (const char of text) {
		if (char === '"') quoted = !quoted;
		if (!quoted && separator.test(char)) {
			if (current) parts.push(current);
			current = "";
		} else current += char;
	}
	if (current) parts.push(current);
	return parts;
}

const isKeyType = (token) => /^(ssh-|ecdsa-|sk-)/.test(token);

/**
 * Parse `allowed_signers` text into entries `{ principal, options, publicKey }`,
 * one per principal, where `publicKey` is `<type> <base64>` without the key's
 * comment. Comments and blank lines are skipped. A line that isn't a signer
 * line becomes an entry with no principal whose `publicKey` is the line, so a
 * change to it is still reported.
 */
export function parseTrustAnchor(text) {
	const entries = [];
	for (const rawLine of (text ?? "").split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const tokens = splitOutsideQuotes(line, /\s/);
		const keyAt = isKeyType(tokens[1] ?? "") ? 1 : 2;
		if (!isKeyType(tokens[keyAt] ?? "") || !tokens[keyAt + 1]) {
			entries.push({ principal: "", options: [], publicKey: tokens.join(" ") });
			continue;
		}
		const options = keyAt === 2 ? splitOutsideQuotes(tokens[1], /,/) : [];
		const publicKey = `${tokens[keyAt]} ${tokens[keyAt + 1]}`;
		const principals = tokens[0].replace(/^"(.*)"$/, "$1");
		for (const principal of splitOutsideQuotes(principals, /,/))
			entries.push({ principal, options, publicKey });
	}
	return entries;
}

const entryKey = ({ principal, options, publicKey }) =>
	JSON.stringify([principal, [...options].sort(), publicKey]);

/**
 * Compare two versions of the Trust anchor as normalised entries, so
 * whitespace, comments, and the order of lines, principals and options don't
 * count. A key under a new principal or with new options is an addition.
 * `oldText` null or undefined means there is no anchor yet: every entry is
 * added. Returns `{ added, removed }`, each a list of entries.
 */
export function diffTrustAnchor(oldText, newText) {
	const before = new Map(
		parseTrustAnchor(oldText).map((e) => [entryKey(e), e]),
	);
	const after = new Map(parseTrustAnchor(newText).map((e) => [entryKey(e), e]));
	return {
		added: [...after].filter(([key]) => !before.has(key)).map(([, e]) => e),
		removed: [...before].filter(([key]) => !after.has(key)).map(([, e]) => e),
	};
}

/** The SHA256 fingerprint `ssh-keygen -lf` gives `publicKey`, or undefined if it isn't a key. */
export function fingerprintKey(publicKey) {
	const result = spawnSync("ssh-keygen", ["-lf", "-"], {
		input: `${publicKey}\n`,
		encoding: "utf8",
	});
	if (result.status !== 0) return undefined;
	return /\b(SHA256:\S+)/.exec(result.stdout)?.[1];
}
