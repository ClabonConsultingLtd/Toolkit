# toolkit-sync

Keeps a consumer repository's vendored copy of a Toolkit package traceable to the Toolkit release it came from.

## Language

**Baseline**:
The commit, file list and per-file hashes a sync last wrote for a pinned package, used to tell a local edit from an upstream change.
_Avoid_: using "baseline" for accepted security findings (that is a **Suppression** in security-gates) or for a minimum set of checks

**Signed release tag**:
A release tag carrying a signature from a key in the Trust anchor. This is the only kind of tag toolkit-sync accepts by default.
_Avoid_: verified tag, trusted release

**Trust anchor**:
The public keys, vendored with toolkit-sync itself, that decide whose signatures on release tags are trusted.
_Avoid_: keyring, allowed signers (that's the file format, not the concept)

**Legacy tag**:
A release tag from before release tags were signed. It can never be signed, and it's accepted only when the consumer explicitly allows it.
_Avoid_: unsigned release, old tag
