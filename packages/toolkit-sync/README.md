# toolkit-sync

A dependency-free script a consuming repo copies in once to pin, check, and
re-sync a Toolkit package it vendors as a directory copy — instead of
copy-pasting `packages/*` with no record of where it came from.

It runs with plain `node` (Node 24+), no install step, and makes no
assumption about the consuming repo's package manager. Copy
`src/cli.mjs`, `src/git.mjs`, `src/manifest.mjs`, `src/package-sync.mjs`,
and `src/pin-file.mjs` into the consuming repo (or vendor this whole
package) and invoke it as `node cli.mjs <pin|check|sync> ...`.

## The problem this solves

A consuming repo vendors `packages/agent-workflow` (or another package) as
a one-time directory copy. Nothing in the consuming repo records which
Toolkit version that copy came from, so there's no way to tell that it has
since diverged — whether by an upstream Toolkit release or a local edit —
and no way to re-apply an update without redoing the copy by hand.

## Pin file

Recorded at the consuming repo's root, `toolkit-pins.json` holds one entry
per pinned package:

```json
{
	"agent-workflow": {
		"tag": "v0.2.0",
		"sha": "d4e5f6...",
		"dest": "tools/agent-workflow",
		"syncedSha": "a1b2c3...",
		"syncedFiles": ["README.md", "src/cli.mjs"],
		"syncedHashes": { "README.md": "9f86d0...", "src/cli.mjs": "60303a..." }
	}
}
```

- `tag`, `sha`: the pinned tag and the commit it resolved to at pin time.
  `sync`/`check` re-fetch the tag and refuse to proceed if it now points
  somewhere else (the tag moved upstream — re-run `pin` to accept the move).
- `dest` (optional): where the package is vendored, relative to the repo
  root with `/` separators. Set by `pin --dest`; kept by later `pin` calls.
- `syncedSha`, `syncedFiles`, `syncedHashes`: the baseline `sync` last
  wrote — the commit, the files, and each file's SHA-256. `sync` records them;
  do not edit them by hand.

A pin file written by an older `toolkit-sync` without these fields still
works: `dest` falls back to the default, and the first `sync` records a
baseline.

## Package manifests

Each vendorable Toolkit package declares its own vendorable surface at
`packages/<name>/toolkit-manifest.json`, an explicit glob list rather than
an implicit "whole directory minus denylist":

```json
{ "include": ["README.md", "package.json", "src/**"] }
```

Globs are matched against paths relative to the package directory. `*`
matches within one path segment; `**` matches across segments. Test
suites, lockfiles, and language-specific build artifacts are excluded by
simply not listing them.

## Commands

```bash
node cli.mjs pin <package> <tag> [--dest <dir>] [--repo <url>] [--cwd <dir>]
node cli.mjs check [--repo <url>] [--cwd <dir>] [--dest <dir>]
node cli.mjs sync [package] [--force] [--repo <url>] [--cwd <dir>] [--dest <dir>]
node cli.mjs --help
```

`--help`, `-h`, or `help` prints usage and exits 0. No command, or an
unknown one, prints usage and exits 1.

- `--repo` overrides the Toolkit repository URL (default:
  `https://github.com/ClabonConsultingLtd/Toolkit.git`).
- `--cwd` overrides where the pin file and object cache live (default:
  the current directory). The object cache lives at
  `.toolkit/toolkit-sync-cache` and should be gitignored.
- `--dest` is where a package's files are read from / written to. For
  `check`/`sync` it overrides the pin's recorded `dest` (default: the
  recorded `dest`, else `<cwd>/<package-name>`); a relative `--dest` is
  resolved against the current directory. For `pin` it records the
  directory in the pin file, so later commands need no `--dest`; it must be
  inside `--cwd`.

**`pin <package> <tag>`** resolves `<tag>` to a commit SHA on the Toolkit
repo via a local shallow fetch (`git ls-remote` plus `git fetch --depth 1`)
— no GitHub-API dependency — and records `{tag, sha}` (and `dest`, if
given) for `<package>` in `toolkit-pins.json`. It does not touch the
vendored files; run `sync` next.

**`check`** fetches every pinned package's pinned SHA and diffs the local
files against it, scoped to that package's manifested surface. It writes
nothing and exits non-zero if any pinned package has diverged. Each
difference is labelled:

- `missing-local`: not vendored yet; `sync` writes it.
- `upstream-change`: unchanged since the last sync; only upstream changed.
  `sync` overwrites it.
- `removed-upstream`: synced before, no longer manifested, unchanged.
  `sync` deletes it.
- `local-edit`: edited since the last sync. `sync` refuses without `--force`.
- `modified`: differs from the pin, and there is no baseline (a pin file
  from an older version) to say whether it is a local edit or an upstream
  change. `sync` refuses without `--force`.

**`sync [package]`** re-copies the manifested files for the given package
(or every pinned package, if omitted) from its pinned SHA, removes files
no longer manifested, and records the new baseline. It refuses to
overwrite a `local-edit` or `modified` file and lists them — pass `--force`
to overwrite anyway. Missing files and upstream-only changes are written
without `--force`.

With no baseline recorded, `sync` cannot tell a local edit from an
upstream change, so every differing file blocks it. Review the listed files
(compare them with the pinned tag), move any local patch upstream, then
run `sync --force`. From then on the baseline is recorded and only real
local edits stop a sync.

## Recommended upgrade workflow

1. Branch from the consumer repo's up-to-date default branch.
2. `pin <package> <new-tag>` (add `--dest <dir>` once, if not recorded).
3. `check`, and review every `local-edit` / `modified` file before
   deciding whether to upstream it or overwrite it with `--force`.
4. `sync <package>`, then run the vendored package's tests and the
   consumer's own checks.
5. Refresh installed skill copies or symlinks that point at the old
   version, and run any post-sync step the package README names.
6. Commit `toolkit-pins.json` with the synced files and open a pull
   request; merge after CI passes.

The `toolkit-upgrade` skill encodes this procedure for agents:
`claude/skills/toolkit-upgrade` for Claude Code and
`codex/skills/toolkit-upgrade` for Codex. Install the matching directory
from a persistent Toolkit checkout, for example
`ln -s /absolute/Toolkit/packages/toolkit-sync/codex/skills/toolkit-upgrade "${CODEX_HOME:-$HOME/.codex}/skills/toolkit-upgrade"`,
or copy it into the consumer's `.claude/skills/`.

## When vendored code needs a local improvement

Patch it upstream in Toolkit first, get it merged and released (Toolkit
tags each release — see `docs/release.md`), then `sync` the update. Editing
the locally vendored copy directly loses the change on the next `sync`
(unless `sync` is deliberately forced, which overwrites it).

## Non-goals

- No npm/pnpm registry publishing — this is the file-pin mechanism only.
- No per-package versioning — Toolkit packages share one repo-wide tag.
- No automatic merge of local edits and upstream changes — `check`/`sync`
  report and refuse; resolving the conflict is a manual step.
- No GitHub-specific API dependency — plain git only, so this isn't tied
  to GitHub as a host.
