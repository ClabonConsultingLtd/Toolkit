# Setup wizard

Automates most of the [Claude Code on Windows guide](../../docs/guides/claude-windows-setup.md): it sets up a repository to use `toolkit-sync`, `claude-token-optimisation` and the `agent-workflow` ticket runner with Claude Code. It works on any platform; the prerequisite script is Windows-only.

Nothing here is vendored into a consuming repository. The wizard runs from a Toolkit clone and writes ordinary files into the target repository for you to review and commit.

## 1. Prerequisites (Windows)

On a machine with nothing installed, download and run the prerequisite script from **PowerShell**:

```powershell
irm https://raw.githubusercontent.com/ClabonConsultingLtd/Toolkit/main/packages/setup-wizard/install-prerequisites.ps1 -OutFile install-prerequisites.ps1
powershell -ExecutionPolicy Bypass -File install-prerequisites.ps1 -GitHub -Name "Your Name" -Email "you@example.com"
```

It installs Git for Windows, Node.js LTS, pnpm, Claude Code and, with `-GitHub`, the GitHub CLI, using `winget`. It then sets `core.autocrlf input` and `core.longpaths true`, adds Claude Code to your user `PATH`, and clones Toolkit into `C:\src\Toolkit` (change this with `-ToolkitDir`) at the newest release tag. You can run it again safely: anything already installed is skipped.

The script finishes by checking that every tool is on `PATH`, and names any that aren't. Terminals that were already open keep the old `PATH`, so afterwards open a **new** Git Bash window, run `claude` once to sign in, and for GitHub run `gh auth login` and `gh auth setup-git`.

On other platforms, install Git, Node.js 24+, pnpm and Claude Code yourself, then clone Toolkit and check out a release tag.

## 2. Run the wizard

From the repository you want to set up:

```bash
node /c/src/Toolkit/packages/setup-wizard/setup.mjs
```

It asks which issue tracker you use, whether to create a `chore/toolkit-setup` branch, whether to create the GitHub labels, and whether to install Matt Pocock's skills. Pass options to answer in advance:

| Option | Effect |
| --- | --- |
| `TARGET_REPOSITORY` | Repository to set up (default: the current directory) |
| `--tracker local\|github\|both` | Local `.scratch/` Markdown tickets, GitHub issues, or both |
| `--tag vX.Y.Z` | Toolkit release to install (default: the tag the clone has checked out) |
| `--dest-root DIR` | Where packages are vendored (default: `tools`) |
| `--repo URL` | Toolkit repository `toolkit-sync` fetches from |
| `--yes` | Accept every default without prompting (tracker `local`; skills and labels installed). It doesn't confirm the release key; see `--accept-trust-anchor-change`. |
| `--no-branch` | Stay on the current branch |
| `--labels` / `--no-labels` | Create or skip the GitHub triage labels |
| `--skills` / `--no-skills` | Install or skip Matt Pocock's skills plugin |
| `--accept-trust-anchor-change` | Confirm the release signing key without being asked (needed with `--yes` on a first setup), or accept a key a new release adds. Check the fingerprint first. |

## What it does

1. Checks for Node.js 24+, Git 2.34+ (for signature checks), pnpm, Claude Code and (for GitHub) a signed-in `gh`. If a tool isn't on `PATH`, it says where the tool is normally installed; see [Checking PATH](../../docs/guides/claude-windows-setup.md#checking-path). Runs `git init` if the target isn't a repository, after asking.
2. Adds `.toolkit/*` and `!.toolkit/overlays/` to `.gitignore`, replacing a bare `.toolkit/` line so committed [overlays](../toolkit-sync/README.md#project-specific-rules-for-a-vendored-skill) stay visible. Adds `tools/** -text` to `.gitattributes`.
3. Pins and syncs `toolkit-sync`, `agent-workflow` and `claude-token-optimisation` into `tools/`, then runs `check` with the vendored copy. `toolkit-sync` verifies the release tag's SSH signature at every step. On a first setup the clone's `toolkit-sync` and release key do the pinning. The wizard first prints the key's fingerprint and asks you to confirm it matches [issue #154](https://github.com/ClabonConsultingLtd/Toolkit/issues/154), and it stops before vendoring anything if you don't. With `--yes`, pass `--accept-trust-anchor-change` to confirm it instead. On a re-run, the repository's vendored `toolkit-sync` verifies the new release against the key the repository already trusts. If the release adds a key, the sync stops until you confirm the key with Toolkit's maintainers and re-run with `--accept-trust-anchor-change`. Copies the `toolkit-upgrade` skill into `.claude/skills/`.
4. Installs Matt Pocock's skills as a project-scope Claude Code plugin (`claude plugin install mattpocock-skills --scope project`), which adds an `enabledPlugins` entry to `.claude/settings.json`.
5. Runs the token-optimisation installer and merges its settings fragment into `.claude/settings.json`, along with `permissions.allow` rules for Git, your `test` script and, for GitHub, `gh issue`. It then deletes the fragment.
6. Adds a `## Context use` section to `AGENTS.md`, and warns if a `CLAUDE.md` would stop Claude reading it.
7. Writes `scripts/claude-ticket.mjs` (from [`templates/claude-ticket.mjs`](templates/claude-ticket.mjs)), `ticket-config.json` and/or `ticket-config.github.json`, and adds `implement-ticket`, `implement-issue` and `implement-batch` scripts to `package.json`, creating `package.json` if needed.
8. Optionally creates the six labels the GitHub track uses.

The wizard is safe to run again. It keeps files you've changed and existing `package.json` scripts, and doesn't duplicate hooks, rules, sections or ignore lines. It reports what it kept.

## What it leaves to you

- Adding your lint and build commands to `permissions.allow`, so unattended tickets can run them.
- Running `/mattpocock-skills:setup-matt-pocock-skills` in Claude Code. It edits the `AGENTS.md` the wizard created; choose your issue tracker and keep the default triage labels.
- Reviewing and committing the changes.

The guide's [feature workflow](../../docs/guides/claude-windows-setup.md#9-the-feature-workflow) takes it from there.

## Paseo setup

`paseo-setup.mjs` configures a repository, already set up with `setup.mjs`, to run `orchestrate-tickets` (and optionally `triage-tickets` and `report-tickets`) on [Paseo](https://paseo.sh) schedules with a Claude controller. Run it in the stable checkout the schedules will use:

```bash
node /c/src/Toolkit/packages/setup-wizard/paseo-setup.mjs
```

It enables Paseo's tools for agents; writes `toolkit-intake.json` with a `claude/<model>` controller, and `paseo.json` to install dependencies in new worktrees; links the three skills into `.claude/skills` (junctions on Windows); creates the labels; saves the intake policy; and creates the `ticket-intake`, `triage` and `report-tickets` schedules, paused. On Windows, where `paseo` can't take a multi-line prompt as an argument, it writes the prompts to `.toolkit/paseo-setup/` and prints a request for a Claude agent in Paseo to create the schedules. Re-running it keeps existing files and schedules, and refreshes an out-of-date intake prompt. `--help` lists its options; the [Paseo guide](../../docs/guides/claude-paseo-setup.md) explains each step.
