[CmdletBinding()]
param(
    [ValidateSet('Install', 'Start')]
    [string]$Action = 'Install'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-PmOllamaExecutable {
    $command = Get-Command -Name 'ollama.exe' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) {
        return $command.Source
    }
    if ($env:LOCALAPPDATA) {
        $candidate = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function Test-PmOllamaReady {
    $url = if ($env:PM_OLLAMA_URL) { $env:PM_OLLAMA_URL } else { 'http://localhost:11434' }
    $url = $url.Replace('host.docker.internal', 'localhost').TrimEnd('/')
    try {
        $response = Invoke-RestMethod -Uri "$url/api/tags" -Method Get -TimeoutSec 3
        return $null -ne $response -and $response.PSObject.Properties.Name -contains 'models' -and $response.models -is [array]
    } catch {
        return $false
    }
}

function New-PmOllamaDownloadDirectory {
    $directory = Join-Path ([IO.Path]::GetTempPath()) ('persistent-memory-ollama-' + [Guid]::NewGuid().ToString('N'))
    $directory = [IO.Path]::GetFullPath($directory)
    New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null
    return $directory
}

function Remove-PmOllamaDownloadDirectory {
    param([Parameter(Mandatory)][string]$Directory)
    $target = [IO.Path]::GetFullPath($Directory)
    $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $target.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($target) -notmatch '^persistent-memory-ollama-[a-f0-9]{32}$' -or
        [IO.Path]::GetDirectoryName($target).TrimEnd('\', '/') -ne $tempRoot.TrimEnd('\', '/')) {
        throw 'Refusing to remove a directory outside the owned Ollama download location.'
    }
    if (Test-Path -LiteralPath $target) {
        $item = Get-Item -LiteralPath $target -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Refusing to recursively remove a redirected Ollama download directory.'
        }
        Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
    }
}

function New-PmOllamaHiddenStartMarker {
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required for per-user Ollama installation.' }
    $directory = Join-Path $env:LOCALAPPDATA 'Ollama'
    $marker = Join-Path $directory 'upgraded'
    if (Test-Path -LiteralPath $marker) { return $null }
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory | Out-Null }
    # Ollama's official installer script uses this marker to hide first-start UI.
    # Do not overwrite a marker created by an existing installation.
    New-Item -ItemType File -Path $marker | Out-Null
    return $marker
}

function Remove-PmOllamaHiddenStartMarker {
    param([Parameter(Mandatory)][string]$Marker)
    $expected = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Ollama\upgraded'))
    if ([IO.Path]::GetFullPath($Marker) -ne $expected) { throw 'Refusing to remove an unowned Ollama startup marker.' }
    if (Test-Path -LiteralPath $expected -PathType Leaf) {
        $item = Get-Item -LiteralPath $expected -Force
        if ($item.Length -eq 0 -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
            Remove-Item -LiteralPath $expected -Force
        }
    }
}

function New-PmOllamaDownloadRequest {
    param([Parameter(Mandatory)][string]$Uri)
    # Windows PowerShell 5.1 uses .NET Framework. Match Ollama's official
    # streaming downloader instead of Invoke-WebRequest's slow progress path.
    $request = [Net.HttpWebRequest]::Create($Uri)
    $request.AllowAutoRedirect = $true
    $request.Timeout = 30000
    $request.ReadWriteTimeout = 120000
    return $request
}

function New-PmOllamaDownloadStream {
    param([Parameter(Mandatory)][string]$Path)
    return [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
}

function New-PmOllamaProgressTimer {
    return [Diagnostics.Stopwatch]::StartNew()
}

function Write-PmOllamaProgress {
    param(
        [Parameter(Mandatory)][ValidateSet('download', 'verify', 'install', 'start', 'ready')][string]$Stage,
        [long]$DownloadedBytes = -1,
        [long]$TotalBytes = -1
    )
    $record = [ordered]@{ stage = $Stage }
    if ($Stage -eq 'download') {
        if ($DownloadedBytes -ge 0) { $record.downloadedBytes = $DownloadedBytes }
        if ($TotalBytes -gt 0) { $record.totalBytes = $TotalBytes }
    }
    Write-Host ('PM_OLLAMA_PROGRESS ' + ($record | ConvertTo-Json -Compress))
}

function Invoke-PmOllamaDownload {
    param([Parameter(Mandatory)][string]$InstallerPath)
    Write-PmOllamaProgress -Stage download -DownloadedBytes 0
    $request = New-PmOllamaDownloadRequest -Uri 'https://ollama.com/download/OllamaSetup.exe'
    $response = $null
    $inputStream = $null
    $fileStream = $null
    try {
        $response = $request.GetResponse()
        $total = $response.ContentLength
        if ($total -gt 0) { Write-PmOllamaProgress -Stage download -DownloadedBytes 0 -TotalBytes $total }
        $inputStream = $response.GetResponseStream()
        $fileStream = New-PmOllamaDownloadStream -Path $InstallerPath
        $buffer = New-Object byte[] 65536
        [long]$downloaded = 0
        $progressTimer = New-PmOllamaProgressTimer
        while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $fileStream.Write($buffer, 0, $read)
            $downloaded += $read
            if ($progressTimer.ElapsedMilliseconds -ge 1000) {
                Write-PmOllamaProgress -Stage download -DownloadedBytes $downloaded -TotalBytes $total
                if ($total -gt 0) {
                    Write-Host ('Downloading Ollama: {0:N1} / {1:N1} MiB ({2:N0}%).' -f ($downloaded / 1MB), ($total / 1MB), (100 * $downloaded / $total))
                } else {
                    Write-Host ('Downloading Ollama: {0:N1} MiB.' -f ($downloaded / 1MB))
                }
                $progressTimer.Restart()
            }
        }
        if ($downloaded -eq 0 -or ($total -ge 0 -and $downloaded -ne $total)) {
            throw "The Ollama download was incomplete ($downloaded bytes received; expected $total). Please retry."
        }
        Write-PmOllamaProgress -Stage download -DownloadedBytes $downloaded -TotalBytes $total
        Write-Host ('Ollama download complete: {0:N1} MiB. Verifying installer signature.' -f ($downloaded / 1MB))
    } finally {
        try {
            if ($null -ne $fileStream) { $fileStream.Dispose() }
        } finally {
            try {
                if ($null -ne $inputStream) { $inputStream.Dispose() }
            } finally {
                if ($null -ne $response) { $response.Dispose() }
            }
        }
    }
}

function Install-PmOllama {
    $directory = New-PmOllamaDownloadDirectory
    $ownedMarker = $null
    $completed = $false
    try {
        $installerPath = Join-Path $directory 'OllamaSetup.exe'
        Write-Host 'Downloading the official Ollama installer.'
        Invoke-PmOllamaDownload -InstallerPath $installerPath
        Write-PmOllamaProgress -Stage verify
        $signature = Get-AuthenticodeSignature -LiteralPath $installerPath
        if ([string]$signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate -or
            $signature.SignerCertificate.Subject -notmatch '(^|, )O=Ollama Inc\.(,|$)') {
            throw 'The Ollama installer does not have a valid signature from Ollama Inc. Installation was stopped.'
        }
        Write-Host 'Installing Ollama for the current Windows user.'
        Write-PmOllamaProgress -Stage install
        $ownedMarker = New-PmOllamaHiddenStartMarker
        $installer = Start-Process -FilePath $installerPath -ArgumentList @('/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES') -PassThru -WindowStyle Hidden
        # -Wait also waits for descendants, including the tray app which remains
        # running. Only wait for the installer process itself to finish.
        $installer.WaitForExit()
        if ($installer.ExitCode -ne 0) {
            throw "The Ollama installer exited with code $($installer.ExitCode)."
        }
        $completed = $true
    } finally {
        try {
            if (-not $completed -and $ownedMarker) { Remove-PmOllamaHiddenStartMarker -Marker $ownedMarker }
        } finally {
            Remove-PmOllamaDownloadDirectory -Directory $directory
        }
    }
}

function Wait-PmOllamaAutoStart {
    Write-PmOllamaProgress -Stage ready
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        if (Test-PmOllamaReady) { return $true }
        if ($attempt -lt 9) { Start-Sleep -Milliseconds 500 }
    }
    return $false
}

function Start-PmOllama {
    param([Parameter(Mandatory)][string]$Executable)
    Write-PmOllamaProgress -Stage start
    if (Test-PmOllamaReady) {
        Write-Host 'Ollama is already running.'
        return
    }
    $app = Join-Path ([IO.Path]::GetDirectoryName($Executable)) 'ollama app.exe'
    if (Test-Path -LiteralPath $app -PathType Leaf) {
        $runningApp = Get-Process -Name 'ollama app' -ErrorAction SilentlyContinue | Where-Object { $null -ne $_ -and $_.Path -eq $app } | Select-Object -First 1
        if ($runningApp) {
            Write-Host 'Ollama app is already running. The environment pre-check will confirm API readiness.'
            return
        }
        Start-Process -FilePath $app -ArgumentList @('hidden') -WindowStyle Hidden | Out-Null
    } else {
        Start-Process -FilePath $Executable -ArgumentList @('serve') -WindowStyle Hidden | Out-Null
    }
    Write-Host 'Ollama startup requested. The environment pre-check will confirm when its API is ready.'
}

function Invoke-PmOllamaWindows {
    param([ValidateSet('Install', 'Start')][string]$RequestedAction)
    $executable = Get-PmOllamaExecutable
    if (-not $executable) {
        if ($RequestedAction -eq 'Start') {
            throw 'Ollama is not installed. Use Install Ollama first.'
        }
        if (Test-PmOllamaReady) {
            throw 'An Ollama API is already running, but its Windows CLI was not found. Add the existing Ollama directory to PATH and restart the installer.'
        }
        Install-PmOllama
        $executable = Get-PmOllamaExecutable
        if (-not $executable) { throw 'Ollama installation finished, but ollama.exe was not found. Restart the installer after checking the Ollama installation.' }
        # The official installer launches its tray app asynchronously. Give it a
        # bounded opportunity to become ready before considering a fallback start.
        [void](Wait-PmOllamaAutoStart)
    }
    # Refresh this process only; preserve user OLLAMA_HOST, OLLAMA_MODELS, and all
    # persistent environment settings. Existing installations are never replaced.
    $env:PATH = [IO.Path]::GetDirectoryName($executable) + [IO.Path]::PathSeparator + $env:PATH
    Start-PmOllama -Executable $executable
    Write-PmOllamaProgress -Stage ready
}

# Dot-sourcing exposes functions for safe tests without downloading or starting
# anything. The production launcher uses -File and enters here exactly once.
if ($MyInvocation.InvocationName -ne '.') {
    Invoke-PmOllamaWindows -RequestedAction $Action
}
