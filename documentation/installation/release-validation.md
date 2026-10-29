---
nav_title: Release validation
nav_group: installation
nav_group_title: Installation
nav_group_order: 10
nav_order: 18
---
# Release validation

GitHub runs **Validate release** for pull requests into `dev` or `master`, pushes
to those two branches, and manual workflow runs. Pull-request updates validate
feature commits without running a second identical branch-push workflow. It uses public
Ubuntu runners with read-only repository access. It needs no provider keys, user
credentials, production data or connection to an installed memory stack.

The workflow checks:

- Exact npm and hashed Python lockfiles, plus security audits of all four npm
  installation trees, including development and documentation dependencies.
- Clean locked installation, production builds, type checks, root tests and the
  separate onboarding suite on Node 24.
- The supported Node 22 host and storage paths.
- Documentation generation, navigation, diagram freshness, release-history
  mirrors and version/upgrade compatibility contracts.

The **Release checks** result succeeds only when every job succeeds. A failed,
cancelled or skipped required job cannot produce a successful combined result.
Actions are pinned to reviewed commit IDs and checkout does not persist a write
credential. The workflow neither publishes releases nor deploys services.

## Prepare a release

1. Update dependencies deliberately and commit their complete lockfiles. Run
   `npm run verify:dependencies` and `npm run audit:dependencies`. Every reported
   npm vulnerability fails, including low-severity and development-only findings.
   Registry failures or incomplete responses also fail; they cannot count as a
   clean audit. Do not suppress findings or apply incompatible overrides to
   obtain a green result.
2. Run affected focused checks while implementing. For the complete candidate,
   run the applicable integrated tests/builds and obtain independent review.
   Update documentation and all release/version/upgrade files together.
3. Push the candidate and inspect the actual GitHub results for its exact commit.
   Require successful **Release checks** before merging. Merge feature work to
   `dev`, then the release change to `master`, and verify the resulting source
   tree and checks before publication. Branch protection can require this named
   check in repository settings; the workflow alone does not configure that rule.
4. Tag the exact release commit, publish its version-specific notes, and verify
   the public archive, tag, version, upgrade contract and updater discovery.
   Keep published tags and historical release notes unchanged.

`npm run audit:dependencies` reports the advisory database's result at the time
of the check. Zero reported npm advisories is a bounded result, not a claim that
all operating-system packages or unknown vulnerabilities have been assessed.

## Separate acceptance checks

This pipeline does not perform a complete interactive installation on a new
machine, every supported browser/device combination, or paid provider requests.
Real-client, migration, restore and storage compatibility evidence must be
recorded separately when those boundaries change. Full fresh-machine and device
coverage were explicitly excluded from the 2.0.1 follow-up scope.

Publishing does not automatically replace a local installation. Updating an
installed stack remains a separate action through the supported updater, with
its existing snapshot and recovery safeguards.
