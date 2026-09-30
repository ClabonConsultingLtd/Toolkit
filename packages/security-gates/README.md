# security-gates

Security Gates a consumer repository runs in CI. Each Gate passes or fails the run on its findings:

| Gate | Kind | Tool | Fails on |
| --- | --- | --- | --- |
| Secrets | Core Gate | Gitleaks | any unsuppressed finding |
| Dependencies | Core Gate | OSV-Scanner | a vulnerability at or above `severity` that has a fix |
| Static analysis | Core Gate | Opengrep | an `ERROR` finding |
| Image | Opt-in Gate | Trivy and Dockle | as dependencies (Trivy); a `FATAL` finding (Dockle) |

Every repository runs the Core Gates, and no input switches one off. A repository that builds container images can turn on the image Gate. The image Gate is being added in [#133](https://github.com/ClabonConsultingLtd/Toolkit/issues/133); until a release includes it, its inputs don't exist.

The Gates aren't vendored. They live in Toolkit's reusable workflow, [`.github/workflows/security-gates.yml`](https://github.com/ClabonConsultingLtd/Toolkit/blob/main/.github/workflows/security-gates.yml), and your repository calls it from a short **Caller workflow** pinned to a Toolkit commit SHA. Dependabot proposes the bumps. Each run fetches the scanner-install scripts, the Opengrep ruleset and the pinned scanner versions from the commit you pinned, so a fix reaches you as a one-line pin bump. [ADR 0001](https://github.com/ClabonConsultingLtd/Toolkit/blob/main/docs/adr/0001-security-gates-called-not-vendored.md) records why.

What you vendor with [`toolkit-sync`](https://github.com/ClabonConsultingLtd/Toolkit/blob/main/packages/toolkit-sync/README.md) is this README and the **Starter configuration**. You copy the Starter configuration into place once, and from then on it's yours to edit:

| Starter configuration file | Copy to | Purpose |
| --- | --- | --- |
| [`starter/security-gates.yml`](starter/security-gates.yml) | `.github/workflows/security-gates.yml` | The Caller workflow |
| [`starter/dependabot.yml`](starter/dependabot.yml) | merge into `.github/dependabot.yml` | Bumps the Caller workflow's pin |
| [`starter/pre-commit-config.yaml`](starter/pre-commit-config.yaml) | `.pre-commit-config.yaml` (optional) | Gitleaks, plus Ruff `S` in Python repositories, before each commit |
| [`starter/gitleaksignore.example`](starter/gitleaksignore.example) | `.gitleaksignore`, only when needed | Suppressions for the secrets Gate |
| [`starter/semgrepignore.example`](starter/semgrepignore.example) | `.semgrepignore`, only when needed | Suppressions for the static analysis Gate |
| [`starter/osv-scanner.toml.example`](starter/osv-scanner.toml.example) | `osv-scanner.toml` next to a lockfile, only when needed | Suppressions for the dependencies Gate |

The ignore files are vendored as `.example` files on purpose. A vendored `.semgrepignore` or `osv-scanner.toml` would be read by the Gates wherever it sits in your repository.

## Adoption

Adopt the Gates in one pull request. The rule for that pull request: **every existing finding is fixed or suppressed in it, and every Suppression has an expiry.** The Gates have no report-only mode, so the pull request can't merge green until that's done.

The steps assume `toolkit-sync` is vendored at `tools/toolkit-sync` and this package goes to `tools/security-gates`. Adjust the paths to suit.

1. **Sync the package.** Pin a Toolkit release that includes security-gates, then sync it:

   ```bash
   node tools/toolkit-sync/src/cli.mjs pin security-gates vX.Y.Z --dest tools/security-gates
   node tools/toolkit-sync/src/cli.mjs sync security-gates
   ```

   This writes `tools/security-gates/README.md` and `tools/security-gates/starter/`, and records the tag and its commit SHA in `toolkit-pins.json`. Ignore `.toolkit/toolkit-sync-cache` in `.gitignore` if you haven't already.

2. **Add the Caller workflow**, pinned to the same commit:

   ```bash
   sha=$(node -p 'require("./toolkit-pins.json")["security-gates"].sha')
   tag=$(node -p 'require("./toolkit-pins.json")["security-gates"].tag')
   mkdir -p .github/workflows
   sed "s/@TOOLKIT_SHA # TOOLKIT_TAG/@$sha # $tag/" \
     tools/security-gates/starter/security-gates.yml > .github/workflows/security-gates.yml
   ```

   Then edit it: set `runner` for your runners, change `main` if your default branch has another name, and read the comments on `permissions` and `code-scanning`.

3. **Add the Dependabot entry** from `starter/dependabot.yml` to `.github/dependabot.yml`. If you already have a `github-actions` entry for `/`, it covers the Caller workflow and there's nothing to add.

4. **Optionally, add the pre-commit hooks.** Copy `starter/pre-commit-config.yaml` to `.pre-commit-config.yaml`, or merge its hooks into yours, and delete the Ruff block if you have no Python. Nothing enforces pre-commit: it catches secrets before they're committed, and the Gates in CI still decide whether a change can merge.

5. **Find the secrets already in your history.** On a pull request, the secrets Gate scans only the pull request's commits. On `main`, on the weekly schedule and when run by hand, it scans the full history, so a secret committed years ago fails the first run after you merge. Find those first by running Gitleaks locally, at the version in the pinned release's [`scanner-versions.json`](https://github.com/ClabonConsultingLtd/Toolkit/blob/main/packages/security-gates/scanner-versions.json), with the Gate's settings:

   ```bash
   gitleaks git --redact --ignore-gitleaks-allow --gitleaks-ignore-path . --verbose .
   ```

   Each finding's `Fingerprint:` line is the `.gitleaksignore` entry that suppresses it.

6. **Open the pull request.** The Caller workflow runs the Gates on it. Each Gate's job summary lists its findings and marks the blocking ones, and the run keeps SARIF and JSON results as artifacts named `security-gates-<gate>-<arch>-<call>`.

7. **Fix or suppress every finding in the same pull request.** Fix what you can. First rotate any real secret: a Suppression doesn't make a leaked secret safe. Suppress the rest with a reason and an expiry, as [Suppressions](#suppressions) describes. Include the history findings from step 5, even though the pull request run doesn't report them. Push until every Gate passes.

8. **Make the Gates required.** In your branch protection rules or ruleset, require the three Gate jobs. With the Caller workflow's job named `security-gates`, they show as `security-gates / Secrets Gate`, `security-gates / Dependencies Gate` and `security-gates / Static analysis Gate`. Check the exact names in the pull request's checks list. The summary job always passes, so don't use it as the required check.

9. **Merge.** The push to `main` runs the full-history secrets scan. If it fails, suppress or fix what it found, as in step 7.

Only CI can confirm steps 6 to 9: the Gates install their scanners on the runner, and required checks, Dependabot and code scanning are repository settings.

## Restricting allowed actions

Restricting which actions and reusable workflows are allowed to run is recommended hardening for your own repository.

If you do, your allow list needs:

- `ClabonConsultingLtd/Toolkit/.github/workflows/security-gates.yml@*`, the reusable workflow itself.
- Every action it uses. They're all GitHub-owned today, so "Allow actions created by GitHub" covers them: `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `actions/download-artifact` and, for `code-scanning`, `github/codeql-action/upload-sarif`.

GitHub checks your own repository's Actions settings when your Caller workflow calls the reusable workflow, so you also need to allow whatever third-party actions your own workflows use.

## Inputs

The inputs are a public interface. An incompatible change to them is a major Toolkit release.

| Input | Type | Default | What it does |
| --- | --- | --- | --- |
| `runner` | string (JSON) | `'"ubuntu-latest"'` | `runs-on` for every job, parsed with `fromJSON`. A quoted label, such as `'"ubuntu-24.04-arm"'`, or an array of labels, such as `'["self-hosted", "linux", "arm64"]'`. Runners must be linux/amd64 or linux/arm64. |
| `severity` | string | `high` | The lowest severity that fails the dependencies Gate (and Trivy in the image Gate) when a fix is available: `low` (CVSS 0.1 or more), `medium` (4.0), `high` (7.0) or `critical` (9.0). |
| `code-scanning` | boolean | `false` | Uploads each Gate's SARIF to GitHub code scanning. See [Permissions](#permissions). |
| `image-artifact` | string | none | Opt-in image Gate, from the release that adds it. The name of an artifact that an earlier job in your workflow uploaded, holding a `docker save` tarball. The image is scanned without being pushed anywhere. Add that job to the calling job's `needs:`. |
| `image-ref` | string | none | Opt-in image Gate, from the release that adds it. An image reference the runner can pull. |

Setting either image input turns the image Gate on. Setting both is an error. With neither, the image Gate doesn't run.

No input switches off a Core Gate, and there's no report-only mode.

### Permissions

A reusable workflow's jobs get at most what the calling job grants.

- **Core Gates only:** grant `contents: read`, as the Caller workflow does.
- **With `code-scanning: true`:** also grant `security-events: write` and `actions: read`, by uncommenting them in the Caller workflow. The upload job needs both. It declares no permissions of its own so that it inherits them from you, because GitHub checks a nested job's permissions before it evaluates the job's `if:`. If it declared them, every Caller workflow would have to grant them, even with `code-scanning` off. Code scanning must also be available for the repository: it is for public repositories, and private ones need GitHub Code Security.

## How severity works for each Gate

A Gate also fails when any of its Suppressions has no reason, no expiry, an expiry that isn't a `YYYY-MM-DD` date, or an expiry in the past. It fails if its scanner can't run, too.

| Gate | Fails the run | Reported only |
| --- | --- | --- |
| Secrets (Gitleaks) | Any finding that isn't suppressed. Gitleaks findings have no severity. | none |
| Dependencies (OSV-Scanner) | A vulnerability whose CVSS score is at or above `severity` **and** that has a fix: an advisory records a fixed version for the package. With no CVSS score, the advisory's severity label is used (`MODERATE` counts as medium). | Vulnerabilities below `severity`, with no fix, or with no severity at all. The job summary also lists dependency licences. |
| Static analysis (Opengrep) | A finding from a rule with severity `ERROR`. | `WARNING` and `INFO` findings. |
| Image, Trivy (Opt-in Gate) | As the dependencies Gate: at or above `severity`, with a fix available. | Findings without a fix, or below `severity`. |
| Image, Dockle (Opt-in Gate) | A `FATAL` finding. | `WARN` findings. |

Some details:

- **Scope.** The secrets Gate scans the pull request's commits (`base..head`) on pull requests and the full history on every other event. The dependencies Gate reads every lockfile OSV-Scanner supports, anywhere in the repository. The static analysis Gate scans the checked-out tree, minus Opengrep's ignore list (see [the `.semgrepignore` caveat](#the-semgrepignore-caveat)).
- **Opengrep rules.** The static analysis Gate runs Toolkit's hand-written ruleset for JavaScript and TypeScript (Node.js, Express, Next.js, React), Python and Dockerfiles. `ERROR` is kept for patterns that are nearly always a real problem, such as dynamic `eval`, shell commands built by interpolation or disabled TLS verification. If your repository has a `.opengrep/` folder, its rules run too, and the same severity rule applies to them.
- **Inline markers don't work.** The secrets Gate runs Gitleaks with `--ignore-gitleaks-allow`, and the static analysis Gate runs Opengrep with `--disable-nosem`. A `gitleaks:allow` or `nosemgrep` comment has no effect. Every accepted finding needs a Suppression, which has an expiry.
- **Results.** Every run writes a job summary per Gate, listing findings with the blocking ones first, plus a summary table across the Gates. It uploads each Gate's SARIF and JSON results as the artifact `security-gates-<gate>-<arch>-<call>`, where `<call>` is a random ID for that call of the workflow, so a Caller workflow can call it more than once in a run, for example once per image.

## Suppressions

A Suppression is your recorded decision to accept one finding. It lives in the tool's own ignore file in your repository, with a reason and an expiry date. Toolkit never writes one for you.

| Gate | File | Entry | Reason and expiry |
| --- | --- | --- | --- |
| Secrets | `.gitleaksignore` at the repository root only | the finding's fingerprint | comment convention |
| Static analysis | `.semgrepignore` | a path or pattern, in `.gitignore` syntax | comment convention |
| Dependencies | `osv-scanner.toml`, in the same directory as the lockfile it applies to | `[[IgnoredVulns]]`, or a `[[PackageOverrides]]` that ignores something | OSV-Scanner's `reason` and `ignoreUntil` (`effectiveUntil` for a package override) |
| Image (Trivy) | `.trivyignore` at the repository root only | a vulnerability ID, such as `CVE-2021-36159` | comment convention |
| Image (Dockle) | `.dockleignore` at the repository root only | a checkpoint code, such as `CIS-DI-0001` | comment convention |

OSV-Scanner reads `osv-scanner.toml` only from the lockfile's own directory. One at the repository root doesn't cover a lockfile in a subdirectory.

**The comment convention.** In `.gitleaksignore`, `.semgrepignore`, `.trivyignore` and `.dockleignore`, put this comment directly above the entries it covers:

```
# reason: <why this finding is accepted> expires: YYYY-MM-DD
<entry>
<entry>
```

A comment covers the consecutive entries below it, up to a blank line. The [example files](starter/) show each format.

**Expiry.** A Suppression is valid up to and including its expiry date. On each run, every Gate checks its own Suppressions, wherever they are in the repository (outside `.git` and `node_modules`):

- A missing reason, a missing expiry, a date that isn't `YYYY-MM-DD` or a past expiry fails the Gate, with an annotation on the file and line.
- A Suppression that expires within 14 days produces a warning annotation. The Gate still passes.

Because the Caller workflow also runs weekly, an expired Suppression fails the Gate within a week, even in a quiet repository. When it does, fix the finding, or review it and set a new expiry in a pull request.

**Gitleaks fingerprints.** The secrets Gate's job summary gives each finding's fingerprint as `<commit>:<file>:<rule>:<line>`, which suppresses that one occurrence. The shorter `<file>:<rule>:<line>` suppresses the finding at that position in every commit.

**Configuration isn't a Suppression.** Allowlists in `.gitleaks.toml` and Opengrep configuration aren't checked for a reason or an expiry. Use them to scope what a tool looks at, not to accept findings.

### The `.semgrepignore` caveat

Without a `.semgrepignore`, Opengrep skips a default list of paths, such as `test/`, `tests/`, `vendor/`, `build/`, `dist/` and `node_modules/`. **A `.semgrepignore` replaces that list.** Once you add one, the static analysis Gate scans those paths unless you list them yourself, and every entry is a Suppression that needs a reason and an expiry, including the defaults you copy back in.

So add a `.semgrepignore` only when you need to suppress a path. When you do, expect new findings from paths that were skipped before, and fix or suppress them in the same pull request.

## Keeping up to date

Dependabot opens a pull request once a new Toolkit release is a week old (the snippet's cooldown), bumping the Caller workflow's SHA and version comment together. The Gates run on that pull request with the new scanners and rules, so any new findings show up before you merge.

The Starter configuration is copied once and is yours, so a new release doesn't change it. To refresh this README and the example files, pin and sync the new tag with `toolkit-sync`, then compare the examples with your copies.

## Mapping to the OWASP DevSecOps Guideline

The Gates cover these stages of the [OWASP DevSecOps Guideline](https://owasp.org/www-project-devsecops-guideline/):

| Stage | Covered by |
| --- | --- |
| [1a Secrets management](https://owasp.org/www-project-devsecops-guideline/latest/01a-Secrets-Management) | The secrets Gate (Gitleaks), plus the Gitleaks hook in the pre-commit Starter configuration |
| [2a Static application security testing](https://owasp.org/www-project-devsecops-guideline/latest/02a-Static-Application-Security-Testing) | The static analysis Gate (Opengrep) |
| [2d Software composition analysis](https://owasp.org/www-project-devsecops-guideline/latest/02d-Software-Composition-Analysis) | The dependencies Gate (OSV-Scanner), with a licence summary |
| [2f Container vulnerability scanning](https://owasp.org/www-project-devsecops-guideline/latest/02f-Container-Vulnerability-Scanning) | The image Gate (Trivy and Dockle), an Opt-in Gate |

They deliberately don't cover these stages:

| Stage | Why not, and where to look |
| --- | --- |
| [0 Threat modelling](https://owasp.org/www-project-devsecops-guideline/latest/00b-Threat-modeling) | A design activity, not a CI Gate. Do it per system, for example with STRIDE. |
| [1b Linting code](https://owasp.org/www-project-devsecops-guideline/latest/01b-Linting-Code) | Linting belongs to each repository's own tooling. The pre-commit Starter configuration adds Ruff's `S` rules for Python, but nothing enforces them. |
| [2b Dynamic application security testing](https://owasp.org/www-project-devsecops-guideline/latest/02b-Dynamic-Application-Security-Testing) | Needs a running application. A ZAP scan against an ephemeral stack is proposed for v2 in [#131](https://github.com/ClabonConsultingLtd/Toolkit/issues/131). |
| [2c Interactive application security testing](https://owasp.org/www-project-devsecops-guideline/latest/02c-Interactive-Application-Security-Testing) | Needs an agent instrumenting the running application. Not planned. |
| [2e Infrastructure vulnerability scanning](https://owasp.org/www-project-devsecops-guideline/latest/02e-Infrastructure-Vulnerability-Scanning) | An infrastructure-as-code Gate (Checkov or Conftest) is proposed for v2 in [#131](https://github.com/ClabonConsultingLtd/Toolkit/issues/131). Scanning deployed hosts is out of scope for a repository's CI. |
| [2g Privacy](https://owasp.org/www-project-devsecops-guideline/latest/02g-Privacy) | A review of what personal data a system handles, not a CI Gate. |
| [3 Compliance auditing](https://owasp.org/www-project-devsecops-guideline/latest/03-Compliance-Auditing) | An organisational process. The job summaries and SARIF artifacts can serve as evidence for it. |

Image SBOMs and signing, which extend stage 2f, are also proposed for v2 in [#131](https://github.com/ClabonConsultingLtd/Toolkit/issues/131).
