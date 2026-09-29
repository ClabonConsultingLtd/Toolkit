# toolkit-sync

Keeps a consumer repository's vendored copy of a Toolkit package traceable to the Toolkit release it came from.

## Language

**Baseline**:
The commit, file list and per-file hashes a sync last wrote for a pinned package, used to tell a local edit from an upstream change.
_Avoid_: using "baseline" for accepted security findings (that is a **Suppression** in security-gates) or for a minimum set of checks
