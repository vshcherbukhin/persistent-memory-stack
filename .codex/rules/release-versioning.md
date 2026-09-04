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
- Every release contract must use stable `major.minor.patch` versions, declare the
  current root package version in `release`, and pass
  `npm run validate:release-upgrade` before release preparation is complete.
- Update committed docs in `documentation/` in the same change when behavior,
  scripts, architecture, install/update flow, or agent protocol changes.
- Do not put release planning/status in `.claude/CLAUDE.md` or `.codex/AGENTS.md`;
  working release notes and plans belong in `.local/documents/`.
