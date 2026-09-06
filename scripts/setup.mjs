import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, runNpm } from './host-runtime.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = { cwd: root }
await run(process.execPath, ['scripts/pre-update-snapshot.mjs', '--from-setup'], options)
await runNpm(['install'], options)
await runNpm(['run', 'prisma:generate'], options)
await runNpm(['run', 'build:update-coordinator'], options)
await run(process.execPath, ['scripts/install-update-coordinator.mjs', '--root', process.env.PM_COORDINATOR_INSTALL_ROOT || root], options)
await runNpm(['ci', '--prefix', 'apps/onboard'], options)
await runNpm(['run', 'build:server', '--prefix', 'apps/onboard'], options)
await run(process.execPath, ['apps/onboard/dist/apps/onboard/server/agent-update.js'], options)
