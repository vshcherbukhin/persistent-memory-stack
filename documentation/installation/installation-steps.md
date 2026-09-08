---
nav_title: Installation steps
nav_group: installation
nav_group_title: Installation
nav_group_order: 10
nav_order: 10
---
# Install Persistent Memory

The installer creates a local Personal Memories stack first: local storage,
the local dashboard, and stream MCP. Shared Memories is optional and can be
connected later from the dashboard. Published stable GitHub Releases are checked
automatically after installation; no update-source account, token, or setup step
is required. Installing an update remains an explicit action.

For Windows, complete [Windows preparation](windows-installation.md) first and
launch with `npm.cmd run install-persistent-memory` from PowerShell. On macOS,
run `npm run check:host` followed by `npm run install-persistent-memory` from the
repository root. Both platforms run the wizard on the host and the services in
Linux containers.

These screenshots are a **sandbox simulation of the installer flow** using safe
demonstration values. They did not create real user-home files, Docker
containers, or data. Some screenshots retain sidebar labels from an earlier
release. The current personal installer has the eleven steps described below;
it has no Shared Memories step. Detected tools and optional choices may differ.

## 1. Get started

Choose **Get started** to begin a local Personal Memories installation.

![Welcome screen](../assets/lifecycle/onboarding/installer-flow.png)

## 2. Check your environment

Confirm Node 24.x LTS or Node 22.12+ in the Node 22 line, Docker, and Docker Compose
are ready. Windows also requires Git for Windows. Review the resource table's
actual, minimum, and recommended RAM and disk figures. Next remains blocked
until the base application can run with API embeddings and extraction. Missing
Ollama is optional here; it is required only when you choose local embeddings.
See [machine requirements](machine-requirements.md) before preparing a small Mac
or Windows laptop.

The installer supports those two Node major versions only. Node 25, 26, and
other majors are rejected even if an individual dependency supports them. If
setup stops before the browser opens, follow the
[macOS recovery steps](#macos-recover-from-an-early-setup-failure) below or select
a supported Node version in your Windows terminal.

On macOS, **Estimated available RAM** includes free, speculative, and inactive
pages that the system may reclaim. This can exceed currently free RAM;
reclamation may require compression or disk writeback. If that estimate cannot
be measured, setup falls back to free RAM with a warning. The minimum budgets
remain unchanged.

![Environment pre-check](../assets/lifecycle/onboarding/installer-prereqs.png)

## 3. Set up the local dashboard

An optional dashboard password sends **Go to dashboard** through the local login
screen. Leave it blank to open Personal Overview directly after installation.

![Dashboard account step](../assets/lifecycle/onboarding/installer-account.png)

## 4. Choose embeddings

Setup suggests a model based on the measured resources. Choose Ollama for local
embeddings or OpenAI/Voyage for API embeddings. Local choices below minimum are
blocked; warnings require acknowledgement. API choices require a key and a
successful **Test embedding connection**. If you select a local model, use
**Install / start Ollama** here if needed; its model downloads during installation.

For an OpenAI test failure, check both the project's model allowlist and the
key's request permissions. The HTTP status alone does not identify the cause;
see [OpenAI embedding access troubleshooting](machine-requirements.md#openai-embedding-access-troubleshooting).
Keep API keys private when sharing diagnostic details.

![Embedding selection](../assets/lifecycle/onboarding/installer-embedding.png)

## 5. Configure fact extraction

Choose your extraction provider and model, then run **Test fact extraction**.
The installer keeps Next disabled until that test succeeds for the current key
and model.

![Extraction configuration](../assets/lifecycle/onboarding/installer-extraction.png)

## 6. Select AI tools

Review the detected Claude and Codex tools. Only the tools you choose receive a
Persistent Memory stream-MCP registration.

![Ecosystem detection](../assets/lifecycle/onboarding/installer-ecosystem.png)

## 7. Choose registration level

**Global Level** is recommended when the selected tool should use Persistent
Memory across projects. Choose Project Level only for a repository-specific
registration.

![Registration level](../assets/lifecycle/onboarding/installer-registration.png)

## 8. Review the memory rule

The rule tells selected AI tools how to recall project context and save durable
corrections. Review it before continuing.

![Memory rule](../assets/lifecycle/onboarding/installer-rule.png)

## 9. Review the generated environment

Confirm the local dashboard URL, stream runtime, embedding provider, and selected
integrations. Secrets remain masked.

![Environment review](../assets/lifecycle/onboarding/installer-review.png)

## 10. Install

Choose **Generate & Install** and wait for the local services, registrations,
and dashboard readiness checks to finish.

Final verification allows up to 120 seconds for already running required
containers to finish their initial healthchecks. Stopped, unhealthy, restarting,
or mismatched-image containers still fail verification. API embeddings do not
require Ollama. If **Required image
identity and runtime state** fails, read the diagnostic lines above the summary
for the named service or image; this check is separate from the embedding check.
After resolving that reported problem, rerun `npm run install-persistent-memory`
to complete installation and agent registration. Preserve the existing environment
file and data volumes when retrying.

![Installation progress](../assets/lifecycle/onboarding/installer-install.png)

## 11. Open your dashboard

Select **Go to dashboard**. Passwordless installs open Personal Overview
directly; password-protected installs open the local login screen first.
Configure any optional Shared Memories server connection later from this local
dashboard; the personal-install wizard does not ask for a shared server or token.

![Installation complete](../assets/lifecycle/onboarding/installer-done.png)

For routine updates, see the dashboard **Releases and updates** guide. For
removal and export, see [Uninstall memory stack](uninstall-memory-stack.md).

## macOS: recover from an early setup failure

Stop an old wizard with **Ctrl+C** in the terminal that launched it. With
Homebrew installed, install the supported Node 24 line and select it for the
current terminal session:

```bash
brew install node@24
export PATH="$(brew --prefix node@24)/bin:$PATH"
hash -r
node --version
node -p "process.execPath"
npm --version
```

Check that the version is `v24.x` and the executable is from the selected
Homebrew installation before proceeding. This session PATH change does not
force-link Node or replace another project's global runtime. Homebrew's
[`node@24` formula](https://formulae.brew.sh/formula/node@24) is installed separately;
[`brew --prefix`](https://docs.brew.sh/Manpage#--prefix-installed-formula-)
locates it without assuming an Apple Silicon or Intel installation path. Repeat
the PATH selection when opening a new terminal, or use your existing version
manager to select Node 24.

From the Persistent Memory checkout, restart setup:

```bash
npm run check:host
npm run install-persistent-memory
```

If setup still fails, keep the name of the failed setup substep and the **first
error above the final `host-runtime`/command-exit wrapper**, together with the
Node version and executable path. A final nonzero-exit wrapper only reports
that a child command failed; it does not identify the original cause. An
unsupported Node version alone is not proof of what caused an earlier failure.
Share only redacted diagnostic output, never API keys or the environment file.
Keep the existing environment and data when retrying.

## Incomplete memory-instruction markers

On Windows or macOS, if **Update agent integration files** reports **Persistent memory instructions
markers are incomplete** (or **Persistent-memory instruction markers are
incomplete**), the failure concerns the delimiters in an existing agent
instruction file or a supplied custom memory block. This is a different issue
from the supported Node version check. Keep the first error and affected file
path when reporting the failure; the final command-exit wrapper is only a
summary.

When updating an existing instruction file with incomplete or nested markers,
the installer first saves an exact copy beside it, named
`<agent-file>.persistent-memory-backup-<timestamp>.bak` (with a suffix if needed
to avoid replacing an existing backup). It then converts the reserved marker
lines outside code examples to inactive recovery comments and adds a complete
generated memory block. Existing prose and examples are retained rather than
guessing which instructions an unmatched marker enclosed. The repair warning
names both the affected file and its backup for review.

If that backup cannot be created, the instruction and rule files are not
changed; resolve the reported permissions or disk-space issue before retrying.
A newly supplied custom memory block with invalid markers still fails validation
before those files are written. Correct that custom block instead of deleting
an agent instruction file or its profile folder. Keep the backup, environment
file, and memory data when rerunning setup.
