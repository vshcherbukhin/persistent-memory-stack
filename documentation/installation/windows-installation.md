---
nav_title: Windows preparation
nav_group: installation
nav_group_title: Installation
nav_group_order: 10
nav_order: 5
---
# Prepare Windows for a manual installation

Persistent Memory uses the same Linux Docker images on Windows and macOS. On
Windows, run the installer from PowerShell with native Windows Node.js, Git for
Windows, Docker Desktop, and Ollama. The wizard and agent configuration writers
run on the host; the API, dashboard, databases, workers, and stream MCP run in
Docker. Ollama runs on the host and stores its models there.

This guide prepares a manual Windows installation. Completing prerequisite checks
does not establish that an installation works: verify the running services,
embeddings, and agent connection after the wizard finishes.

## 1. Install the Windows prerequisites

Prepare Node.js, Git for Windows, and Docker Desktop, then open a new PowerShell
terminal so it inherits their updated PATH. Ollama can be installed and started
from the Persistent Memory wizard. Use your normal Windows account for project
commands; prerequisite installers may request elevation separately.

| Prerequisite | Preparation |
|---|---|
| [Node.js](https://nodejs.org/en/download) | Install Node 24 LTS, or Node 22.12 or newer within the Node 22 line. npm is included. This project's host tooling requires Node 22.12+ even though some dependencies still permit Node 20. |
| [Git for Windows](https://gitforwindows.org/) | Install Git with Git Bash and make Git available to command-line applications. Lifecycle helpers use the bundled Bash and Unix utilities. |
| [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/) | Use a currently supported Windows version, enable hardware virtualization and WSL 2, and select the WSL 2 backend with **Linux containers**. Start Docker Desktop and wait for its engine to be ready. |
| [Ollama for Windows](https://docs.ollama.com/windows) | Choose **Install** in the wizard's Ollama card, or **Start** if it is already installed. You can also install it manually. Keep the native application running while using Persistent Memory; models need additional disk space. |

Docker requires WSL 2.1.5 or newer; use the current WSL release. Check with
`wsl --version`. Follow Docker's prerequisite instructions if WSL needs installing
or updating, and restart Windows if requested. Docker commands work from Windows
terminals without installing a separate user Linux distribution.
See [Docker's WSL 2 setup](https://docs.docker.com/desktop/features/wsl/).

Keep this project's checkout and host tooling in Windows. Running the wizard
inside a WSL distribution selects that distribution's home directory and agent
configuration, which is a different installation from your Windows apps. The
launcher selects Git for Windows Bash explicitly; the Windows `bash.exe` WSL
launcher is not a substitute.

## 2. Open the project in PowerShell

If you already have this checkout on Windows, open that directory. For example:

```powershell
Set-Location "C:\src\persistent-memory-stack"
```

For a new checkout, clone the public repository:

```powershell
git clone --config core.autocrlf=false "https://github.com/vshcherbukhin/persistent-memory-stack.git" "C:\src\persistent-memory-stack"
Set-Location "C:\src\persistent-memory-stack"
```

This clone setting preserves LF line endings from the first checkout without
changing your global Git settings. The repository's `.gitattributes` also keeps
shell scripts and container inputs in their required format. Do not copy macOS
`node_modules` or compiled host binaries to Windows; the installer builds local
dependencies for this machine.

If this directory already contains `.env.persistent-memory` or this machine
already has Persistent Memory volumes, treat it as an existing installation.
Keep the environment file, credentials, memories, and volumes. Use the existing
installation's update/start commands rather than starting another installation
over it. A new Windows installation has its own local memories; installing it
does not automatically transfer or synchronize the Mac's memories.

## 3. Run the checks before installation

From the repository root:

```powershell
node --version
npm.cmd --version
git --version
docker compose version
docker info --format '{{.OSType}}'
npm.cmd run check:host
```

The Docker OS type must be `linux`. `check:host` is a diagnostic command: it
checks the host prerequisites without installing the stack, creating credentials,
or registering agents. Missing or stopped Ollama can be resolved in the wizard
and does not prevent you from launching it. Prepare Node, Git, and Docker before
launching; if Docker is unreachable, start Docker Desktop and wait for it to
become ready.

Use `npm.cmd` in PowerShell throughout this guide. This avoids an execution-policy
error from the `npm.ps1` wrapper without changing your PowerShell execution policy.
On macOS, use `npm` with the same command names.

If Git Bash was installed in a custom directory and cannot be detected, set its
absolute executable path in the current terminal, then repeat the check:

```powershell
$env:PM_GIT_BASH = 'D:\Applications\Git\bin\bash.exe'
npm.cmd run check:host
```

Check existing Docker services and listeners before installing. Common host ports
include the temporary wizard on `4319`, dashboard gateway on `3200`, and stream
MCP on `8091`; other published ports come from the Compose configuration. Resolve
ownership of occupied ports before proceeding. Retain an existing healthy
Persistent Memory stack instead of starting another copy or terminating an
unrelated application.

## 4. Launch and complete the wizard

```powershell
npm.cmd run install-persistent-memory
```

Keep the terminal open. The launcher prepares the wizard and opens
[the local installer](http://127.0.0.1:4319). If the browser does not open,
navigate to that address manually. First-time dependencies, images, and model
downloads can take time.

The wizard stays alive while a prerequisite installer, model download, or stack
installation is running. Its 30-minute idle countdown restarts when that work
finishes. A visible wizard tab also keeps the server active while you fill in the
form, without changing your entries. Keep the launch terminal open. In shorter
windows, scroll the sidebar to see the remaining steps.

Follow the 12 [Installation steps](installation-steps.md). Public release checks
work automatically after installation, with no update token or setup step. Install Personal Memories
first, select an embedding model that fits the machine, and test the extraction
provider with your own credentials. Review the selected Windows Claude/Codex
tools and registration level before choosing **Generate & Install**. Shared
Memories is optional and can be connected later from the local dashboard.

On the Environment pre-check screen, choose **Install** in the Ollama card if
Ollama is missing, or **Start** if it is installed but stopped. Wait for the card
to report that Ollama is ready before continuing. Node and Docker prerequisite
cards provide manual setup instructions.

During the Ollama download, the progress bar shows bytes and a percentage when
the file size is known. Verification, installation, startup, and readiness checks
show an activity indicator with the current stage; they do not display an
estimated percentage. The terminal log remains below the progress bar. **Next**
stays disabled until readiness is confirmed.

**Install** downloads the official Windows Ollama installer, verifies its
signature, installs it for your Windows account, and starts it. The wizard
refreshes its process PATH and checks reachability. Existing Ollama installations
and downloaded models are reused. A separate package manager is not required;
manual installation from [Ollama's Windows download](https://ollama.com/download/windows)
remains available.

If you see **Failed to fetch** or an installer connection error, check the launch
terminal. If the wizard has exited, run `npm.cmd run install-persistent-memory`
again, then choose **Check again** in the browser to refresh the prerequisite
state. A failed check remains **Not checked**, and an interrupted progress stream
does not confirm a successful installation. Never execute a partial or unverified
Ollama installer download yourself; retry through the wizard to download and
verify it before execution.

For tools installed outside the wizard, reopen the terminal and relaunch the
wizard if it still sees the old PATH. Reuse the existing generated configuration
if an installation was interrupted; do not delete it or regenerate secrets to
work around a failure.

The registration step's **Choose…** button opens the native Windows folder
dialog. You can also enter an absolute Windows path such as
`C:\Projects\My project`; spaces and non-ASCII folder names are supported. Project
registration requires at least one folder. Selecting Global Level ignores any
unfinished project-path input.

If the extraction test reports **Connection succeeded, but the model rejected the
built-in extraction sample**, the connection succeeded and the sample did not
produce the expected classification. This is not an authentication rejection.
Retry uses the same model and key, and this test does not save a memory.

### Windows MCP and rule locations

The wizard registers the selected Claude and Codex apps for the Windows account
running it. Their MCP entries contain the stream endpoint URL, with no macOS
launcher path or embedding credentials.

| Scope | Claude Code and Desktop folder sessions | Codex CLI and Desktop |
|---|---|---|
| Global MCP | `%USERPROFILE%\.claude.json` | `%USERPROFILE%\.codex\config.toml` |
| Global guidance | `%USERPROFILE%\.claude\CLAUDE.md` and `rules\persistent-memory.md` | `%USERPROFILE%\.codex\AGENTS.md` and `rules\persistent-memory.md` |
| Project MCP | The selected folder's entry in the active Claude JSON profile | `<project>\.codex\config.toml`; trust the folder in Codex |
| Project guidance | `<project>\CLAUDE.md` and `.claude\rules\persistent-memory.md` | `<project>\AGENTS.md` and `.codex\rules\persistent-memory.md` |

If you use custom profiles, launch the wizard with the same `CODEX_HOME` and
`CLAUDE_CONFIG_DIR` values as your agents. `CODEX_HOME` replaces the global
`.codex` directory. `CLAUDE_CONFIG_DIR` replaces the global `.claude` directory
and puts the global `.claude.json` inside that selected directory. An existing
legacy Claude `.config.json` in the profile takes precedence and is updated in
place; other profile copies are left alone. See [Codex environment variables](https://learn.chatgpt.com/docs/config-file/environment-variables)
and [Claude profile configuration](https://code.claude.com/docs/en/claude-directory).

If Codex already has a nonempty `AGENTS.override.md` at the selected scope, the
wizard adds its protocol instruction there because that file takes precedence
over `AGENTS.md`. The instruction explicitly tells Codex to read the detailed
protocol; it does not rely on Claude's `@` import behavior. See [Codex instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

Registration merges its own MCP entry and generated rule block while preserving
unrelated settings and guidance. UTF-8 JSON files with a byte-order mark are
accepted. Unreadable or malformed existing JSON stops registration without
replacing the file; update reports and skips such files. Standalone Claude
Desktop chat uses its connector settings separately; the wizard does not write
an HTTP entry into `claude_desktop_config.json`.

## 5. Verify the installed stack

After installation finishes, run:

```powershell
npm.cmd run verify-persistent-memory
docker compose -f deploy/compose/docker-compose.yml --env-file .env.persistent-memory --profile mcp-stream ps
Invoke-RestMethod http://localhost:11434/api/tags
```

Open [the dashboard](http://localhost:3200). Confirm Services reports the expected
containers and host Ollama as healthy, the configured embedding model is present,
and the wizard's selected AI tools can connect to stream MCP. Restart selected
AI tools so they load their new registration. Save and recall a harmless test
memory to verify an actual agent round trip; a running container alone does not
verify embedding or MCP behavior.

For the follow-up verification, keep the output from `check:host` and
`verify-persistent-memory` and the first relevant error if a step fails. Share
redacted output; the generated environment file and agent configuration may
contain private information. Live Windows installation, GPU use, and the
end-to-end memory round trip remain to be verified on your machine.

## Ollama: host and container addresses

| Caller | Default address |
|---|---|
| PowerShell and the host wizard | `http://localhost:11434` |
| Persistent Memory containers | `http://host.docker.internal:11434` |

The generated `.env.persistent-memory` uses the container address for
`OLLAMA_URL`. Docker Desktop provides `host.docker.internal` for reaching host
services; `localhost` inside a container refers to that container.
See [Docker Desktop host networking](https://docs.docker.com/desktop/features/networking/networking-how-tos/).

If the host `/api/tags` check succeeds but Services reports Ollama unreachable,
inspect Windows Firewall/VPN rules and Ollama's bind address. Ollama defaults to
loopback. If your Docker network requires a broader bind, quit Ollama, set the
Windows **user** environment variable `OLLAMA_HOST` to `0.0.0.0:11434`, and restart
Ollama from the Start menu. That bind exposes the listener beyond loopback;
restrict firewall access to the local Docker path instead of opening it to
untrusted networks. Recheck connectivity from the stack. Setting `OLLAMA_URL`
in the project does not configure Ollama's listening address.
See [Ollama environment configuration](https://docs.ollama.com/faq#setting-environment-variables-on-windows).

Host verification discards HTTP response bodies through the shell. Passing
`/dev/null` as a curl output filename fails with native Windows curl when Git
Bash path conversion is disabled; that can falsely report Ollama as unreachable
and Qdrant as not ready even when both services respond. The current verifier
uses shell redirection, which also works on macOS.

If installation stopped at verification and the wizard is still open, keep that
page open while correcting the cause. After `npm.cmd run verify-persistent-memory`
passes, select **Shared Memories** in the wizard sidebar, then **Next** to retry
the installation steps with the current answers and existing environment file.
This repeats the setup/build checks and reuses the downloaded model and data
volumes. Let it finish MCP registration and rule writing before treating setup
as complete. Do not return to **Review env** just to retry, because that step
generates the environment again.

## Routine operation after installation

Run these commands from the same checkout:

| PowerShell command | Result |
|---|---|
| `npm.cmd run start-persistent-memory` | Start the existing stack using its generated environment. |
| `npm.cmd run stop-persistent-memory` | Stop the stack while preserving its named data volumes and environment file. |
| `npm.cmd run verify-persistent-memory` | Check the installed stack. |
| `npm.cmd run update-persistent-memory` | Run the protected snapshot, update, migration, and verification flow. |

Start Docker Desktop and native Ollama before starting or verifying the stack
after a reboot. Docker Desktop and Ollama have their own launch-at-login
settings. Stopping the stack does not uninstall those host applications.

Use [Uninstall and export](uninstall-memory-stack.md) only when you intend to
remove the installation. Uninstall deletes local data after its confirmations;
it is not a stop or repair command. Do not remove Docker volumes, reset Docker
Desktop, or delete `.env.persistent-memory` to troubleshoot an installation.

## macOS uses the same lifecycle commands

Keep using native Node, Docker Desktop, and host Ollama on macOS, with Node 24
LTS or Node 22.12+ in the Node 22 line. Use `npm run check:host` and then
`npm run install-persistent-memory` from the checkout. The launcher uses the
system Bash on macOS; Git for Windows and WSL are Windows prerequisites only.
The existing Homebrew assistance and Personal-first wizard remain available.
The start, stop, verify, and update command names above are identical with
`npm` in place of `npm.cmd`.
