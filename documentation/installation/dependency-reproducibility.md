---
nav_title: Dependency reproducibility
nav_group: installation
nav_group_title: Installation
nav_group_order: 10
nav_order: 17
---
# Fixed dependencies for installation

A release installs the dependency versions committed and verified with its source.
Installing it later must not select newer package versions automatically.

The workspace root, dashboard, wizard, and documentation each have a committed
`package-lock.json`. External direct dependencies use exact stable versions.
Installation uses `npm ci`, checks supported engines, and rejects missing or
inconsistent lockfiles. Retry helpers preserve the failure exit code; they retry
the same locked tree and never fall back to `npm install`.

The graph, detection, and documentation Python environments have
`requirements.lock` files containing exact transitive versions and SHA256 hashes.
Their build tools are locked separately. Installation verifies hashes and runs
`pip check`. The detection lock also fixes the language model URL and checksum,
so a dynamic model download cannot silently change the scanner.
Its email recognizer uses the public-suffix snapshot bundled in the locked
package, with runtime suffix-list downloads disabled.

Container base images and external database/storage images use immutable
registry digests. Existing database major versions remain fixed for compatibility
with stored volumes; package maintenance does not silently migrate those volumes.

MinIO's former vendor container is no longer available for a fresh pull. Community
builds the pinned official release from its checksum-verified source archive using
a digest-pinned Go toolchain and the upstream module locks. The image includes
that exact source archive, license, and credits. The existing S3 credentials,
data-volume path, and API/console ports remain the same. This first build needs
access to GitHub and the Go module proxy and checksum service; it can take several
minutes. Setup checks those connections before starting.

Compatible maintained versions take precedence over an untested major upgrade.
Next.js stays on its maintained 15.x line. The Qdrant client matches the preserved
1.18.x server. Graphiti stays on 0.29.2 because newer deletion behaviour introduces
an additional model call; package maintenance must preserve Community's existing
non-replaying deletion contract. A future upgrade requires separate compatibility
and data-flow verification.

Maintainers run `npm run verify:dependencies` before setup and during release
verification. Dependency updates require deliberate lock regeneration, clean
installation, applicable tests/builds, and independent review. A lock prevents
version drift; it cannot make an unavailable registry, unsupported machine,
expired provider credential, or interrupted download succeed. The wizard blocks
known environment failures and reports installation failures without claiming
success.

Community guidance does not require company notification or external-page update
workflows. Personal document requirements need no external account or page ID.
Historical source metadata remains readable.
