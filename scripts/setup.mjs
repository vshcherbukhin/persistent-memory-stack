import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertSupportedNode, nodeEnvironment, run, runNpm } from './host-runtime.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function runSetup({
  nodeVersion = process.versions.node, env = process.env,
  runCommand = run, runNpmCommand = runNpm, log = console.log,
} = {}) {
  assertSupportedNode(nodeVersion)
  const options = { cwd: root, env: nodeEnvironment({ env }) }
  // Labels are fixed product text: never include environment values or argv.
  const steps = [
    ['Create the pre-update snapshot', () => runCommand(process.execPath, ['scripts/pre-update-snapshot.mjs', '--from-setup'], options)],
    ['Install application dependencies', () => runNpmCommand(['install'], options)],
    ['Generate the Prisma client', () => runNpmCommand(['run', 'prisma:generate'], options)],
    ['Build the update coordinator', () => runNpmCommand(['run', 'build:update-coordinator'], options)],
    ['Install the update coordinator', () => runCommand(process.execPath, ['scripts/install-update-coordinator.mjs', '--root', env.PM_COORDINATOR_INSTALL_ROOT || root], options)],
    ['Install installer dependencies', () => runNpmCommand(['ci', '--prefix', 'apps/onboard'], options)],
    ['Build the installer server', () => runNpmCommand(['run', 'build:server', '--prefix', 'apps/onboard'], options)],
    ['Update agent integration files', () => runCommand(process.execPath, ['apps/onboard/dist/apps/onboard/server/agent-update.js'], options)],
  ]
  for (const [index, [label, execute]] of steps.entries()) {
    log(`[setup ${index + 1}/${steps.length}] ${label}`)
    try { await execute() } catch (cause) {
      throw new Error(`Setup failed during: ${label}. Review the command output immediately above this message for the underlying error.`, { cause })
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSetup().catch(error => { console.error(error.message); process.exitCode = 1 })
}
