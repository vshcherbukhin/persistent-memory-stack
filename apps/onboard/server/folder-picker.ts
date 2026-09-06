import { posix, win32 } from 'node:path'

type Capture = (command: string, args: string[]) => Promise<{ code: number; stdout: string }>

// Static code only: selected paths are returned as UTF-8/base64 so PowerShell's
// console encoding and split output chunks cannot corrupt non-ASCII names.
export const WINDOWS_FOLDER_PICKER_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$pmDialog = New-Object System.Windows.Forms.FolderBrowserDialog
$pmDialog.Description = 'Select a project folder for Persistent Memory'
$pmDialog.ShowNewFolderButton = $false
try {
  if ($pmDialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pmDialog.SelectedPath)))
  }
} finally {
  $pmDialog.Dispose()
}
`

export async function chooseFolder(platform: NodeJS.Platform, capture: Capture): Promise<{
  path?: string; canceled?: boolean; unsupported?: boolean
}> {
  if (!['win32', 'darwin', 'linux'].includes(platform)) return { unsupported: true }
  const command = platform === 'win32'
    ? { name: 'powershell.exe', args: ['-NoProfile', '-STA', '-Command', WINDOWS_FOLDER_PICKER_SCRIPT] }
    : platform === 'darwin'
      ? { name: 'osascript', args: ['-e', 'POSIX path of (choose folder with prompt "Select a project folder")'] }
      : { name: 'zenity', args: ['--file-selection', '--directory', '--title=Select a project folder'] }
  const result = await capture(command.name, command.args)
  const output = result.stdout.trim()
  // AppleScript/Zenity signal cancellation with a nonzero exit code.
  if (result.code !== 0) return platform === 'win32' ? { unsupported: true } : { canceled: true }
  if (!output) return { canceled: true }
  if (platform === 'win32') {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(output)) return { unsupported: true }
    const path = Buffer.from(output, 'base64').toString('utf8')
    return win32.isAbsolute(path) ? { path: win32.normalize(path) } : { unsupported: true }
  }
  return posix.isAbsolute(output) ? { path: output.replace(/\/+$/, '') || '/' } : { canceled: true }
}
