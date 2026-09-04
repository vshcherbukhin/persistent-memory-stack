import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const src = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('application update settings contract', () => {
  it('lets a user test the current unsaved Bitbucket source and keeps the result visible', () => {
    const card = src('../app/(dashboard)/notifications/UpdateNotificationsCard.tsx')
    const actions = src('../app/(dashboard)/notifications/actions.ts')
    const api = src('api.ts')

    expect(card).toContain('Test connection')
    expect(card).toContain('testAction')
    expect(card).toContain('Connection verified')
    expect(card).toContain('Connection failed')
    expect(actions).toContain('testUpdateNotificationsAction')
    expect(actions).toContain('api.testUpdateSettings')
    expect(actions).toContain('errorText')
    expect(actions).toContain('error.details')
    expect(api).toContain("testUpdateSettings: (b: UpdateNotificationSettingsInput)")
    expect(api).toContain('readonly details?: string')
  })
})
