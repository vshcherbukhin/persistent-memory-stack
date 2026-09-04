import { lstat, readFile, readlink } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('4.0.24 terminal-update compatibility bridge', () => {
  it('keeps only delegating adapters for the historical root updater', async () => {
    // Keep the compatibility input in-tree so a fresh clone does not depend on
    // unreachable Git objects from the repository where 4.0.24 was released.
    const [legacyContractText, composeBridge, prismaLink, prismaTarget, rlsAdapter, verifyAdapter] = await Promise.all([
      readFile(new URL('./fixtures/legacy-4.0.24-update-contract.json', import.meta.url), 'utf8'),
      readFile(new URL('../../../docker-compose.yml', import.meta.url), 'utf8'),
      lstat(new URL('../../../prisma', import.meta.url)),
      readlink(new URL('../../../prisma', import.meta.url)),
      readFile(new URL('../../../scripts/apply-rls.sh', import.meta.url), 'utf8'),
      readFile(new URL('../../../scripts/verify-install.sh', import.meta.url), 'utf8'),
    ])
    const legacyContract = JSON.parse(legacyContractText) as {
      prismaDir: string
      composeCommand: string
      applyRlsCommand: string
      verifyInstallPath: string
    }

    expect(legacyContract).toEqual({
      prismaDir: '$REPO_ROOT/prisma',
      composeCommand: 'docker compose',
      applyRlsCommand: 'bash scripts/apply-rls.sh',
      verifyInstallPath: '$REPO_ROOT/scripts/verify-install.sh',
    })
    expect(composeBridge).toBe([
      '# Compatibility entry point for the 4.0.24 terminal updater.',
      '#',
      '# Compose resolves paths in an included file from that file\'s own directory, so',
      '# the canonical deployment file remains the only place that defines services.',
      'name: persistent-memory',
      'include:',
      '  - path: deploy/compose/docker-compose.yml',
      '',
    ].join('\n'))
    expect(prismaLink.isSymbolicLink()).toBe(true)
    expect(prismaTarget).toBe('layers/core/schema')
    expect(rlsAdapter.trim()).toBe('#!/usr/bin/env bash\nexec "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/deploy/scripts/apply-rls.sh" "$@"')
    expect(verifyAdapter.trim()).toBe('#!/usr/bin/env bash\nexec "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/deploy/scripts/verify-install.sh" "$@"')
  })
})
