# toolkit-sync

A dependency-free script a consuming repo copies in once to pin, check, and
re-sync a Toolkit package it vendors as a directory copy — instead of
copy-pasting `packages/*` with no record of where it came from.

It runs with plain `node` (Node 24+), git 2.34 or later and `ssh-keygen`,
with no install step, and makes no assumption about the consuming repo's
package manager. Vendor this whole package into the consuming repo, keeping
its layout: `src/cli.mjs` reads the Trust anchor from `allowed_signers` one
directory up. Invoke it as `node src/cli.mjs <pin|check|sync> ...`.

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
		"tag": "v0.14.0",
		"sha": "d4e5f6...",
		"signer": "toolkit-release",
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
- `signer` (optional): the Trust anchor principal whose signature verified
  on the tag. `pin` records it; a Legacy tag accepted with
  `--allow-unsigned` has none.
- `dest` (optional): where the package is vendored, relative to the repo
  root with `/` separators. Set by `pin --dest`; kept by later `pin` calls.
- `syncedSha`, `syncedFiles`, `syncedHashes`: the baseline `sync` last
  wrote — the commit, the files, and each file's SHA-256. `sync` records them;
  do not edit them by hand.

A pin file written by an older `toolkit-sync` without these fields still
works: `dest` falls back to the default, the first `sync` records a
baseline, and the next `sync` that writes the package records its `signer`.
`check` and a refused `sync` still verify the tag but don't record it.

## Release tag verification

Toolkit's publish workflow signs every release tag with an SSH key, so each
tag from v0.14.0 on is a Signed release tag. `pin`, `check` and `sync` each
fetch the tag object and check it with `git verify-tag`, using
`gpg.format=ssh` and the Trust anchor as `gpg.ssh.allowedSignersFile`, before
they trust the commit it names. They fail closed: a missing Trust anchor, a
tag with no signature, a signature from a key the Trust anchor doesn't hold,
or a tag object published under another tag's name is an error, and nothing
is pinned or written. This needs git 2.34 or later and `ssh-keygen`.
toolkit-sync talks to no host API, so it isn't tied to GitHub; see
`docs/adr/0002-toolkit-sync-verifies-ssh-signed-release-tags.md` in Toolkit.

The Trust anchor is the `allowed_signers` file in this package, vendored with
it. It trusts the release key under the principal `toolkit-release` for the
`git` namespace. Nothing in toolkit-sync writes it except a verified `sync` of
the `toolkit-sync` package itself, so it only changes through a release
signed by a key it already trusts, and a `sync` that adds a key needs
`--accept-trust-anchor-change` (below). Don't edit it by hand, except to
recover from a key compromise (below).

A copy of toolkit-sync from before v0.14.0 doesn't verify anything, so the
upgrade to the first verifying copy is trusted on first use. Check that
upgrade's tag once by hand with the new `allowed_signers`:

```sh
git -c gpg.format=ssh -c gpg.ssh.allowedSignersFile=allowed_signers verify-tag v0.14.0
```

### Legacy tags and `--allow-unsigned`

Tags from before signing began (below v0.14.0, the fixed
`FIRST_SIGNED_VERSION` in `src/signature.mjs`) are Legacy tags. They can
never be signed, so `pin`, `check` and `sync` refuse them unless the command
gets `--allow-unsigned`, which accepts a Legacy tag with a warning and without
verification. `--allow-unsigned` never applies to a tag at or above
v0.14.0: an unsigned tag there is always an error. A repo pinned to a Legacy
tag needs `--allow-unsigned` on every command until it moves to a Signed
release tag.

### Trust anchor changes and `--accept-trust-anchor-change`

A release's tag is verified against the Trust anchor already vendored, so a
new anchor can't vouch for its own tag. But once synced, a key added upstream
is trusted for every later sync. So when `sync` would write toolkit-sync's
`allowed_signers`, it first compares the vendored copy with the release's.
It compares entries (a principal, its options and a public key), not raw
lines, so whitespace, comments, key comments and the order of lines,
principals and options don't count. It prints every added and removed entry
as principal, SHA256 fingerprint (from `ssh-keygen -lf`) and options:

```text
toolkit-sync: v0.16.0 changes the Trust anchor (allowed_signers), the keys trusted to sign Toolkit releases
  added: toolkit-release SHA256:... namespaces="git"
  removed: toolkit-release SHA256:... namespaces="git",valid-before="20270101"
```

- If any entry is added, including a known key under a new principal or with
  new options, `sync` writes nothing for that package and exits non-zero
  unless it gets `--accept-trust-anchor-change`. `--force` doesn't stand in
  for it. Confirm each added fingerprint through a channel other than the
  release itself before passing the flag.
- If entries are only removed, `sync` prints them and proceeds.
- If the destination has no `allowed_signers` yet, every entry counts as
  added, so the first `sync` of toolkit-sync needs the flag.
- `check` prints the same change without writing anything, and an added
  entry makes it exit non-zero.

### Planned key rotation

A new key enters the Trust anchor through a release signed by the old one.
That release ships an `allowed_signers` with both keys, and gives the old key
a `valid-before` date:

```text
toolkit-release namespaces="git",valid-before="20270101" ssh-ed25519 AAAA...old
toolkit-release namespaces="git" ssh-ed25519 AAAA...new
```

Consumers `sync` the `toolkit-sync` package to that release, which the old
key verifies. The new key is an added entry, so that `sync` needs
`--accept-trust-anchor-change`. Later releases are signed with the new key. Tags the old key
signed before its `valid-before` date still verify, and a signature it makes
after that date doesn't.

### Key compromise

A stolen signing key can sign a release whose Trust anchor keeps trusting it,
so a `sync` can't recover from a compromise. Recovery needs a security
advisory, published outside the release channel, that gives the new public
key. Each consumer then replaces `allowed_signers` by hand, removing the
compromised key entirely (a `valid-before` date isn't enough, because the
signer chooses the tag date), and re-runs `check` against its pins.

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
node src/cli.mjs pin <package> <tag> [--dest <dir>] [--allow-unsigned] [--repo <url>] [--cwd <dir>]
node src/cli.mjs check [--allow-unsigned] [--repo <url>] [--cwd <dir>] [--dest <dir>]
node src/cli.mjs sync [package] [--force] [--accept-trust-anchor-change] [--allow-unsigned] [--repo <url>] [--cwd <dir>] [--dest <dir>]
node src/cli.mjs --help
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
- `--allow-unsigned` accepts a Legacy tag without a signature, with a
  warning. It has no effect on a tag at or above v0.14.0.
- `--accept-trust-anchor-change` lets `sync` write a Trust anchor that adds a
  key; see [Trust anchor changes](#trust-anchor-changes-and---accept-trust-anchor-change).

**`pin <package> <tag>`** resolves `<tag>` to a commit SHA on the Toolkit
repo via a local shallow fetch (`git ls-remote` plus `git fetch --depth 1`)
— no GitHub-API dependency — verifies it is a Signed release tag, and
records `{tag, sha, signer}` (and `dest`, if given) for `<package>` in
`toolkit-pins.json`. It does not touch the
vendored files; run `sync` next.

**`check`** fetches and verifies every pinned package's tag and diffs the
local files against its pinned SHA, scoped to that package's manifested
surface. It writes nothing, not even a missing `signer`, and exits non-zero
if any pinned package has diverged. For toolkit-sync it also lists the Trust
anchor entries a `sync` would add or remove. Each
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

**`sync [package]`** verifies the tag, then re-copies the manifested files
for the given package (or every pinned package, if omitted) from its pinned
SHA, removes files
no longer manifested, and records the new baseline. It refuses to
overwrite a `local-edit` or `modified` file and lists them — pass `--force`
to overwrite anyway. Missing files and upstream-only changes are written
without `--force`. A release that adds a Trust anchor key also needs
`--accept-trust-anchor-change`.

With no baseline recorded, `sync` cannot tell a local edit from an
upstream change, so every differing file blocks it. Review the listed files
(compare them with the pinned tag), move any local patch upstream, then
run `sync --force`. From then on the baseline is recorded and only real
local edits stop a sync.

## Recommended upgrade workflow

1. Branch from the consumer repo's up-to-date default branch.
2. `pin <package> <new-tag>` (add `--dest <dir>` once, if not recorded).
3. `check`, and review every `local-edit` / `modified` file before
   deciding whether to upstream it or overwrite it with `--force`. Review
   any Trust anchor key the release adds before passing
   `--accept-trust-anchor-change`.
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

## Project-specific rules for a vendored skill

A vendored skill file is overwritten on every `sync`, so a consuming repo
can't edit it directly to add its own rules — which artifacts must never be
delegated, where its task directories live, a per-session cap, and similar
project-specific policy. The overlay convention gives every Toolkit skill a
place for that: if `.toolkit/overlays/<skill-name>.md` exists in the project,
the agent reads it first, before following the skill. Its rules add to the
skill's rules and win where the two conflict. `sync` never touches anything
under `.toolkit/`, so an overlay survives every update. A consuming repo's
local copy of a vendored skill then shrinks to just this overlay file plus
whatever project config the skill itself reads (see, for example,
`bounded-handoff`'s `SKILL.md` in `packages/agent-workflow`).

Overlays are meant to be committed, so ignore `.toolkit` with `.toolkit/*`
plus `!.toolkit/overlays/`, not a bare `.toolkit/` entry: a plain directory
ignore also hides everything below it, including the overlays a repo needs
to keep, and a `.gitignore` directory pattern can't be negated for its
children once the directory itself is ignored.

## Non-goals

- No npm/pnpm registry publishing — this is the file-pin mechanism only.
- No per-package versioning — Toolkit packages share one repo-wide tag.
- No automatic merge of local edits and upstream changes — `check`/`sync`
  report and refuse; resolving the conflict is a manual step.
- No GitHub-specific API dependency — plain git only, so this isn't tied
  to GitHub as a host.
