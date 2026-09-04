import { describe, expect, it } from 'vitest'
import {
  compareSemver,
  detectMcpRestartRequired,
  parseReleaseHistory,
} from '../../../layers/update-ops/release-versioning/release.ts'
import { updateNotificationSettingsBackup } from '../../../layers/update-ops/update-flow/update.ts'

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
    expect(updateNotificationSettingsBackup({
      UPDATE_CHECK_PROVIDER: 'bitbucket',
      UPDATE_BITBUCKET_URL: 'https://stash.example.test',
      UPDATE_BITBUCKET_TOKEN: 'secret-token',
      UPDATE_BITBUCKET_SCOPE: 'user',
      UPDATE_BITBUCKET_USER: 'example.user',
      UPDATE_BITBUCKET_REPO: 'persistent-memory',
    }, 'master')).toMatchObject({
      enabled: true,
      provider: 'bitbucket',
      bitbucket: {
        url: 'https://stash.example.test',
        tokenConfigured: true,
        scope: 'user',
        user: 'example.user',
        repo: 'persistent-memory',
        branch: 'master',
      },
      note: expect.stringContaining('token is redacted'),
    })
  })
})
