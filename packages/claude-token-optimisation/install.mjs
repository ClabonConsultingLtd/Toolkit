import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const target = process.argv[2];
if (!target) throw new Error("usage: node install.mjs TARGET_REPOSITORY");
const root = resolve(target),
	source = resolve(import.meta.dirname);
const claude = join(root, ".claude");
mkdirSync(join(claude, "agents"), { recursive: true });
mkdirSync(join(claude, "hooks"), { recursive: true });
cpSync(join(source, "CONTEXT-POLICY.md"), join(claude, "CONTEXT-POLICY.md"));
cpSync(
	join(source, "agents", "bulk-reader.md"),
	join(claude, "agents", "bulk-reader.md"),
);
for (const file of [
	"guard-large-read.mjs",
	"summarize-bash.mjs",
	"command-summary.mjs",
])
	cpSync(join(source, "hooks", file), join(claude, "hooks", file));

// Hooks run through a shell so $CLAUDE_PROJECT_DIR resolves to the directory
// the hooks were copied into above, whatever the checkout location.
const hookCommand = (file) =>
	`node "$CLAUDE_PROJECT_DIR/.claude/hooks/${file}"`;
const execFormHook = /(?:^|[\\/])(guard-large-read|summarize-bash)\.mjs$/;

// Earlier fragments used exec form (`"command": "node", "args": [path]`),
// which cannot expand $CLAUDE_PROJECT_DIR. Replace only those entries.
function migrateExecForm(path) {
	if (!existsSync(path)) return false;
	const text = readFileSync(path, "utf8");
	let settings;
	try {
		settings = JSON.parse(text);
	} catch {
		console.warn(`Skipped ${path}: not valid JSON`);
		return false;
	}
	let changed = false;
	for (const groups of Object.values(settings?.hooks ?? {})) {
		if (!Array.isArray(groups)) continue;
		for (const group of groups) {
			if (!Array.isArray(group?.hooks)) continue;
			group.hooks = group.hooks.map((hook) => {
				const name =
					hook?.command === "node" &&
					Array.isArray(hook.args) &&
					hook.args.length === 1 &&
					execFormHook.exec(String(hook.args[0]))?.[1];
				if (!name) return hook;
				changed = true;
				const { args: _args, ...rest } = hook;
				return { ...rest, command: hookCommand(`${name}.mjs`) };
			});
		}
	}
	if (!changed) return false;
	const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? "\t";
	writeFileSync(path, `${JSON.stringify(settings, null, indent)}\n`);
	console.log(`Replaced exec-form hook entries in ${path}`);
	return true;
}

const settings = join(claude, "settings.toolkit-token-optimisation.json");
if (!existsSync(settings))
	cpSync(join(source, "claude-settings.example.json"), settings);
for (const file of [settings, "settings.json", "settings.local.json"])
	migrateExecForm(resolve(claude, file));
console.log(
	`Installed assets in ${claude}; merge ${settings} into your Claude settings.`,
);
