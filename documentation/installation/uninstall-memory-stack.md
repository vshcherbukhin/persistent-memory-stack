---
nav_title: Uninstall memory stack
nav_group: installation
nav_group_title: Installation
nav_group_order: 10
nav_order: 20
---
# Uninstall and export

`npm run uninstall-persistent-memory` removes the local Personal Memories
stack. It is a separate terminal process from onboarding.

On Windows, run `npm.cmd run uninstall-persistent-memory` from PowerShell in the
same checkout used for installation. The launcher uses Git for Windows Bash.
For a temporary shutdown that preserves data, use
`npm.cmd run stop-persistent-memory` instead (`npm run stop-persistent-memory`
on macOS).

The terminal captures below are a **sandbox simulation of the script prompts**
using safe demonstration values. They never change a Shared Memories server,
external account, real user-home configuration, Docker container, or data.

## 1. Choose AI integration cleanup

The script first asks whether to remove detected installer-owned Claude/Codex
registrations and generated rules. Choose stack-only removal to retain those
files. Modified, unproven, or legacy files are preserved with manual guidance.

![Agent cleanup choice](../assets/lifecycle/uninstall/uninstall-agent-cleanup.png?v=20260713-crop)

## 2. Export memories

When the local database contains memories, export them before removing volumes.
Choose **Export memories** unless you have already made a verified backup.

![Export choice](../assets/lifecycle/uninstall/uninstall-export.png?v=20260713-crop)

## 3. Choose the export format

Choose encrypted `.pm` for a private backup protected by a passphrase, or
standard JSON for a portable export.

![Export format](../assets/lifecycle/uninstall/uninstall-format.png?v=20260713-crop)

## 4. Confirm local stack removal

The final confirmation removes local containers, networks, volumes, images, and
the generated environment file. It does not remove repository source files or
your export.

![Removal confirmation](../assets/lifecycle/uninstall/uninstall-confirm.png?v=20260713-crop)

## 5. Verify completion

Keep the reported export path. Reinstall later with
`npm run install-persistent-memory` and import that export if needed.

![Uninstall complete](../assets/lifecycle/uninstall/uninstall-complete.png?v=20260713-crop)
