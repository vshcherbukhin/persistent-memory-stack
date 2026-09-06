import { describe, expect, it } from 'vitest'
import {
  compareSemver,
  detectMcpRestartRequired,
  parseReleaseHistory,
} from '../../../layers/update-ops/release-versioning/release.ts'
import { publicUpdateSource, isPublicUpdateRepository } from '../../../layers/update-ops/update-flow/github.ts'

describe('update-ops layer', () => {
  it('exposes release-versioning helpers from the layer path', () => {
    const parsed = parseReleaseHistory([
      '# Release History',
      '',
      '## 4.0.0 - 2026-07-08',
      '',
      '| Service | Version | Change |',
      '| --- | --- | --- |',
      '| update/ops | 1.0.0 | Extracted layer. |',
      '',
      '- Updated MCP-facing code. [mcp-restart]',
      '',
    ].join('\n'))

    expect(parsed[0]).toMatchObject({
      version: '4.0.0',
      latest: true,
      mcpRestartRequired: true,
      services: [{ service: 'update/ops', version: '1.0.0', change: 'Extracted layer.' }],
    })
    expect(compareSemver('4.0.1', '4.0.0')).toBeGreaterThan(0)
    expect(detectMcpRestartRequired(['apps/mcp/src/tools/context.ts'])).toBe(true)
  })

  it('exposes update-flow helpers from the layer path', () => {
    expect(publicUpdateSource).toEqual({ owner: 'vshcherbukhin', repo: 'persistent-memory-stack', branch: 'master', releaseLine: 'public-v1' })
    expect(isPublicUpdateRepository('https://github.com/vshcherbukhin/persistent-memory-stack.git')).toBe(true)
    expect(isPublicUpdateRepository('https://github.com/another-owner/persistent-memory-stack.git')).toBe(false)
  })
})
