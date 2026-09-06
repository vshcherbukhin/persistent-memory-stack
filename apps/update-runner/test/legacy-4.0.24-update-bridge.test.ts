import { lstat, readFile, readlink } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('4.0.24 terminal-update compatibility bridge', () => {
  it('keeps only delegating adapters for the historical root updater', async () => {
    // Keep the compatibility input in-tree so a fresh clone does not depend on
    // unreachable Git objects from the repository where 4.0.24 was released.
    const [legacyContractText, composeBridge, prismaLink, canonicalSchema, rlsAdapter, verifyAdapter] = await Promise.all([
      readFile(new URL('./fixtures/legacy-4.0.24-update-contract.json', import.meta.url), 'utf8'),
      readFile(new URL('../../../docker-compose.yml', import.meta.url), 'utf8'),
      lstat(new URL('../../../prisma', import.meta.url)),
      lstat(new URL('../../../layers/core/schema', import.meta.url)),
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
    expect(composeBridge.replace(/\r\n/g, '\n')).toBe([
      '# Root entry point for the canonical deployment configuration.',
      '#',
      '# Compose resolves paths in an included file from that file\'s own directory, so',
      '# the canonical deployment file remains the only place that defines services.',
      'name: persistent-memory',
      'include:',
      '  - path: deploy/compose/docker-compose.yml',
      '',
    ].join('\n'))
    expect(canonicalSchema.isDirectory()).toBe(true)
    if (prismaLink.isSymbolicLink()) {
      expect(await readlink(new URL('../../../prisma', import.meta.url))).toBe('layers/core/schema')
    } else {
      // Git for Windows checks out symlinks as their target text when symlink
      // creation is unavailable. The historical macOS updater still requires
      // the real symlink; native Windows installs use the canonical schema path.
      expect(process.platform).toBe('win32')
      expect(prismaLink.isFile()).toBe(true)
      expect((await readFile(new URL('../../../prisma', import.meta.url), 'utf8')).trim()).toBe('layers/core/schema')
    }
    expect(rlsAdapter.replace(/\r\n/g, '\n').trim()).toBe('#!/usr/bin/env bash\nexec "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/deploy/scripts/apply-rls.sh" "$@"')
    expect(verifyAdapter.replace(/\r\n/g, '\n').trim()).toBe('#!/usr/bin/env bash\nexec "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/deploy/scripts/verify-install.sh" "$@"')
  })
})
