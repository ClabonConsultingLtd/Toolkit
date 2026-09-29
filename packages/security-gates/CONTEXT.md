# security-gates

The security checks Toolkit supplies for consumer repositories to run in CI, aligned with the OWASP DevSecOps Guideline stages.

## Language

**Gate**:
One security check that passes or fails a CI run on its findings, such as the secrets Gate or the dependency Gate.
_Avoid_: scan, check, baseline

**Core Gate**:
A Gate every consumer runs: secrets, dependencies and static analysis.
_Avoid_: required check (that is a branch-protection setting)

**Opt-in Gate**:
A Gate a consumer turns on because it applies to them, such as the image Gate for repositories that build container images.

**Caller workflow**:
The short workflow in a consumer repository that runs the Gates by calling Toolkit's reusable workflow at a pinned commit.
_Avoid_: wrapper, shim

**Starter configuration**:
The vendored defaults a consumer copies in once and then owns, such as the pre-commit template and example ignore files.
_Avoid_: template (on its own), baseline config

**Suppression**:
A consumer's recorded decision to accept one finding, kept in the tool's own ignore file in the consumer repository, with a reason and an expiry date.
_Avoid_: baseline, allowlist entry, exception, waiver
