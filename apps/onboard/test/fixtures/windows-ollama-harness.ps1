param([string]$Helper = (Join-Path $PSScriptRoot '..\..\..\..\deploy\scripts\install-ollama-windows.ps1'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Helper = [IO.Path]::GetFullPath($Helper)
$script:Passed = 0

function Assert-PmTest($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Expect-PmFailure([scriptblock]$Body, [string]$Message) {
    $caught = $false
    try { & $Body } catch {
        $caught = $true
        Assert-PmTest ($_.Exception.Message.Contains($Message)) "Wrong failure: $($_.Exception.Message)"
    }
    Assert-PmTest $caught "Expected failure containing: $Message"
}

function Invoke-PmCase([string]$Name, [scriptblock]$Body) {
    # External side effects fail unless this case installs an explicit mock.
    function Invoke-WebRequest { throw 'Unexpected download boundary' }
    function Invoke-RestMethod { throw 'Unexpected network boundary' }
    function Start-Process { throw 'Unexpected process boundary' }
    function New-Item { throw 'Unexpected filesystem creation boundary' }
    function Remove-Item { throw 'Unexpected filesystem removal boundary' }
    function Get-Process { return $null }
    function Start-Sleep { throw 'Unexpected real wait boundary' }
    . $Helper -Action Start
    $script:DownloadRequestFactory = ${function:New-PmOllamaDownloadRequest}
    function New-PmOllamaDownloadRequest { throw 'Unexpected download request boundary' }
    function New-PmOllamaDownloadStream { throw 'Unexpected download file boundary' }
    & $Body
    $script:Passed++
    Write-Host "PASS $Name"
}

$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Helper, [ref]$tokens, [ref]$parseErrors)
Assert-PmTest ($parseErrors.Count -eq 0) "PowerShell AST failed: $parseErrors"
foreach ($command in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Start-Process' }, $true)) {
    $parameters = @($command.CommandElements | Where-Object { $_ -is [Management.Automation.Language.CommandParameterAst] } | ForEach-Object { $_.ParameterName })
    Assert-PmTest (-not ($parameters -contains 'Wait')) 'Start-Process must not wait for tray descendants.'
    Assert-PmTest ($parameters -contains 'WindowStyle') 'Every process launch must declare its hidden window style.'
    Assert-PmTest ($command.Extent.Text -match '-WindowStyle Hidden') 'Every helper process must be hidden.'
}
Write-Host 'PASS PowerShell 5.1 AST and hidden immediate-process launch contract'

$downloadMocks = {
    param([byte[]]$Bytes, [long]$Total = -1, [int]$ReadSize = 3)
    $script:DownloadInput = [pscustomobject]@{ Bytes = $Bytes; Offset = 0; ReadSize = $ReadSize; Disposed = $false; Calls = 0; FailAt = 0 }
    $script:DownloadInput | Add-Member -MemberType ScriptMethod -Name Read -Value {
        param($Buffer, $Offset, $Count)
        $this.Calls++
        if ($this.FailAt -eq $this.Calls) { throw 'mock stream read failed' }
        Assert-PmTest ($Count -eq 65536 -and $Buffer.Length -eq 65536) 'Streaming buffer must remain bounded at 64 KiB.'
        $read = [Math]::Min($this.ReadSize, [Math]::Min($Count, $this.Bytes.Length - $this.Offset))
        [Array]::Copy($this.Bytes, $this.Offset, $Buffer, $Offset, $read)
        $this.Offset += $read
        return $read
    }
    $script:DownloadInput | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $this.Disposed = $true }
    $script:DownloadOutput = New-Object IO.MemoryStream
    $script:DownloadResponse = [pscustomobject]@{ ContentLength = $Total; Disposed = $false }
    $script:DownloadResponse | Add-Member -MemberType ScriptMethod -Name GetResponseStream -Value { return $script:DownloadInput }
    $script:DownloadResponse | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $this.Disposed = $true }
    $script:DownloadRequest = [pscustomobject]@{ Calls = 0 }
    $script:DownloadRequest | Add-Member -MemberType ScriptMethod -Name GetResponse -Value { $this.Calls++; return $script:DownloadResponse }
    function New-PmOllamaDownloadRequest {
        param($Uri)
        Assert-PmTest ($Uri -eq 'https://ollama.com/download/OllamaSetup.exe') 'Download must use the official fixed URL.'
        return $script:DownloadRequest
    }
    function New-PmOllamaDownloadStream {
        param($Path)
        Assert-PmTest ($Path -eq 'C:\Mock Download\OllamaSetup.exe') 'Download target changed.'
        return $script:DownloadOutput
    }
}

Invoke-PmCase 'suppress native PowerShell progress and bound connection and stalled reads' {
    Assert-PmTest ($ProgressPreference -eq 'SilentlyContinue') 'Native PowerShell progress must be suppressed.'
    $request = & $script:DownloadRequestFactory -Uri 'https://ollama.com/download/OllamaSetup.exe'
    Assert-PmTest ($request.Timeout -eq 30000 -and $request.ReadWriteTimeout -eq 120000) 'Connection and per-read timeouts must be finite without limiting the whole download.'
    Assert-PmTest $request.AllowAutoRedirect 'Official download redirects must be supported.'
    $request.Abort()
}

Invoke-PmCase 'stream repeated short reads exactly and dispose every resource' {
    $bytes = [byte[]](1, 2, 3, 4, 5, 6, 7, 8)
    . $downloadMocks -Bytes $bytes -Total $bytes.Length
    $script:ProgressMessages = @()
    function Write-Host { param($Object) $script:ProgressMessages += $Object }
    Invoke-PmOllamaDownload -InstallerPath 'C:\Mock Download\OllamaSetup.exe'
    Assert-PmTest (($script:DownloadOutput.ToArray() -join ',') -eq ($bytes -join ',')) 'Short reads lost or duplicated bytes.'
    Assert-PmTest ($script:DownloadInput.Calls -eq 4) 'Downloader did not continue through repeated short reads until EOF.'
    Assert-PmTest ($script:DownloadInput.Disposed -and $script:DownloadResponse.Disposed -and -not $script:DownloadOutput.CanWrite) 'Download resources were not disposed.'
    $records = @($script:ProgressMessages | Where-Object { $_.StartsWith('PM_OLLAMA_PROGRESS ') } | ForEach-Object { $_.Substring(19) | ConvertFrom-Json })
    Assert-PmTest ($records.Count -eq 3 -and $records[0].downloadedBytes -eq 0 -and $records[1].totalBytes -eq 8 -and $records[2].downloadedBytes -eq 8 -and $records[2].totalBytes -eq 8) 'Known-size progress must report actual byte totals and a final completed download.'
}

Invoke-PmCase 'stream unknown-length responses with newline progress no more than once per second' {
    . $downloadMocks -Bytes ([byte[]](1, 2, 3, 4, 5, 6)) -ReadSize 1
    $script:ProgressMessages = @()
    $script:TimerValues = @(400, 999, 1000, 400, 999, 1000)
    $script:ProgressTimer = [pscustomobject]@{ Reads = 0; Restarts = 0 }
    $script:ProgressTimer | Add-Member -MemberType ScriptProperty -Name ElapsedMilliseconds -Value { $value = $script:TimerValues[$this.Reads]; $this.Reads++; return $value }
    $script:ProgressTimer | Add-Member -MemberType ScriptMethod -Name Restart -Value { $this.Restarts++ }
    function New-PmOllamaProgressTimer { return $script:ProgressTimer }
    function Write-Host { param($Object) $script:ProgressMessages += $Object }
    Invoke-PmOllamaDownload -InstallerPath 'C:\Mock Download\OllamaSetup.exe'
    Assert-PmTest ($script:ProgressTimer.Restarts -eq 2) 'Progress was not throttled to one second.'
    $plain = @($script:ProgressMessages | Where-Object { -not $_.StartsWith('PM_OLLAMA_PROGRESS ') })
    $records = @($script:ProgressMessages | Where-Object { $_.StartsWith('PM_OLLAMA_PROGRESS ') } | ForEach-Object { $_.Substring(19) | ConvertFrom-Json })
    Assert-PmTest ($plain.Count -eq 3 -and $plain[0].StartsWith('Downloading Ollama:') -and $plain[2].Contains('download complete')) 'Expected throttled status lines and a final completion status.'
    Assert-PmTest (($records.downloadedBytes -join ',') -eq '0,3,6,6') 'Structured byte progress must use the same one-second throttle plus initial/final updates.'
    foreach ($record in $records) { Assert-PmTest ($record.PSObject.Properties.Name -notcontains 'totalBytes') 'Unknown size must not invent a total.' }
    Assert-PmTest ($script:DownloadOutput.ToArray().Length -eq 6) 'Unknown-length response did not stream all bytes.'
}

Invoke-PmCase 'structured stages omit download fields outside the download stage' {
    $script:ProgressMessages = @()
    function Write-Host { param($Object) $script:ProgressMessages += $Object }
    foreach ($stage in @('verify', 'install', 'start', 'ready')) {
        Write-PmOllamaProgress -Stage $stage -DownloadedBytes 10 -TotalBytes 20
    }
    $records = @($script:ProgressMessages | ForEach-Object { Assert-PmTest ($_.StartsWith('PM_OLLAMA_PROGRESS ')) 'Missing record prefix.'; $_.Substring(19) | ConvertFrom-Json })
    Assert-PmTest (($records.stage -join ',') -eq 'verify,install,start,ready') 'Stage contract changed.'
    foreach ($record in $records) { Assert-PmTest (@($record.PSObject.Properties.Name).Count -eq 1) 'Non-download stages must not retain stale byte fields.' }
}

foreach ($total in @(0, 2, 8)) {
    $script:WrongDownloadTotal = $total
    Invoke-PmCase 'reject both shorter and longer than advertised downloads before signature or execution' {
        . $downloadMocks -Bytes ([byte[]](1, 2, 3, 4)) -Total $script:WrongDownloadTotal
        Expect-PmFailure { Invoke-PmOllamaDownload -InstallerPath 'C:\Mock Download\OllamaSetup.exe' } 'download was incomplete'
        Assert-PmTest ($script:DownloadInput.Disposed -and $script:DownloadResponse.Disposed -and -not $script:DownloadOutput.CanWrite) 'Mismatched download leaked a resource.'
    }
}

Invoke-PmCase 'reject empty unknown-length downloads' {
    . $downloadMocks -Bytes ([byte[]]@())
    Expect-PmFailure { Invoke-PmOllamaDownload -InstallerPath 'C:\Mock Download\OllamaSetup.exe' } 'download was incomplete'
}

Invoke-PmCase 'dispose streams after a failed network read' {
    . $downloadMocks -Bytes ([byte[]](1, 2, 3, 4)) -Total 4
    $script:DownloadInput.FailAt = 2
    Expect-PmFailure { Invoke-PmOllamaDownload -InstallerPath 'C:\Mock Download\OllamaSetup.exe' } 'mock stream read failed'
    Assert-PmTest ($script:DownloadInput.Disposed -and $script:DownloadResponse.Disposed -and -not $script:DownloadOutput.CanWrite) 'Read failure leaked a resource.'
}

Invoke-PmCase 'dispose response and input after output creation fails' {
    . $downloadMocks -Bytes ([byte[]](1, 2, 3, 4)) -Total 4
    function New-PmOllamaDownloadStream { throw 'mock output creation failed' }
    Expect-PmFailure { Invoke-PmOllamaDownload -InstallerPath 'C:\Mock Download\OllamaSetup.exe' } 'mock output creation failed'
    Assert-PmTest ($script:DownloadInput.Disposed -and $script:DownloadResponse.Disposed) 'Output creation failure leaked network resources.'
    $script:DownloadOutput.Dispose()
}

Invoke-PmCase 'dispose all resources after a failed disk write' {
    . $downloadMocks -Bytes ([byte[]](1, 2, 3, 4)) -Total 4
    $script:DownloadOutput.Dispose()
    $script:DownloadOutput = [pscustomobject]@{ Disposed = $false }
    $script:DownloadOutput | Add-Member -MemberType ScriptMethod -Name Write -Value { throw 'mock disk write failed' }
    $script:DownloadOutput | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $this.Disposed = $true }
    Expect-PmFailure { Invoke-PmOllamaDownload -InstallerPath 'C:\Mock Download\OllamaSetup.exe' } 'mock disk write failed'
    Assert-PmTest ($script:DownloadInput.Disposed -and $script:DownloadResponse.Disposed -and $script:DownloadOutput.Disposed) 'Disk write failure leaked a resource.'
}

Invoke-PmCase 'find executable on PATH' {
    function Get-Command { [pscustomobject]@{ Source = 'C:\PM Fake Drive D\Custom Ollama\ollama.exe' } }
    function Test-Path { param($LiteralPath, $PathType) return $LiteralPath -eq 'C:\PM Fake Drive D\Custom Ollama\ollama.exe' }
    Assert-PmTest ((Get-PmOllamaExecutable) -eq 'C:\PM Fake Drive D\Custom Ollama\ollama.exe') 'PATH executable not discovered.'
}

Invoke-PmCase 'find per-user executable when PATH is stale' {
    function Get-Command { return $null }
    function Test-Path { param($LiteralPath, $PathType) return $LiteralPath -eq (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe') }
    Assert-PmTest ((Get-PmOllamaExecutable) -eq (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe')) 'Per-user executable not discovered.'
}

Invoke-PmCase 'reuse running installation and preserve model/host settings' {
    function Get-PmOllamaExecutable { return 'C:\PM Fake Drive D\Ollama\ollama.exe' }
    function Test-PmOllamaReady { return $true }
    $env:OLLAMA_HOST = '127.0.0.1:12345'
    $env:OLLAMA_MODELS = 'C:\PM Fake Drive D\Existing Models'
    Invoke-PmOllamaWindows -RequestedAction Install
    Assert-PmTest ($env:OLLAMA_HOST -eq '127.0.0.1:12345') 'OLLAMA_HOST changed.'
    Assert-PmTest ($env:OLLAMA_MODELS -eq 'C:\PM Fake Drive D\Existing Models') 'OLLAMA_MODELS changed.'
    Assert-PmTest ($env:PATH.StartsWith('C:\PM Fake Drive D\Ollama;')) 'Discovered executable was not added to the process PATH.'
}

Invoke-PmCase 'Start fails if absent without downloading' {
    function Get-PmOllamaExecutable { return $null }
    Expect-PmFailure { Invoke-PmOllamaWindows -RequestedAction Start } 'not installed'
}

Invoke-PmCase 'running API with undiscovered CLI is preserved without reinstall' {
    function Get-PmOllamaExecutable { return $null }
    function Test-PmOllamaReady { return $true }
    Expect-PmFailure { Invoke-PmOllamaWindows -RequestedAction Install } 'already running'
}

Invoke-PmCase 'start existing app without reinstall' {
    function Get-PmOllamaExecutable { return 'C:\PM Fake Drive D\Ollama\ollama.exe' }
    function Test-PmOllamaReady { return $false }
    function Test-Path { param($LiteralPath, $PathType) return $LiteralPath -eq 'C:\PM Fake Drive D\Ollama\ollama app.exe' }
    $script:Starts = @()
    function Start-Process {
        [CmdletBinding()] param($FilePath, $ArgumentList, $WindowStyle)
        $script:Starts += $FilePath
        Assert-PmTest ($WindowStyle -eq 'Hidden') 'App start not hidden.'
        Assert-PmTest ($ArgumentList.Count -eq 1 -and $ArgumentList[0] -eq 'hidden') 'App must receive its own hidden-start argument.'
    }
    Invoke-PmOllamaWindows -RequestedAction Install
    Assert-PmTest ($script:Starts.Count -eq 1 -and $script:Starts[0] -eq 'C:\PM Fake Drive D\Ollama\ollama app.exe') 'Did not start existing tray app.'
}

Invoke-PmCase 'fallback starts CLI serve without reinstall' {
    function Get-PmOllamaExecutable { return 'C:\PM Fake Drive D\Ollama\ollama.exe' }
    function Test-PmOllamaReady { return $false }
    function Test-Path { return $false }
    $script:Starts = 0
    function Start-Process {
        [CmdletBinding()] param($FilePath, $ArgumentList, $WindowStyle)
        $script:Starts++
        Assert-PmTest ($FilePath -eq 'C:\PM Fake Drive D\Ollama\ollama.exe') 'Wrong CLI started.'
        Assert-PmTest ($ArgumentList.Count -eq 1 -and $ArgumentList[0] -eq 'serve') 'Wrong fallback arguments.'
        Assert-PmTest ($WindowStyle -eq 'Hidden') 'CLI start not hidden.'
    }
    Invoke-PmOllamaWindows -RequestedAction Start
    Assert-PmTest ($script:Starts -eq 1) 'CLI start count wrong.'
}

Invoke-PmCase 'download verifies signature and waits only installer before reusing auto-started API' {
    $script:Discoveries = 0
    $script:Waits = 0
    $script:Cleanups = 0
    $script:Downloads = 0
    $script:ProgressStages = @()
    function Write-PmOllamaProgress { param($Stage, $DownloadedBytes, $TotalBytes) $script:ProgressStages += $Stage }
    function Get-PmOllamaExecutable { $script:Discoveries++; if ($script:Discoveries -gt 1) { return 'C:\PM Fake Drive D\Ollama\ollama.exe' }; return $null }
    function Test-PmOllamaReady { return $script:Discoveries -gt 1 }
    function New-PmOllamaDownloadDirectory { return 'C:\Temp\persistent-memory-ollama-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
    function New-PmOllamaHiddenStartMarker { return $null }
    function Remove-PmOllamaDownloadDirectory { param($Directory) $script:Cleanups++; Assert-PmTest ($Directory.EndsWith('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')) 'Wrong cleanup directory.' }
    function Invoke-PmOllamaDownload {
        [CmdletBinding()] param($InstallerPath)
        $script:Downloads++
        Write-PmOllamaProgress -Stage download
        Assert-PmTest ($InstallerPath.EndsWith('\OllamaSetup.exe')) 'Unexpected output filename.'
    }
    function Get-AuthenticodeSignature {
        Assert-PmTest ($script:ProgressStages[-1] -eq 'verify') 'Verification progress must precede certificate checking.'
        [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Subject = 'CN=Ollama Inc., O=Ollama Inc., C=US' } }
    }
    function Start-Process {
        [CmdletBinding()] param($FilePath, $ArgumentList, [switch]$PassThru, $WindowStyle)
        Assert-PmTest ($FilePath.EndsWith('\OllamaSetup.exe')) 'Unexpected process started.'
        Assert-PmTest (($ArgumentList -join ' ') -eq '/VERYSILENT /NORESTART /SUPPRESSMSGBOXES') 'Silent installation flags changed.'
        Assert-PmTest ($PassThru -and $WindowStyle -eq 'Hidden') 'Installer process options wrong.'
        Assert-PmTest ($script:ProgressStages[-1] -eq 'install') 'Installation progress must precede running the installer.'
        $process = [pscustomobject]@{ ExitCode = 0 }
        $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { $script:Waits++ }
        return $process
    }
    Invoke-PmOllamaWindows -RequestedAction Install
    Assert-PmTest ($script:Waits -eq 1 -and $script:Downloads -eq 1 -and $script:Cleanups -eq 1) 'Install stage counts wrong.'
    Assert-PmTest (($script:ProgressStages -join ',') -eq 'download,verify,install,ready,start,ready') 'Installation and readiness progress stages are out of order.'
}

foreach ($subject in @('CN=Untrusted, O=Other Inc., C=US', 'CN=Ollama Inc., O=Ollama Inc. Evil, C=US', 'CN=Ollama Inc., OU=Ollama Inc., C=US')) {
    $script:TestSubject = $subject
    Invoke-PmCase 'reject other signer organizations and clean download' {
        $script:Cleanups = 0
        function New-PmOllamaDownloadDirectory { return 'C:\Temp\persistent-memory-ollama-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
        function Remove-PmOllamaDownloadDirectory { param($Directory) $script:Cleanups++ }
        function Invoke-PmOllamaDownload { }
        function Get-AuthenticodeSignature { [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Subject = $script:TestSubject } } }
        Expect-PmFailure { Install-PmOllama } 'valid signature from Ollama Inc.'
        Assert-PmTest ($script:Cleanups -eq 1) 'Failed signature download not cleaned.'
    }
}

Invoke-PmCase 'reject invalid Authenticode status' {
    function New-PmOllamaDownloadDirectory { return 'C:\Temp\persistent-memory-ollama-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
    function Remove-PmOllamaDownloadDirectory { }
    function Invoke-PmOllamaDownload { }
    function Get-AuthenticodeSignature { [pscustomobject]@{ Status = 'HashMismatch'; SignerCertificate = [pscustomobject]@{ Subject = 'O=Ollama Inc.' } } }
    Expect-PmFailure { Install-PmOllama } 'valid signature from Ollama Inc.'
}

Invoke-PmCase 'clean temporary download when download fails' {
    $script:Cleanups = 0
    function New-PmOllamaDownloadDirectory { return 'C:\Temp\persistent-memory-ollama-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
    function Remove-PmOllamaDownloadDirectory { $script:Cleanups++ }
    function Invoke-PmOllamaDownload { throw 'mock download failed' }
    Expect-PmFailure { Install-PmOllama } 'mock download failed'
    Assert-PmTest ($script:Cleanups -eq 1) 'Download failure left temporary files.'
}

Invoke-PmCase 'health probe rewrites Docker host alias and uses supplied local port' {
    $env:PM_OLLAMA_URL = 'http://host.docker.internal:12345/'
    function Invoke-RestMethod {
        param($Uri, $Method, $TimeoutSec)
        Assert-PmTest ($Uri -eq 'http://localhost:12345/api/tags') 'Health URL not rewritten.'
        Assert-PmTest ($Method -eq 'Get' -and $TimeoutSec -eq 3) 'Health probe must be bounded and read-only.'
        return [pscustomobject]@{ models = @() }
    }
    Assert-PmTest (Test-PmOllamaReady) 'Healthy empty-model API was rejected.'
}

Invoke-PmCase 'cleanup refuses paths outside owned unique temp directory' {
    function Test-Path { throw 'Cleanup reached filesystem for an unowned path' }
    foreach ($path in @([IO.Path]::GetTempPath(), 'C:\', (Join-Path ([IO.Path]::GetTempPath()) 'ollama-other'), (Join-Path ([IO.Path]::GetTempPath()) '..\persistent-memory-ollama-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'))) {
        Expect-PmFailure { Remove-PmOllamaDownloadDirectory -Directory $path } 'outside the owned'
    }
}

Invoke-PmCase 'cleanup removes only validated owned directory via literal path' {
    $script:Removed = $null
    $directory = Join-Path ([IO.Path]::GetTempPath()) 'persistent-memory-ollama-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    function Test-Path { return $true }
    function Get-Item { [pscustomobject]@{ Attributes = [IO.FileAttributes]::Directory } }
    function Remove-Item {
        [CmdletBinding()] param($LiteralPath, [switch]$Recurse, [switch]$Force)
        $script:Removed = $LiteralPath
        Assert-PmTest ($Recurse -and $Force) 'Owned cleanup options wrong.'
    }
    Remove-PmOllamaDownloadDirectory -Directory $directory
    Assert-PmTest ($script:Removed -eq [IO.Path]::GetFullPath($directory)) 'Cleanup removed a different path.'
}

Invoke-PmCase 'cleanup refuses reparse-point redirection' {
    function Test-Path { return $true }
    function Get-Item { [pscustomobject]@{ Attributes = [IO.FileAttributes]::ReparsePoint } }
    function Remove-Item { throw 'Unexpected redirected removal' }
    Expect-PmFailure { Remove-PmOllamaDownloadDirectory -Directory (Join-Path ([IO.Path]::GetTempPath()) 'persistent-memory-ollama-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') } 'redirected'
}

Invoke-PmCase 'fresh download directory is unique and outside Ollama installer wildcard cleanup' {
    $script:Directories = @()
    function New-Item {
        [CmdletBinding()] param($ItemType, $Path)
        Assert-PmTest ($ItemType -eq 'Directory') 'Unexpected creation type.'
        $script:Directories += $Path
    }
    $first = New-PmOllamaDownloadDirectory
    $second = New-PmOllamaDownloadDirectory
    Assert-PmTest ($first -ne $second) 'Temporary download directory was reused.'
    Assert-PmTest ([IO.Path]::GetFileName($first) -match '^persistent-memory-ollama-[a-f0-9]{32}$') 'Unsafe temporary directory naming.'
    Assert-PmTest ([IO.Path]::GetDirectoryName($first) -eq [IO.Path]::GetTempPath().TrimEnd('\', '/')) 'Unexpected temporary parent.'
    Assert-PmTest ($script:Directories.Count -eq 2) 'Unexpected creation count.'
}

Invoke-PmCase 'preserve an existing hidden-start marker' {
    function Test-Path { return $true }
    Assert-PmTest ($null -eq (New-PmOllamaHiddenStartMarker)) 'Existing marker must not become installer-owned.'
}

Invoke-PmCase 'create official hidden-start marker without overwriting user files' {
    function Test-Path { return $false }
    $script:Created = @()
    function New-Item {
        [CmdletBinding()] param($ItemType, $Path)
        $script:Created += [pscustomobject]@{ Type = $ItemType; Path = $Path }
    }
    $marker = New-PmOllamaHiddenStartMarker
    Assert-PmTest ($marker -eq (Join-Path $env:LOCALAPPDATA 'Ollama\upgraded')) 'Wrong marker location.'
    Assert-PmTest ($script:Created.Count -eq 2 -and $script:Created[0].Type -eq 'Directory' -and $script:Created[1].Type -eq 'File') 'Wrong marker creation sequence.'
}

Invoke-PmCase 'installer failure cleans only the newly owned startup marker and download directory' {
    $script:MarkerCleanups = 0
    $script:DownloadCleanups = 0
    function New-PmOllamaDownloadDirectory { return 'C:\Temp\persistent-memory-ollama-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
    function Remove-PmOllamaDownloadDirectory { $script:DownloadCleanups++ }
    function New-PmOllamaHiddenStartMarker { return 'C:\Marker\upgraded' }
    function Remove-PmOllamaHiddenStartMarker { param($Marker) Assert-PmTest ($Marker -eq 'C:\Marker\upgraded') 'Wrong marker removed.'; $script:MarkerCleanups++ }
    function Invoke-PmOllamaDownload { }
    function Get-AuthenticodeSignature { [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Subject = 'O=Ollama Inc.' } } }
    function Start-Process {
        [CmdletBinding()] param($FilePath, $ArgumentList, [switch]$PassThru, $WindowStyle)
        $process = [pscustomobject]@{ ExitCode = 7 }
        $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { }
        return $process
    }
    Expect-PmFailure { Install-PmOllama } 'exited with code 7'
    Assert-PmTest ($script:MarkerCleanups -eq 1 -and $script:DownloadCleanups -eq 1) 'Failure cleanup did not run.'
}

Invoke-PmCase 'modified or redirected marker is preserved on cleanup' {
    function Test-Path { return $true }
    function Get-Item { [pscustomobject]@{ Length = 12; Attributes = [IO.FileAttributes]::Normal } }
    Remove-PmOllamaHiddenStartMarker -Marker (Join-Path $env:LOCALAPPDATA 'Ollama\upgraded')
    function Get-Item { [pscustomobject]@{ Length = 0; Attributes = [IO.FileAttributes]::ReparsePoint } }
    Remove-PmOllamaHiddenStartMarker -Marker (Join-Path $env:LOCALAPPDATA 'Ollama\upgraded')
}

Invoke-PmCase 'only the empty owned marker can be removed' {
    $script:Removed = $null
    function Test-Path { return $true }
    function Get-Item { [pscustomobject]@{ Length = 0; Attributes = [IO.FileAttributes]::Normal } }
    function Remove-Item {
        [CmdletBinding()] param($LiteralPath, [switch]$Force)
        $script:Removed = $LiteralPath
    }
    $expected = Join-Path $env:LOCALAPPDATA 'Ollama\upgraded'
    Remove-PmOllamaHiddenStartMarker -Marker $expected
    Assert-PmTest ($script:Removed -eq $expected) 'Marker cleanup used a different target.'
    Expect-PmFailure { Remove-PmOllamaHiddenStartMarker -Marker 'C:\Unowned\upgraded' } 'unowned'
}

Invoke-PmCase 'fresh-install pre-poll stops when the asynchronously launched API becomes ready' {
    $script:Probes = 0
    $script:Pauses = 0
    function Test-PmOllamaReady { $script:Probes++; return $script:Probes -ge 3 }
    function Start-Sleep { param($Milliseconds) Assert-PmTest ($Milliseconds -eq 500) 'Wrong polling delay.'; $script:Pauses++ }
    Assert-PmTest (Wait-PmOllamaAutoStart) 'Delayed API readiness not detected.'
    Assert-PmTest ($script:Probes -eq 3 -and $script:Pauses -eq 2) 'Pre-poll did not stop on readiness.'
}

Invoke-PmCase 'fresh-install pre-poll has a finite attempt budget' {
    $script:Probes = 0
    $script:Pauses = 0
    function Test-PmOllamaReady { $script:Probes++; return $false }
    function Start-Sleep { $script:Pauses++ }
    Assert-PmTest (-not (Wait-PmOllamaAutoStart)) 'Unavailable API reported ready.'
    Assert-PmTest ($script:Probes -eq 10 -and $script:Pauses -eq 9) 'Pre-poll attempt budget changed.'
}

Invoke-PmCase 'reuse a tray process that is still starting its API' {
    function Get-PmOllamaExecutable { return 'C:\PM Fake Drive D\Ollama\ollama.exe' }
    function Test-PmOllamaReady { return $false }
    function Test-Path { return $true }
    function Get-Process { [pscustomobject]@{ Path = 'C:\PM Fake Drive D\Ollama\ollama app.exe' } }
    Invoke-PmOllamaWindows -RequestedAction Start
}

Write-Host "Completed $script:Passed mocked behavior cases and AST validation; no real download, installation, startup, or cleanup performed."
