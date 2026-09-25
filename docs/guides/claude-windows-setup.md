# User guide: Toolkit with Claude Code on Windows

This guide sets up a repository on a fresh Windows machine to use three Toolkit packages with Claude Code:

- **`toolkit-sync`** vendors the other packages at a pinned release and upgrades them later.
- **`claude-token-optimisation`** keeps broad file reads and routine command output out of Claude's context.
- **`agent-workflow`** runs implementation tickets through Claude, one at a time or as an ordered batch.

It then walks through the complete feature workflow using Matt Pocock's skills: `/grill-with-docs` → `/to-spec` → `/to-tickets` → implementation. Both issue trackers are covered: **GitHub issues** and **local Markdown files in `.scratch/`**.

Out of scope: Codex, Paseo (`orchestrate-tickets`, `triage-tickets`, `report-tickets`), the bounded model handoff, and the image packages.

Commands run in **Git Bash** unless a step says **PowerShell**. The guide uses Toolkit `v0.6.0`; substitute the latest [release tag](https://github.com/ClabonConsultingLtd/Toolkit/tags).

## Contents

1. [Install the prerequisites](#1-install-the-prerequisites)
2. [Clone Toolkit](#2-clone-toolkit)
3. [Prepare your repository](#3-prepare-your-repository)
4. [Vendor packages with toolkit-sync](#4-vendor-packages-with-toolkit-sync)
5. [Install token optimisation](#5-install-token-optimisation)
6. [Install Matt Pocock's skills](#6-install-matt-pococks-skills)
7. [Set up the ticket runner](#7-set-up-the-ticket-runner)
8. [Commit the setup](#8-commit-the-setup)
9. [The feature workflow](#9-the-feature-workflow)
10. [Upgrading Toolkit](#10-upgrading-toolkit)
11. [Troubleshooting](#11-troubleshooting)

## 1. Install the prerequisites

| Tool | Needed for | Required? |
| --- | --- | --- |
| Git for Windows (includes Git Bash) | Everything | Yes |
| Node.js 24+ | `toolkit-sync`, hooks, ticket runner, `npx` | Yes |
| Claude Code | Everything Claude does | Yes |
| GitHub CLI (`gh`) | GitHub issue tracker | GitHub track only |
| pnpm 11 | Only for developing Toolkit itself | No |
| Python / uv | Only the image packages | No |

A consuming repository runs every Toolkit command with plain `node`, so it does not need pnpm or Python.

### 1.1 Git for Windows

Git Bash doesn't exist yet, so open **PowerShell** and run:

```powershell
winget install --id Git.Git -e --source winget
```

If you prefer the graphical installer from <https://git-scm.com/download/win>, keep the defaults except:

- **Adjusting your PATH**: "Git from the command line and also from 3rd-party software" (the default). Node needs to find `git.exe`.
- **Line ending conversions**: "Checkout as-is, commit Unix-style line endings". See [Line endings](#line-endings) for why this matters.

Close PowerShell and open **Git Bash** from the Start menu. Configure Git:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
git config --global core.autocrlf input
git config --global core.longpaths true
git config --global init.defaultBranch main
```

`core.autocrlf input` sets the line-ending choice above, in case winget installed with the default "Checkout Windows-style".

### 1.2 Node.js 24 LTS

`winget` is available in Git Bash:

```bash
winget install --id OpenJS.NodeJS.LTS -e --source winget
```

Close and reopen Git Bash so it picks up the new `PATH`, then check:

```bash
node --version   # v24.x or later
npm --version
```

If `node --version` reports lower than 24, install a newer release from <https://nodejs.org>.

### 1.3 GitHub CLI (GitHub track only)

```bash
winget install --id GitHub.cli -e --source winget
```

Reopen Git Bash, then sign in and let `gh` act as Git's credential helper:

```bash
gh auth login        # GitHub.com → HTTPS → authenticate in the browser
gh auth setup-git
gh auth status
```

### 1.4 Claude Code

In **PowerShell**, run the native installer:

```powershell
irm https://claude.ai/install.ps1 | iex
```

It installs `claude.exe` into `%USERPROFILE%\.local\bin`. Back in a new Git Bash window:

```bash
claude --version
```

If Git Bash reports `claude: command not found`, add the install directory to your `PATH`:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

Run `claude` once and complete the browser sign-in, then `/exit`.

Claude Code on Windows uses Git Bash for its own shell commands. If it reports that it can't find Git Bash, set the path explicitly:

```bash
echo 'export CLAUDE_CODE_GIT_BASH_PATH="C:\\Program Files\\Git\\bin\\bash.exe"' >> ~/.bashrc
```

### 1.5 Optional: pnpm

You only need pnpm to run Toolkit's own test suite:

```bash
npm install -g pnpm@11
```

### 1.6 Pick a working folder without spaces

The ticket runner passes the ticket path to its launch command through a shell, so a path containing spaces breaks it. `C:\Users\Jane Doe\...` has a space, so this guide uses `C:\src`, which is `/c/src` in Git Bash:

```bash
mkdir -p /c/src
```

## 2. Clone Toolkit

Keep one persistent Toolkit checkout. It's where you copy `toolkit-sync` and the `toolkit-upgrade` skill from; the vendored packages themselves are fetched by `toolkit-sync`.

```bash
cd /c/src
git clone https://github.com/ClabonConsultingLtd/Toolkit.git
git -C Toolkit switch --detach v0.6.0
```

## 3. Prepare your repository

For a new project:

```bash
cd /c/src
mkdir my-app && cd my-app
git init
```

For an existing project, clone it into `/c/src` and `cd` into it. Either way, do the setup on a branch:

```bash
git switch -c chore/toolkit-setup
```

Ignore Toolkit's runtime state (sync cache, hook logs, batch state):

```bash
echo '.toolkit/' >> .gitignore
```

Tell Git never to convert line endings in vendored files, so collaborators with different Git settings don't see false local edits:

```bash
echo 'tools/** -text' >> .gitattributes
```

All remaining commands run from the repository root.

## 4. Vendor packages with toolkit-sync

### 4.1 Copy toolkit-sync in

`toolkit-sync` has no install step. Copy its five source files from the Toolkit tag:

```bash
mkdir -p tools/toolkit-sync
for f in cli git manifest package-sync pin-file; do
  git -C /c/src/Toolkit show v0.6.0:packages/toolkit-sync/src/$f.mjs > tools/toolkit-sync/$f.mjs
done
node tools/toolkit-sync/cli.mjs --help
```

### 4.2 Pin and sync the packages

Record each package, its release tag, and where it's vendored:

```bash
node tools/toolkit-sync/cli.mjs pin agent-workflow v0.6.0 --dest tools/agent-workflow
node tools/toolkit-sync/cli.mjs pin claude-token-optimisation v0.6.0 --dest tools/claude-token-optimisation
```

This writes `toolkit-pins.json`. Nothing is copied yet. Copy the files:

```bash
node tools/toolkit-sync/cli.mjs sync
node tools/toolkit-sync/cli.mjs check
```

`check` should report both packages as `up to date with v0.6.0`. It exits non-zero if a vendored file differs from the pinned release. Run it in CI if you want to catch accidental edits.

Don't edit files under `tools/` directly: the next `sync` refuses to overwrite them and you have to resolve it by hand. Make changes upstream in Toolkit and sync the release.

### 4.3 Install the toolkit-upgrade skill

This skill teaches Claude the upgrade procedure in [section 10](#10-upgrading-toolkit). Copy it rather than symlinking it, since Windows symlinks need Developer Mode:

```bash
mkdir -p .claude/skills
cp -r /c/src/Toolkit/packages/toolkit-sync/claude/skills/toolkit-upgrade .claude/skills/
```

## 5. Install token optimisation

### 5.1 Run the installer

```bash
node tools/claude-token-optimisation/install.mjs .
```

This creates:

| File | Purpose |
| --- | --- |
| `.claude/CONTEXT-POLICY.md` | Rules for targeted reads and command output |
| `.claude/agents/bulk-reader.md` | Read-only subagent for exploring large files |
| `.claude/hooks/guard-large-read.mjs` | Redirects untargeted large reads and oversized images |
| `.claude/hooks/summarize-bash.mjs`, `command-summary.mjs` | Summarise a small allowlist of successful commands |
| `.claude/settings.toolkit-token-optimisation.json` | Settings fragment for you to merge |

### 5.2 Merge the settings

The installer doesn't edit `.claude/settings.json`; you merge the fragment in yourself. If you have no `.claude/settings.json` yet, create it with the content below. This also includes the permissions the ticket runner needs in [section 7](#7-set-up-the-ticket-runner). Replace `npm test` with your project's real test, lint, and build commands.

```json
{
	"permissions": {
		"allow": [
			"Bash(npm test:*)",
			"Bash(git status)",
			"Bash(git diff:*)",
			"Bash(git log:*)",
			"Bash(git add:*)",
			"Bash(git commit:*)",
			"Bash(gh issue view:*)",
			"Bash(gh issue list:*)",
			"Bash(gh issue edit:*)",
			"Bash(gh issue comment:*)"
		]
	},
	"hooks": {
		"PreToolUse": [
			{
				"matcher": "Read",
				"hooks": [
					{
						"type": "command",
						"command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/guard-large-read.mjs\""
					}
				]
			},
			{
				"matcher": "Bash",
				"hooks": [
					{
						"type": "command",
						"command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/summarize-bash.mjs\""
					}
				]
			}
		]
	}
}
```

If `.claude/settings.json` already exists, add the two `PreToolUse` entries next to any hooks it already has. Then delete the fragment; re-running the installer recreates it:

```bash
rm .claude/settings.toolkit-token-optimisation.json
```

### 5.3 Point CLAUDE.md at the policy

If the repository has no `CLAUDE.md`, start `claude` and run `/init` to generate one. Then add:

```markdown
## Context use

Follow [.claude/CONTEXT-POLICY.md](.claude/CONTEXT-POLICY.md) for targeted reads and command output.
```

### 5.4 Check it works

Start `claude` in the repository and run:

- `/hooks`: both `PreToolUse` hooks are listed.
- `/agents`: `bulk-reader` is listed.
- Ask Claude to "read the whole of" a file longer than 350 lines. The guard should point it at `bulk-reader` or a targeted range.
- Ask Claude to run `git status`. You should get a short summary, and the full output is logged under `.toolkit/claude-token-optimisation/bash-summary-logs/`.

Optional environment variables: `BULK_READER_MIN_LINES` (default 350) and `READ_GUARD_MAX_IMAGE_BYTES` (default 512 KiB, `0` disables the image check). See the [package README](../../packages/claude-token-optimisation/README.md).

## 6. Install Matt Pocock's skills

The ticket runner doesn't write tickets. Matt Pocock's [skills](https://github.com/mattpocock/skills) do, and `agent-workflow` reads the tickets they produce.

### 6.1 Add the skills

```bash
npx skills@latest add mattpocock/skills
```

When prompted:

- Choose **Claude Code** as the agent.
- Choose **project** scope, so the skills are committed with the repository.
- Choose **copy** rather than symlink if asked (Windows symlinks need Developer Mode).
- Select at least `setup-matt-pocock-skills`, `grill-with-docs`, `to-spec`, `to-tickets`, and `triage`. Installing all the engineering skills is fine too; `grill-with-docs` uses the domain-modelling skill if it's installed.

Restart any running `claude` session so it picks up the new skills.

### 6.2 Configure them for this repository

Start `claude` and run:

```text
/setup-matt-pocock-skills
```

It asks three things and writes the answers to `docs/agents/`:

| Question | GitHub track | Local track |
| --- | --- | --- |
| Issue tracker | GitHub (`docs/agents/issue-tracker.md` uses `gh`) | Local Markdown (tickets under `.scratch/`) |
| Triage labels | Accept the defaults: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` | Same defaults. In local tickets they are values of the `**Status:**` line |
| Domain docs | Single-context (`CONTEXT.md` at the root) for most apps; multi-context (`CONTEXT-MAP.md`) for a monorepo | Same |

It also adds an `## Agent skills` section pointing at those files. If it writes that section to `AGENTS.md`, make sure Claude reads it by adding this line to `CLAUDE.md`:

```markdown
@AGENTS.md
```

Read the generated `docs/agents/issue-tracker.md`. It's the contract every skill follows. You can edit it, for example to require a verification section in every ticket.

### 6.3 Create the labels (GitHub track only)

The ticket runner uses a `done` label in addition to the five triage labels. Create any that are missing (`--force` updates labels that already exist):

```bash
gh label create needs-triage    --color d4c5f9 --force
gh label create needs-info      --color fbca04 --force
gh label create ready-for-agent --color 0e8a16 --force
gh label create ready-for-human --color 1d76db --force
gh label create wontfix         --color ffffff --force
gh label create done            --color 5319e7 --force
```

## 7. Set up the ticket runner

`agent-workflow`'s ticket runner checks that a ticket's status is ready, runs a launch command you choose, then re-reads the status. Here the launch command is a small script that runs Claude headless on the ticket.

### 7.1 The launch script

Create `scripts/claude-ticket.mjs`:

```js
// Launched by tools/agent-workflow ticket / ticket-batch with one argument:
// a ticket file path (local Markdown) or an issue number (GitHub).
import { spawnSync } from "node:child_process";

const ticket = process.argv[2];
if (!ticket) {
	console.error("usage: node scripts/claude-ticket.mjs TICKET");
	process.exit(2);
}

const shared = `Follow CLAUDE.md and the docs under docs/agents/. Work on the current git branch; do not switch branches, push, or merge.
Run the project's tests and checks. Commit your work with a message that names the ticket.
If you cannot finish, or a check fails that you cannot fix, leave the status unchanged, explain why in the ticket, and stop.`;

const prompt = /^\d+$/.test(ticket)
	? `Implement GitHub issue #${ticket}. Read it with: gh issue view ${ticket} --comments
${shared}
When every acceptance criterion is met and the checks pass, run:
gh issue edit ${ticket} --remove-label ready-for-agent --add-label done
and comment on the issue with a summary of the change.`
	: `Implement the ticket in this file: ${ticket}
Read the feature's spec.md (in the folder above this ticket's issues/ folder) first.
${shared}
When every acceptance criterion is met and the checks pass, tick its checkboxes and change its status line to exactly:
**Status:** done`;

const result = spawnSync("claude", ["-p", "--permission-mode", "acceptEdits"], {
	input: prompt,
	stdio: ["pipe", "inherit", "inherit"],
	// On Windows, claude may be a .cmd shim that needs a shell to resolve.
	shell: process.platform === "win32",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
```

`claude -p` runs one prompt with no interactive session. With `acceptEdits`, Claude can edit files, but can only run shell commands that are on the `permissions.allow` list from [5.2](#52-merge-the-settings). A command outside that list is refused, so the ticket's status stays unchanged and the batch stops. You can extend the list and run the ticket again. Keep the list narrow. Don't use `--dangerously-skip-permissions` outside a disposable sandbox.

### 7.2 Ticket configuration

Create the configuration for your tracker at the repository root.

**Local track**: `ticket-config.json`:

```json
{
	"provider": "local-markdown",
	"readyStatus": "ready-for-agent",
	"command": "node scripts/claude-ticket.mjs"
}
```

The runner reads the ticket's top-level `**Status:** <value>` line.

**GitHub track**: `ticket-config.github.json`:

```json
{
	"provider": "github",
	"readyStatus": "ready-for-agent",
	"command": "node scripts/claude-ticket.mjs",
	"statusLabels": ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix", "done"],
	"closedStatus": "done"
}
```

The runner reads the issue's labels with `gh`, and a closed issue counts as `done`.

### 7.3 The batch wrapper

On Windows, running `tools/agent-workflow/src/ticket-batch.mjs` directly does nothing and exits 0: its check for being the entry script compares a `file://C:/...` URL with `file:///C:/...` and never matches. Call its exported `runBatch` from `scripts/ticket-batch.mjs` instead. This works on every platform:

```js
import { runBatch } from "../tools/agent-workflow/src/ticket-batch.mjs";

const args = process.argv.slice(2);
const maxIndex = args.indexOf("--max");
const manifestPath = args.find(
	(arg, i) => !arg.startsWith("--") && (maxIndex === -1 || i !== maxIndex + 1),
);
if (!manifestPath) {
	console.error(
		"usage: node scripts/ticket-batch.mjs MANIFEST [--dry-run] [--continue-on-failure] [--max N]",
	);
	process.exit(2);
}
try {
	runBatch({
		manifestPath,
		dryRun: args.includes("--dry-run"),
		continueOnFailure: args.includes("--continue-on-failure"),
		max: maxIndex === -1 ? undefined : Number(args[maxIndex + 1]),
	});
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
```

The single-ticket launcher, `tools/agent-workflow/src/ticket-launch.mjs`, has no such check and runs directly.

## 8. Commit the setup

```bash
git add .gitignore .gitattributes toolkit-pins.json tools .claude CLAUDE.md docs scripts ticket-config*.json
git add AGENTS.md 2>/dev/null   # if setup wrote one
git status                      # review, then:
git commit -m "Set up Toolkit, Claude token optimisation and ticket workflow"
```

With a GitHub remote, push and open a pull request:

```bash
git push -u origin chore/toolkit-setup
gh pr create --fill
```

Merge it, then `git switch main && git pull` before starting feature work.

## 9. The feature workflow

Each feature goes through the same four stages. The first three are conversations with Claude. The fourth can be interactive or unattended.

```
/grill-with-docs  →  /to-spec  →  /to-tickets  →  implement
   (decide)          (write)      (slice)         (build)
```

Start each stage in a fresh `claude` session from the repository root. Stages hand over through files and issues rather than chat history, so a new session keeps the context small.

### 9.1 Grill the idea: `/grill-with-docs`

```text
/grill-with-docs I want users to be able to export their reports as CSV
```

Claude interviews you one question at a time until the design is unambiguous, checking your answers against the code and the domain docs. As terms and decisions are settled, it records them in `CONTEXT.md` (the glossary) and `docs/adr/` (architecture decisions), creating those files if needed. Answer precisely. If you don't know, say so and Claude will investigate or record an open question.

The grilling is done when Claude has no further questions. Review and commit the doc changes.

### 9.2 Write the spec: `/to-spec`

In the same session, or a new one that points at the grilled topic:

```text
/to-spec
```

Claude turns the agreed design into a spec: the problem, the solution, user stories, implementation decisions, testing approach, and what's out of scope.

- **GitHub track**: the spec is published as a GitHub issue. Note its number, for example `#40`.
- **Local track**: the spec is written to `.scratch/<feature-slug>/spec.md`.

Read the spec and ask for changes before moving on. Everything after this is derived from it.

### 9.3 Slice into tickets: `/to-tickets`

```text
/to-tickets #40                            (GitHub)
/to-tickets .scratch/csv-export/spec.md    (local)
```

Claude breaks the spec into thin vertical slices. Each ticket delivers one testable piece end to end, with acceptance criteria and a **Blocked by** list. It shows you the proposed breakdown first, so you can merge, split or reorder tickets before they're created.

**GitHub track.** Each ticket becomes an issue linked to the spec issue (as a sub-issue where GitHub supports it). Blockers are recorded as issue dependencies or a `Blocked by: #n` line.

**Local track.** Each ticket becomes a numbered file:

```
.scratch/csv-export/
├── spec.md
└── issues/
    ├── 01-export-endpoint.md
    ├── 02-csv-serializer.md
    └── 03-download-button.md
```

Each file has a header like this:

```markdown
# 01: Export endpoint

**What to build:** …

**Blocked by:** —

**Status:** ready-for-agent

- [ ] acceptance criterion
- [ ] acceptance criterion
```

### 9.4 Mark tickets ready

The runner only launches tickets whose status is exactly `ready-for-agent`. Review each ticket and decide whether an agent can build it unattended.

- **GitHub**: `gh issue edit 41 --add-label ready-for-agent --remove-label needs-triage`, or run `/triage` and let Claude recommend a label for each issue.
- **Local**: set the line to `**Status:** ready-for-agent`. Use `ready-for-human` for work you'll do yourself and `needs-info` for tickets that aren't clear yet.

Commit the local ticket files so the history records what was agreed.

### 9.5 Implement

Create one branch for the feature. Every ticket commits to it, so each ticket builds on the ones before it:

```bash
git switch main && git pull
git switch -c feature/csv-export
```

#### Option A: interactively

Start `claude` and hand it the ticket:

```text
Implement .scratch/csv-export/issues/01-export-endpoint.md
Implement GitHub issue #41
```

You watch and steer. This is the best option for the first ticket of a feature, or anything that needs judgement.

#### Option B: one ticket, unattended

Preview first. The preview checks the status and prints the command it would run:

```bash
# Local
node tools/agent-workflow/src/ticket-launch.mjs .scratch/csv-export/issues/01-export-endpoint.md --config ticket-config.json --dry-run

# GitHub
node tools/agent-workflow/src/ticket-launch.mjs 41 --config ticket-config.github.json --dry-run
```

Drop `--dry-run` to run Claude on it. The command fails with `ticket status must be ready-for-agent` if the ticket isn't ready.

#### Option C: a batch, unattended

Write a manifest listing the tickets in the order they should be built, with blockers first.

**Local**: `.scratch/csv-export/batch.json`. Paths are relative to the manifest:

```json
{
	"ticketConfig": "../../ticket-config.json",
	"completeStatus": "done",
	"tickets": [
		"issues/01-export-endpoint.md",
		"issues/02-csv-serializer.md",
		"issues/03-download-button.md"
	]
}
```

**GitHub**: `batch.github.json` at the repository root:

```json
{
	"ticketConfig": "ticket-config.github.json",
	"completeStatus": "done",
	"tickets": ["41", "42", "43"]
}
```

Preview, then run:

```bash
node scripts/ticket-batch.mjs .scratch/csv-export/batch.json --dry-run
node scripts/ticket-batch.mjs .scratch/csv-export/batch.json
```

The batch launches one ticket, waits for Claude to exit, and re-reads the ticket's status. It moves on only if the status is now `done`. Otherwise it stops and prints `ticket did not complete`. Tickets already `done` are skipped. Progress is saved to `.toolkit/ticket-batch-state.json` beside the manifest, so after fixing a problem you re-run the same command and it resumes. `--max N` limits how many tickets launch in one run. `--continue-on-failure` carries on past a failed ticket, which is only safe when the remaining tickets don't depend on it.

A Node `DEP0190` deprecation warning about `shell: true` is expected and harmless.

### 9.6 Review and merge

Unattended work still needs a human review before it reaches `main`:

```bash
git log --oneline main..      # one or more commits per ticket
git diff main...              # the whole feature
```

Run your checks, then push and open a pull request. On GitHub, add `Closes #41`, `Closes #42`, … to the PR description so the issues close when it merges:

```bash
git push -u origin feature/csv-export
gh pr create --fill
```

For the local track, the ticket files already say `done` and are part of the diff.

## 10. Upgrading Toolkit

When a new Toolkit release is tagged, update your clone:

```bash
git -C /c/src/Toolkit fetch --tags
git -C /c/src/Toolkit switch --detach v0.7.0
```

Then, in your repository, start `claude` and ask:

```text
Use the toolkit-upgrade skill to upgrade agent-workflow and claude-token-optimisation to v0.7.0
```

The skill branches, re-pins, checks for local edits, syncs, runs your checks, and opens a pull request. To do it by hand:

```bash
git switch -c toolkit/v0.7.0
node tools/toolkit-sync/cli.mjs pin agent-workflow v0.7.0
node tools/toolkit-sync/cli.mjs pin claude-token-optimisation v0.7.0
node tools/toolkit-sync/cli.mjs check    # review any local-edit / modified files first
node tools/toolkit-sync/cli.mjs sync
node tools/claude-token-optimisation/install.mjs .    # refresh the copied hooks and policy
```

After re-running the installer, delete the settings fragment again. Your `.claude/settings.json` is left alone, apart from migrating old-style hook entries. Also refresh the upgrade skill and, if its files changed in the release, `toolkit-sync` itself:

```bash
cp -r /c/src/Toolkit/packages/toolkit-sync/claude/skills/toolkit-upgrade .claude/skills/
for f in cli git manifest package-sync pin-file; do
  git -C /c/src/Toolkit show v0.7.0:packages/toolkit-sync/src/$f.mjs > tools/toolkit-sync/$f.mjs
done
```

Read the release's [CHANGELOG](../../CHANGELOG.md) entry for any other post-upgrade steps.

To update Matt Pocock's skills, run `npx skills@latest add mattpocock/skills` again and review the diff under `.claude/skills/`.

## 11. Troubleshooting

### Line endings

`toolkit-sync` compares file hashes byte for byte. If Git converts vendored files to CRLF on checkout, `check` reports every file as `local-edit` or `modified`. To fix it, confirm `git config core.autocrlf` prints `input` and that `.gitattributes` contains `tools/** -text`. Then, with no uncommitted changes under `tools/`, check the files out again:

```bash
rm -rf tools && git checkout -- tools
node tools/toolkit-sync/cli.mjs check
```

If `check` still reports differences and you haven't edited anything, `node tools/toolkit-sync/cli.mjs sync --force` rewrites the vendored files from the pinned release.

### `ticket-batch` prints nothing and exits 0

You ran `tools/agent-workflow/src/ticket-batch.mjs` directly. On Windows, use `scripts/ticket-batch.mjs` from [7.3](#73-the-batch-wrapper).

### `ticket status must be ready-for-agent`

The ticket's status isn't exactly `ready-for-agent`. For local tickets, check for extra text after the value on the `**Status:**` line: the runner compares the whole value. For GitHub, check the labels with `gh issue view 41 --json labels`.

### `github issue has no label from statusLabels`

The issue has none of the labels listed in `ticket-config.github.json`. Label it, or add the label your repository uses to `statusLabels`.

### `ticket did not complete … (exit 0, status ready-for-agent)`

Claude finished without marking the ticket `done`. The usual causes are a shell command outside `permissions.allow`, failing checks, or an unclear ticket. Read Claude's output above the message and the explanation it left in the ticket, fix the cause, and re-run the batch.

### `claude` not found when the runner launches it

The runner starts `node scripts/claude-ticket.mjs` through `cmd.exe`, not Git Bash, so `claude` has to be on the Windows `PATH` as well as Git Bash's. Add `%USERPROFILE%\.local\bin` under Windows Settings → "Edit environment variables for your account" → `Path`, then open a new terminal.

### Paths with spaces

The runner joins the launch command and the ticket path into a single shell command. Keep repositories under a path without spaces, such as `C:\src`.

### Hooks don't run

Check `/hooks` in Claude Code. Each command must be exactly `node "$CLAUDE_PROJECT_DIR/.claude/hooks/<name>.mjs"`, and `node --version` must work in Git Bash. The hooks fail open: if one breaks, Claude carries on without it rather than stopping.
