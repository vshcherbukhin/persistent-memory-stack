# Release Versioning Rule

- The visible app version lives in `apps/dashboard/src/lib/version.ts` and must be semver.
- Keep these files aligned when version/release behavior changes:
  - root `package.json` and `package-lock.json`
  - `apps/dashboard/package.json` and `apps/dashboard/package-lock.json`
  - `release-history.md`
  - `apps/dashboard/public/release-history.md`
  - `release/upgrade.json` (the machine-readable upgrade compatibility contract)
- `master` is the release branch. Normal development goes to `dev` or a feature
  branch, then into `dev`; `dev` is the integration/testing branch.
- Public update discovery follows published stable GitHub Releases, not the
  `master` head. Publish the release only after its tag, package version and
  upgrade contract agree at the exact release commit. Drafts, prereleases and
  bare tags are not public update candidates. Publishing remains a separate
  authorized action from merging release preparation into `master`.
- Do not bump product versions for every small `dev` commit. Bump versions and
  release-history only when preparing the `dev` -> `master` release, or when a
  hotfix goes directly to `master`.
- Before committing or pushing user-visible behavior, install/update flow, docs,
  or agent-protocol changes to `master`, verify whether a version/release entry is
  required. Do not push those changes with the top release version unchanged unless
  you explicitly state why no release bump is needed.
- Direct `master` hotfixes are allowed only for urgent fixes and must include the
  matching version/release-history update in the same release change.
- Release history entries include the product version plus service/layer version rows.
- Every release-history entry and published GitHub release body must link to its
  corresponding GitHub Release in the canonical repository:
  `https://github.com/vshcherbukhin/persistent-memory-stack/releases/tag/v<version>`.
  Use that entry's exact version, not the releases index or latest release.
  Keep the root, dashboard and documentation history mirrors aligned, and ensure
  dashboard release cards expose the same version-specific link.
- Run `node scripts/release-notes.mjs --check` to validate history mirrors and
  release links. For an authorized publication, extract the matching GitHub body
  with `node scripts/release-notes.mjs <semver>`; preserve its exact release link.
- Every release contract must use stable `major.minor.patch` versions, declare the
  current root package version in `release`, and pass
  `npm run validate:release-upgrade` before release preparation is complete.
- Update committed docs in `documentation/` in the same change when behavior,
  scripts, architecture, install/update flow, or agent protocol changes.
- Do not put release planning/status in `.claude/CLAUDE.md` or `.codex/AGENTS.md`;
  working release notes and plans belong in `.local/documents/`.
