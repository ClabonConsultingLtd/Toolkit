# toolkit-sync verifies SSH-signed release tags

toolkit-sync accepts only Signed release tags. The publish workflow signs each release tag with an SSH key held in a protected `release` environment. toolkit-sync checks the signature with `git verify-tag` against a Trust anchor vendored with toolkit-sync itself, and fails closed. A Legacy tag (from before signing began) is accepted only when the consumer explicitly allows it.

We chose this to keep toolkit-sync's non-goal of no GitHub-specific API dependency: plain git only, so it isn't tied to GitHub as a host. Release provenance attestations were the obvious alternative, since releases already carry them, but fetching and checking them depends on GitHub's attestation API and GitHub-issued signing identities. SSH signatures need only git 2.34 or later and `ssh-keygen`, both already present wherever git and OpenSSH are.

## Considered options

- **Verify the release provenance attestation.** GitHub-specific, which breaks the non-goal. Consumers can still check attestations by hand with `gh attestation verify`.
- **gitsign (Sigstore keyless).** No long-lived key, but every consumer would need the `gitsign` binary, which breaks toolkit-sync being dependency-free.
- **GPG.** Needs `gpg` and a keyring on every consumer machine.
- **Verify only when a signature is present.** Anyone holding a stolen bot token could push an unsigned tag and have it accepted.

## Consequences

- The Trust anchor changes only through a verified sync of the toolkit-sync package. A planned rotation ships both keys, with `valid-before` on the old one, in a release signed by the old key.
- A compromised signing key can sign a release that keeps itself trusted. Recovery needs an out-of-band security advisory telling consumers to replace the Trust anchor by hand.
- The signing key lives in CI, so a compromised release workflow can still sign. That residual risk belongs in the threat model.
- Legacy tags end at a fixed version constant, not at anything read from the remote.
