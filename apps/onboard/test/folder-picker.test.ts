import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { chooseFolder, WINDOWS_FOLDER_PICKER_SCRIPT } from '../server/folder-picker'

describe('native project folder picker', () => {
  it.each(['C:\\Projects\\Mémoires équipe', 'C:\\', '\\\\server\\share\\Project One'])('preserves the selected Windows path: %s', async (path) => {
    const result = await chooseFolder('win32', async (command, args) => {
      expect(command).toBe('powershell.exe')
      expect(args).toEqual(['-NoProfile', '-STA', '-Command', WINDOWS_FOLDER_PICKER_SCRIPT])
      return { code: 0, stdout: Buffer.from(path, 'utf8').toString('base64') + '\r\n' }
    })
    expect(result).toEqual({ path })
  })

  it('does not select a folder when the Windows dialog is canceled', async () => {
    expect(await chooseFolder('win32', async () => ({ code: 0, stdout: '' }))).toEqual({ canceled: true })
  })

  it.each([
    { code: 1, stdout: 'PowerShell unavailable' },
    { code: 0, stdout: 'unexpected diagnostic text' },
    { code: 0, stdout: Buffer.from('relative-folder').toString('base64') },
  ])('offers manual entry when the Windows picker fails: $code $stdout', async (result) => {
    expect(await chooseFolder('win32', async () => result)).toEqual({ unsupported: true })
  })

  it.each(['darwin', 'linux'] as const)('preserves %s path and root handling', async (platform) => {
    expect(await chooseFolder(platform, async () => ({ code: 0, stdout: '/Users/Test/Project One/\n' })))
      .toEqual({ path: '/Users/Test/Project One' })
    expect(await chooseFolder(platform, async () => ({ code: 0, stdout: '/\n' }))).toEqual({ path: '/' })
    expect(await chooseFolder(platform, async () => ({ code: 1, stdout: '' }))).toEqual({ canceled: true })
  })

  it.runIf(process.platform === 'win32')('parses the Windows PowerShell script without opening a dialog', () => {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '$pmTokens=$null; $pmParseErrors=$null; $null=[System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$pmTokens,[ref]$pmParseErrors); if ($pmParseErrors.Count) { throw ($pmParseErrors | Out-String) }; "syntax-ok"',
    ], { input: WINDOWS_FOLDER_PICKER_SCRIPT, encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    expect(output.trim()).toBe('syntax-ok')
  })
})
