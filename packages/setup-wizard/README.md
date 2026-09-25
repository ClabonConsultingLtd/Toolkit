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

It asks which issue tracker you use, whether to create a `chore/toolkit-setup` branch, whether to create the GitHub labels, and whether to run Matt Pocock's skills installer. Pass options to answer in advance:

| Option | Effect |
| --- | --- |
| `TARGET_REPOSITORY` | Repository to set up (default: the current directory) |
| `--tracker local\|github\|both` | Local `.scratch/` Markdown tickets, GitHub issues, or both |
| `--tag vX.Y.Z` | Toolkit release to install (default: the tag the clone has checked out) |
| `--dest-root DIR` | Where packages are vendored (default: `tools`) |
| `--repo URL` | Toolkit repository `toolkit-sync` fetches from |
| `--yes` | Accept every default without prompting (tracker `local`, skip the skills installer) |
| `--no-branch` | Stay on the current branch |
| `--labels` / `--no-labels` | Create or skip the GitHub triage labels |
| `--skills` / `--no-skills` | Run or skip `npx skills@latest add mattpocock/skills` |

## What it does

1. Checks for Node.js 24+, Git, pnpm, Claude Code and (for GitHub) a signed-in `gh`. If a tool isn't on `PATH`, it says where the tool is normally installed; see [Checking PATH](../../docs/guides/claude-windows-setup.md#checking-path). Runs `git init` if the target isn't a repository, after asking.
2. Adds `.toolkit/` to `.gitignore` and `tools/** -text` to `.gitattributes`.
3. Copies `toolkit-sync` into `tools/toolkit-sync/`, pins and syncs `agent-workflow` and `claude-token-optimisation` into `tools/`, runs `check`, and copies the `toolkit-upgrade` skill into `.claude/skills/`.
4. Runs the token-optimisation installer and merges its settings fragment into `.claude/settings.json`, along with `permissions.allow` rules for Git, your `test` script and, for GitHub, `gh issue`. It then deletes the fragment.
5. Adds a `## Context use` section to `AGENTS.md`, and warns if a `CLAUDE.md` would stop Claude reading it.
6. Writes `scripts/claude-ticket.mjs` (from [`templates/claude-ticket.mjs`](templates/claude-ticket.mjs)), `ticket-config.json` and/or `ticket-config.github.json`, and adds `implement-ticket`, `implement-issue` and `implement-batch` scripts to `package.json`, creating `package.json` if needed.
7. Optionally creates the six labels the GitHub track uses, and runs Matt Pocock's skills installer.

The wizard is safe to run again. It keeps files you've changed and existing `package.json` scripts, and doesn't duplicate hooks, rules, sections or ignore lines. It reports what it kept.

## What it leaves to you

- Adding your lint and build commands to `permissions.allow`, so unattended tickets can run them.
- Running `/setup-matt-pocock-skills` in Claude Code and choosing **AGENTS.md** and your issue tracker.
- Reviewing and committing the changes.

The guide's [feature workflow](../../docs/guides/claude-windows-setup.md#9-the-feature-workflow) takes it from there.
