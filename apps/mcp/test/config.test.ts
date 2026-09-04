import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

describe('MCP environment config', () => {
  it('treats blank optional personal/shared surface settings as unset', () => {
    const cfg = loadConfig({
      API_URL: 'http://localhost:8090',
      PM_PERSONAL_API_URL: '',
      PM_PERSONAL_USER_TOKEN: '',
      PM_SHARED_API_URL: '',
      PM_SHARED_USER_TOKEN: '',
    } as NodeJS.ProcessEnv)

    expect(cfg.PM_PERSONAL_API_URL).toBeUndefined()
    expect(cfg.PM_PERSONAL_USER_TOKEN).toBeUndefined()
    expect(cfg.PM_SHARED_API_URL).toBeUndefined()
    expect(cfg.PM_SHARED_USER_TOKEN).toBeUndefined()
  })
})
