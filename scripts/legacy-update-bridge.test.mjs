import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

test('resolved bridge validation works without installed settings and ignores a poisoned private env file', () => {
  const source = fileURLToPath(new URL('../', import.meta.url))
  const root = mkdtempSync(join(tmpdir(), 'pm compose bridge '))
  try {
    for (const file of ['docker-compose.yml', 'deploy/compose/docker-compose.yml', '.env.persistent-memory.example', 'scripts/validate-legacy-update-bridge.mjs']) {
      mkdirSync(dirname(join(root,file)), {recursive:true})
      copyFileSync(join(source,file),join(root,file))
    }
    const privateFile=join(root,'.env.persistent-memory')
    const run=()=>execFileSync(process.execPath,['scripts/validate-legacy-update-bridge.mjs'],{cwd:root,encoding:'utf8',windowsHide:true,env:{...process.env,PM_RUNTIME_ENV_FILE:privateFile},stdio:['ignore','pipe','pipe']})
    assert.match(run(),/Validated the root Compose compatibility/)
    // Docker rejects this if the service env_file accidentally loads it.
    writeFileSync(privateFile,'=POISONED_PRIVATE_FILE_MUST_NOT_BE_READ\n')
    assert.match(run(),/Validated the root Compose compatibility/)
    // The comparison must still reject a divergent bridge configuration.
    writeFileSync(join(root,'docker-compose.yml'),'services:\n  unexpected:\n    image: alpine:3.20\n')
    assert.throws(run)
  } finally {
    assert.equal(dirname(root), resolve(tmpdir()), 'Cleanup must stay in the owned temporary directory')
    rmSync(root,{recursive:true,force:true})
  }
})
