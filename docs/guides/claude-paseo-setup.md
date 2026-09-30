# User guide: Paseo-scheduled tickets with a Claude controller

This guide runs Toolkit's ticket skills on [Paseo](https://paseo.sh) schedules, with Claude Code as the controller. Once it's set up:

- **`orchestrate-tickets`** runs on a schedule. Each run admits open `ready-for-agent` issues up to a limit you set, starts a Claude worker for each in its own Paseo worktree, reviews each worker's pull request, and sends it back for fixes. If you allow it, it also merges PRs that pass every check.
- **`triage-tickets`** (optional) sweeps new and `needs-triage` issues towards `ready-for-agent`, `ready-for-human` or `needs-info`.
- **`report-tickets`** (optional) writes a digest of what finished, what's blocked, and what's waiting for you.

It builds on the [Windows setup guide](claude-windows-setup.md). Finish that first on the **GitHub** track: the scheduled skills work on GitHub issues only. For local `.scratch/` tickets, use `pnpm implement-batch` from that guide instead.

Commands run in **Git Bash**. Paseo also runs on macOS and Linux, where the same steps apply without the Windows notes.

## Contents

1. [What you need](#1-what-you-need)
2. [Install Paseo](#2-install-paseo)
3. [Make a stable checkout](#3-make-a-stable-checkout)
4. [Run the Paseo wizard](#4-run-the-paseo-wizard)
5. [What the wizard sets up](#5-what-the-wizard-sets-up)
6. [Letting the controller merge](#6-letting-the-controller-merge)
7. [Prepare tickets for the controller](#7-prepare-tickets-for-the-controller)
8. [Run and watch the schedules](#8-run-and-watch-the-schedules)
9. [Updating](#9-updating)
10. [Troubleshooting](#10-troubleshooting)

## 1. What you need

- The repository set up with the [Windows guide](claude-windows-setup.md) on the GitHub track: `tools/agent-workflow` vendored, Matt Pocock's skills installed, `/setup-matt-pocock-skills` run.
- A Claude plan that includes Claude Code, signed in on the machine that runs Paseo. Workers run in Claude's `auto` permission mode, and the controller checks that mode is available before starting one.
- `gh` signed in as an account with write access to the repository. The controller labels and comments on issues, marks draft PRs ready and, if you allow it, merges them.
- A CI workflow whose checks the controller can wait for before merging.
- **Optional: Codex.** The controller only needs Codex while Claude is at a usage limit: it then starts new workers on Codex until the limit resets. Without Codex, no new tickets start until then; work already running is unaffected.

## 2. Install Paseo

Download Paseo Desktop from [paseo.sh/download](https://paseo.sh/download) and install it. It includes and starts its own daemon, so there's nothing else to install. See Paseo's [getting started](https://paseo.sh/docs.md) for other platforms.

The wizard and some commands below use the `paseo` command line. Desktop includes it at `C:\Program Files\Paseo\resources\bin\paseo.cmd`. Add `C:\Program Files\Paseo\resources\bin` to your Windows user `PATH` (the same way as for Claude Code in [1.4 of the Windows guide](claude-windows-setup.md#14-claude-code)), then open a new Git Bash window:

```bash
paseo --version
paseo provider diagnostic claude
```

On Windows, **Paseo uses the environment it was started with**, not your `~/.bashrc`. The agents it starts need `git`, `node`, `pnpm`, `gh` and `claude` on the Windows user `PATH`. Check with `cmd //c where claude` (and the same for the other tools), fix anything missing as in [Checking PATH](claude-windows-setup.md#checking-path), and then quit and restart Paseo so it picks up the new `PATH`.

## 3. Make a stable checkout

Schedules run in one checkout of the repository, the **stable checkout**. The controller keeps its state there (under `.toolkit/orchestration/`), and Paseo creates each ticket's worktree from it. Don't use it for your own work: switching its branch or leaving edits in it gets in the controller's way.

Clone a second copy for it, on the branch tickets merge into, in a path without spaces (the generated schedule prompt names helper paths without quotes):

```bash
cd /c/src
git clone https://github.com/<owner>/<repo>.git my-app-paseo
cd my-app-paseo
```

Register it with Paseo as a project, so its workspaces and ticket worktrees show up together in the app:

```bash
paseo project create
```

See Paseo's [workspaces](https://paseo.sh/docs/workspaces.md) page for how projects and workspaces relate.

The vendored packages, `toolkit-intake.json` and `paseo.json` all come from the committed base branch, so commit setup changes from your normal clone and `git pull` here.

## 4. Run the Paseo wizard

From the stable checkout:

```bash
node /c/src/Toolkit/packages/setup-wizard/paseo-setup.mjs
```

It checks `gh`, `paseo` and `claude`, and then asks:

| Question | Default |
| --- | --- |
| Enable Paseo tools for the agents Paseo starts | Yes, needed |
| Claude model and thinking level for the controller | The newest model Paseo lists; `medium` |
| How many tickets may be in progress at once | 2 |
| Which CI checks a PR must pass | The checks on the base branch's latest commit |
| Let the controller approve and merge | No |
| Add `paseo.json` to install dependencies in new worktrees | Yes, from your lockfile |
| Create or update the GitHub labels | Yes |
| Also schedule triage and report runs | No |

Options answer these in advance; `--help` lists them. For example:

```bash
node /c/src/Toolkit/packages/setup-wizard/paseo-setup.mjs --model claude-opus-5-5 --count 2 --required-checks verify --no-merge --triage --yes
```

**On Windows**, `paseo` is a `.cmd` file, which can't receive the multi-line schedule prompt as an argument. So the wizard writes each prompt to `.toolkit/paseo-setup/` and prints a request instead. In Paseo, start a Claude agent in the stable checkout and send it that request; it creates the schedules with Paseo's own tools, registers the intake schedule and pauses them. On macOS and Linux the wizard creates the schedules itself.

New schedules start **paused**. Pass `--activate` to leave them running.

Then commit `toolkit-intake.json`, `paseo.json` and `.gitignore` from your normal clone (or from the stable checkout, then push), and `git pull` in the stable checkout. The wizard is safe to re-run: it keeps existing files and schedules and only refreshes a schedule prompt that's out of date.

## 5. What the wizard sets up

This section is the manual equivalent of each step, and the reference when you change something later.

### 5.1 Paseo tools for agents

The controller starts workers and reads its schedule through Paseo's tools, which Paseo doesn't give to agents by default. In Paseo, open **Settings → your host → Agents** and turn on **Enable Paseo tools**, or run:

```bash
paseo daemon config set daemon.mcp.injectIntoAgents true
```

See Paseo's [MCP reference](https://paseo.sh/docs/mcp.md). Agents that are already running keep the tools they started with.

### 5.2 `toolkit-intake.json`

The intake settings live in `toolkit-intake.json` at the repository root, and are committed. For a Claude controller:

```json
{
	"version": 1,
	"repository": "owner/repo",
	"baseBranch": "main",
	"codexModel": "claude-opus-5-5",
	"count": 2,
	"requiredChecks": ["verify"],
	"cron": "*/30 8-19 * * *",
	"timezone": "UTC",
	"excludeTickets": [],
	"specLabels": [],
	"controllerProvider": "claude/claude-opus-5-5",
	"controllerThinkingOptionId": "medium"
}
```

- `controllerProvider` makes this a Claude controller. Without it the controller is Codex. Use a model ID from `paseo provider models claude`.
- `codexModel` is required, despite its name. It records the controller's model for auditing, so use the same model ID.
- `count` is both the number of tickets admitted per hour and the most that may be in progress at once.
- `requiredChecks` are the check names a PR must pass before it can merge. Without it, the controller falls back to branch protection, which GitHub doesn't offer for private repositories on every plan.
- `cron` and `timezone` set when the controller runs: every 30 minutes, 08:00 to 19:30 UTC, by default.
- `excludeTickets` lists issue numbers never to start. `specLabels` lists labels that mark spec or umbrella issues, which are skipped. Issues with sub-issues are always skipped.

The [agent-workflow README](../../packages/agent-workflow/README.md#repository-intake-settings) documents every field, including `localVerificationCommand` and `cleanupCommand`.

### 5.3 `paseo.json`

Each ticket's worker starts in a new worktree, without your dependencies. Paseo runs `worktree.setup` when it creates one:

```json
{
	"worktree": {
		"setup": "pnpm install --frozen-lockfile"
	}
}
```

Paseo reads `paseo.json` from the committed base branch, so push it before the first run. See Paseo's [worktree docs](https://paseo.sh/docs/worktrees.md) for teardown, scripts and services.

### 5.4 Skill links

The three skills' helper scripts import the rest of `agent-workflow` by relative path, so they have to stay inside `tools/agent-workflow`. Claude finds them through links in `.claude/skills`. On Windows these are directory junctions, which don't need Developer Mode:

```bash
for skill in orchestrate-tickets triage-tickets report-tickets; do
  cmd //c mklink /J ".claude\\skills\\$skill" "tools\\agent-workflow\\claude\\skills\\$skill"
done
```

On macOS and Linux, use `ln -s ../../tools/agent-workflow/claude/skills/$skill .claude/skills/$skill`.

Links are specific to each machine, so the wizard adds them to `.gitignore`. Scheduled runs don't need them, because their prompts name the skill files directly; they're there for starting a skill yourself in Claude.

### 5.5 Labels

The controller uses the five triage labels plus `done`. Create them as in [6.3 of the Windows guide](claude-windows-setup.md#63-create-the-labels-github-track-only). `orchestrate-tickets` uses the canonical label names, so keep the right-hand column of `docs/agents/triage-labels.md` the same as the left.

### 5.6 Intake policy and schedules

The wizard runs the intake helper to save the policy, which is stored under the ignored `.toolkit/orchestration/.intake/`:

```bash
H=tools/agent-workflow/claude/skills/orchestrate-tickets/scripts/intake.mjs
node "$H" configure "$PWD"
```

The intake schedule's prompt is generated, never written by hand:

```bash
node "$H" schedule-prompt "$PWD"
```

The schedule itself is named `ticket-intake:<owner/repo>`, runs in the stable checkout with the cron, timezone, provider and thinking level from `toolkit-intake.json`, and uses Claude's `bypassPermissions` mode. The controller runs unattended, so it can't stop to ask for permission. On macOS or Linux:

```bash
paseo schedule create --name "ticket-intake:owner/repo" --cron "*/30 8-19 * * *" --timezone UTC \
  --provider claude/claude-opus-5-5 --thinking medium --mode bypassPermissions --cwd "$PWD" --json \
  "$(node "$H" schedule-prompt "$PWD")"
```

Register its ID with the helper, so each run can check it's running under the right schedule:

```bash
echo '{"scheduleId":"<id>"}' | node "$H" schedule "$PWD" -
```

The triage and report schedules (`triage:<owner/repo>`, `report-tickets:<owner/repo>`) use the same settings, with prompts that name the skill's `SKILL.md` and the checkout.

**Security.** A controller in `bypassPermissions` can run any command in the stable checkout without asking. Keep that checkout dedicated to it, and keep the machine's credentials limited to what the controller needs. Ticket text is untrusted input: [section 7](#7-prepare-tickets-for-the-controller) explains the approval rules that stop an edited ticket from steering a worker.

## 6. Letting the controller merge

By default the controller stops when a PR is ready and you merge it. To let it approve and merge instead, `toolkit-intake.json` needs:

- `schedulePromptAppend`: the explicit authorization, which is added to the schedule prompt. The wizard writes:

  > The repository owner authorizes this scheduled controller to approve and merge a ticket's pull request, only after merge-ready returns mergeReady: true and every gate in the skill passes. Never use --admin or bypass branch protection.

- `requiredChecks`: the checks that must pass.
- `selfAuthoredMerge: "comment-review"`, if the workers open PRs under the same GitHub account the controller uses. That's the usual case with one `gh` login. GitHub won't let an account approve its own PR, so the controller records its review as a comment instead.

Merging still waits for every required check, an independent review and an unchanged head commit. A branch rule that requires a human reviewer keeps the PR waiting for one. After changing these fields, regenerate the schedule prompt (re-run the wizard, or see [section 9](#9-updating)).

## 7. Prepare tickets for the controller

Use the [feature workflow](claude-windows-setup.md#9-the-feature-workflow) to write tickets as GitHub issues. The controller starts a ticket only when **all** of these hold:

1. **It's open, unassigned and labelled `ready-for-agent`**, with none of `needs-triage`, `needs-info`, `ready-for-human`, `wontfix` or `done`.
2. **It says which Claude model to use**, on a line like this:

   ```markdown
   **Claude:** `Sonnet / medium`
   ```

   The model must match a Claude model in Paseo, by name or ID (`Sonnet`, `Opus` or `Haiku` pick the newest of that family). The effort must be one of that model's thinking levels (`paseo provider models claude`). A ticket without a usable line is skipped. To have `/to-tickets` add the line to every ticket, add a rule to `docs/agents/issue-tracker.md`, for example:

   ```markdown
   ## Implementation recommendation

   Every implementation issue includes a `**Claude:** \`<model> / <effort>\`` line: the least
   expensive Claude model and effort that can safely do the work.
   ```

3. **It has a trusted brief.** Either an owner, member or collaborator opened the issue, or one of them posted a comment headed `## Agent Brief`. `/mattpocock-skills:triage` writes such a brief when you triage an issue from your own account.
4. **`ready-for-agent` was applied last.** Finish editing the issue, the title and the brief first. Editing any of them after the label means the controller refuses the ticket, moves it back to `needs-triage` and says why in a comment. Re-apply the label to approve the new text.
5. **Its blockers are closed.** Blockers come from GitHub's issue dependencies, or a `Blocked by: #12` line.
6. **It isn't a spec.** Issues with sub-issues, or with a label from `specLabels`, are skipped. `/to-tickets` links tickets to the spec as sub-issues, so the spec is skipped automatically.

## 8. Run and watch the schedules

Resume the intake schedule when tickets are ready, in Paseo's **Schedules** view or with:

```bash
paseo schedule resume <id>
```

Each run admits up to `count` new tickets per UTC hour, and never more than `count` in progress. Runs in between check on workers and PRs. Workers appear as agents in the stable checkout's project, each in a worktree on a `tickets/<batch>/<issue>` branch, and open draft PRs that say `Refs #<issue>`. When a PR merges, the controller labels the issue `done` and closes it.

To see the controller's view from the stable checkout:

```bash
node tools/agent-workflow/claude/skills/orchestrate-tickets/scripts/intake.mjs status "$PWD"
```

Pause the schedule in Paseo to stop admitting new tickets. The schedule keeps running when there's nothing to do, so it only needs pausing when you want it to stop.

## 9. Updating

When you upgrade the vendored packages ([section 10 of the Windows guide](claude-windows-setup.md#10-upgrading-toolkit)), merge the upgrade, then in the stable checkout:

```bash
git pull
node /c/src/Toolkit/packages/setup-wizard/paseo-setup.mjs
```

The wizard checks the intake schedule's prompt against a freshly generated one and replaces it if they differ. On Windows it writes the new prompt to `.toolkit/paseo-setup/` and asks you to have a Claude agent in Paseo apply it. To check by hand:

```bash
paseo schedule inspect <id> --json | node "$H" schedule-prompt "$PWD" --check -
```

After changing `toolkit-intake.json`, the next run picks up `count`, `cron` and the checks. A change to `schedulePromptAppend` or the controller settings needs the prompt refreshed as above.

## 10. Troubleshooting

### A ticket is never started

Run `status` (section 8) or ask the controller why. The usual reasons, in the order the controller checks them:

- It's missing `ready-for-agent`, is assigned, or has a conflicting label.
- It has no usable `**Claude:**` line, or names a model or effort Paseo doesn't list.
- `no trusted agent brief`: nobody with write access opened it or posted an `## Agent Brief`.
- `edited after ready-for-agent`: re-apply the label once the text is final.
- A blocker is still open, it has sub-issues, or it's listed in `excludeTickets`.

### The controller can't start workers

Check that Paseo tools are enabled (section 5.1), and that `claude` works from `cmd //c where claude`. Restart Paseo after fixing `PATH`.

### Claude hit a usage limit

The controller records a cooldown shared by every controller on the machine, at `%USERPROFILE%\.local\state\toolkit\agent-workflow\claude-cooldown.json` on Windows (set `TOOLKIT_STATE_DIR` or `XDG_STATE_HOME` to move it). New workers use Codex until the reset if Codex is set up in Paseo; otherwise admission waits. Workers blocked by the limit resume by themselves after the reset.

### A scheduled run can't find a helper script

On Windows, the generated prompt names helper paths with backslashes, and Claude's shell on Windows is Git Bash, which treats an unquoted backslash as an escape. If a run reports a missing `C:srcmy-app...` path, tell the controller (through `schedulePromptAppend`) to quote paths or use forward slashes, and report it to Toolkit.

### The schedule prompt is out of date

Re-run the wizard, or check and replace it as in section 9. Scheduled runs report prompt drift but never change their own prompt.
