import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type OwnedArtifact = {
  path: string
  artifactType: 'mcp-registration' | 'memory-rule' | 'memory-reference'
  scope: 'global' | 'project'
  digest: string
}

const MANIFEST_PATH = join('.persistent-memory', 'installer-ownership.json')

function digest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function writeOwnershipManifest(home: string, artifacts: Omit<OwnedArtifact, 'digest'>[]): void {
  const complete = artifacts.filter((artifact) => existsSync(artifact.path)).map((artifact) => ({ ...artifact, digest: digest(artifact.path) }))
  const path = join(home, MANIFEST_PATH)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify({ version: 1, artifacts: complete }, null, 2) + '\n', { mode: 0o600 })
  chmodSync(path, 0o600)
}
