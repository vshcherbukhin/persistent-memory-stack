import { expect, it } from 'vitest'
import { runInstall, type InstallEvent } from '../server/install.js'

it('direct installer execution stops on an unsupported running Node before any steps', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'version')!
  const events: InstallEvent[] = []
  try {
    Object.defineProperty(process, 'version', { ...descriptor, value: 'v26.8.1' })
    // Missing root/env deliberately cannot run a real dependency or Docker step.
    await runInstall({ root: '/unused-runtime-guard-fixture', env: {} }, event => events.push(event))
    expect(events).toEqual([
      { type: 'error', id: 'node', message: expect.stringContaining('restart the installer') },
      { type: 'done', ok: false },
    ])
  } finally { Object.defineProperty(process, 'version', descriptor) }
})
