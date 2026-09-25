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
cpSync(
	join(source, "agents", "bulk-reader.md"),
	join(claude, "agents", "bulk-reader.md"),
);
for (const file of ["guard-large-read.mjs", "summarize-bash.mjs", "command-summary.mjs"])
	cpSync(join(source, "hooks", file), join(claude, "hooks", file));
const settings = join(claude, "settings.toolkit-token-optimisation.json");
if (existsSync(settings)) throw new Error(`refusing to overwrite ${settings}`);
const template = readFileSync(
	join(source, "claude-settings.example.json"),
	"utf8",
).replaceAll(
	"YOUR_HOOK_DIRECTORY",
	join(claude, "hooks").replaceAll("\\", "/"),
);
writeFileSync(settings, template);
console.log(
	`Installed assets in ${claude}; merge ${settings} into your Claude settings.`,
);
