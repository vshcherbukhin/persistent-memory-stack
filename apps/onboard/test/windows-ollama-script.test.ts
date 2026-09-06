import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Windows PowerShell 5.1 is an installation prerequisite on Windows. Other
// platforms retain the macOS prerequisite flow and never execute this helper.
describe.skipIf(process.platform !== 'win32')('Windows Ollama installer helper', () => {
  it('passes PowerShell AST checks and fully mocked install/start/security scenarios', () => {
    const fixture = fileURLToPath(new URL('./fixtures/windows-ollama-harness.ps1', import.meta.url))
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
    })
    expect(output).toContain('PowerShell 5.1 AST')
    expect(output).toContain('no real download, installation, startup, or cleanup performed')
  }, 35_000)
})
