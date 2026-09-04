import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { browserPushRowsForAlert, externalNotificationChannelsEnabled } from '../src/notify.ts'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('local browser push alert routing', () => {
  it('keeps local email/Slack disabled while allowing browser push rows for matching alert types', () => {
    const rows = [
      { enabled: true, notificationTypes: ['securityAlerts'], endpoint: 'https://push.example.test/1' },
      { enabled: true, notificationTypes: ['memoryAdded'], endpoint: 'https://push.example.test/2' },
      { enabled: false, notificationTypes: ['securityAlerts'], endpoint: 'https://push.example.test/3' },
    ]

    expect(externalNotificationChannelsEnabled('local')).toBe(false)
    expect(browserPushRowsForAlert(rows, 'securityAlerts')).toEqual([rows[0]])
  })

  it('notifies after every DLP path persists its security findings', () => {
    const pipeline = source('../src/pipeline.ts')
    const piiScan = source('../src/steps/pii-scan.ts')

    expect(pipeline.indexOf('await recordSecurityAlerts')).toBeLessThan(pipeline.indexOf('await notifyAlert'))
    expect(piiScan.indexOf('await recordSecurityAlerts')).toBeLessThan(piiScan.indexOf('await notifyAlert'))
    expect(pipeline).toContain("severity: 'high'")
    expect(piiScan).toContain("severity: 'high'")
  })
})
