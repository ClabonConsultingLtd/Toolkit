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
	"agent-workflow": { "tag": "v0.1.0", "sha": "a1b2c3..." }
}
```

`sha` is the commit the tag resolved to at pin time; `sync`/`check` re-fetch
the tag and refuse to proceed if it now points somewhere else (the tag
moved upstream — re-run `pin` to accept the move).

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
node cli.mjs pin <package> <tag> [--repo <url>] [--cwd <dir>]
node cli.mjs check [--repo <url>] [--cwd <dir>] [--dest <dir>]
node cli.mjs sync [package] [--force] [--repo <url>] [--cwd <dir>] [--dest <dir>]
```

- `--repo` overrides the Toolkit repository URL (default:
  `https://github.com/ClabonConsultingLtd/Toolkit.git`).
- `--cwd` overrides where the pin file and object cache live (default:
  the current directory). The object cache lives at
  `.toolkit/toolkit-sync-cache` and should be gitignored.
- `--dest` overrides where a package's files are read from / written to
  (default: `<cwd>/<package-name>`).

**`pin <package> <tag>`** resolves `<tag>` to a commit SHA on the Toolkit
repo via a local shallow fetch (`git ls-remote` plus `git fetch --depth 1`)
— no GitHub-API dependency — and records `{tag, sha}` for `<package>` in
`toolkit-pins.json`.

**`check`** fetches every pinned package's pinned SHA and diffs the local
files against it, scoped to that package's manifested surface. It writes
nothing and exits non-zero if any pinned package has diverged.

**`sync [package]`** re-copies the manifested files for the given package
(or every pinned package, if omitted) from its pinned SHA. If a manifested
file's local content differs from the pinned tree, `sync` refuses to
overwrite it and reports the divergence — pass `--force` to overwrite
anyway. Files that simply haven't been synced yet (no local copy) are
written normally; `--force` is only needed to overwrite a genuine local
edit.

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
