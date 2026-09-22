param(
  [switch]$NoBrowser,
  [switch]$ExitAfterReady,
  [switch]$SkipPrepare,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repoRoot = $PSScriptRoot
$ragRoot = Join-Path $repoRoot 'rag'
$runtimeRoot = Join-Path $ragRoot '.runtime'
$startedProcesses = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$launcherExitCode = 0

function Write-Step {
  param([int]$Number, [string]$Message)
  Write-Host "[$Number/7] $Message" -ForegroundColor Cyan
}

function Update-ProcessPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $current = [Environment]::GetEnvironmentVariable('Path', 'Process')
  $env:Path = (@($current, $machine, $user) | Where-Object { $_ }) -join ';'
}

function Find-Application {
  param([string]$Name, [string[]]$KnownPaths = @())
  $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command -and $command.Source) { return $command.Source }
  foreach ($candidate in $KnownPaths) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
  }
  return $null
}

function Get-Winget {
  return Find-Application 'winget.exe' @(
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe')
  )
}

function Install-WingetPackage {
  param(
    [Parameter(Mandatory)][string]$Id,
    [Parameter(Mandatory)][string]$DisplayName,
    [switch]$Upgrade
  )
  if ($SkipInstall) { throw "$DisplayName is missing and automatic installation is disabled (-SkipInstall)." }
  $winget = Get-Winget
  if (-not $winget) {
    throw "$DisplayName is not installed and winget was not found. Install 'App Installer' from the Microsoft Store, then run START-RAG.cmd again."
  }
  $verb = if ($Upgrade) { 'upgrade' } else { 'install' }
  Write-Host "      Installing $DisplayName with winget..." -ForegroundColor Yellow
  & $winget $verb --id $Id --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "winget could not install $DisplayName (exit code $LASTEXITCODE)." }
  Update-ProcessPath
}

function Get-ProjectSetting {
  param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][string]$Default)
  $processValue = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if (-not [string]::IsNullOrWhiteSpace($processValue)) { return $processValue.Trim() }
  foreach ($fileName in @('.env', '.env.example')) {
    $file = Join-Path $ragRoot $fileName
    if (-not (Test-Path -LiteralPath $file)) { continue }
    foreach ($line in Get-Content -LiteralPath $file) {
      if ($line -match ('^\s*' + [regex]::Escape($Name) + '\s*=\s*(.*)$')) {
        return $Matches[1].Trim().Trim('"').Trim("'")
      }
    }
  }
  return $Default
}

function Test-Endpoint {
  param([Parameter(Mandatory)][string]$Uri)
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 3
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch { return $false }
}

function Wait-Endpoint {
  param(
    [Parameter(Mandatory)][string]$Uri,
    [Parameter(Mandatory)][string]$Service,
    [int]$Seconds = 30,
    [System.Diagnostics.Process]$Process
  )
  $limit = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $limit) {
    if (Test-Endpoint $Uri) { return }
    if ($Process -and $Process.HasExited) { throw "$Service stopped during startup (exit code $($Process.ExitCode))." }
    Start-Sleep -Milliseconds 500
  }
  throw "$Service did not respond at $Uri after $Seconds seconds."
}

function Start-TrackedProcess {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [string[]]$ArgumentList = @(),
    [Parameter(Mandatory)][string]$WorkingDirectory
  )
  $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru
  [void]$startedProcesses.Add($process)
  return $process
}

function Stop-StartedProcesses {
  for ($index = $startedProcesses.Count - 1; $index -ge 0; $index--) {
    $process = $startedProcesses[$index]
    try {
      if (-not $process.HasExited) { Stop-Process -Id $process.Id -ErrorAction Stop }
    } catch { Write-Host "Warning while stopping process $($process.Id): $($_.Exception.Message)" -ForegroundColor Yellow }
  }
}

function Ensure-Node {
  $known = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
  )
  $node = Find-Application 'node.exe' $known
  $valid = $false
  if ($node) {
    $rawVersion = (& $node --version 2>$null | Select-Object -First 1)
    if ($rawVersion -match '^v(\d+)\.(\d+)\.') {
      $major = [int]$Matches[1]
      $minor = [int]$Matches[2]
      $valid = $major -gt 22 -or ($major -eq 22 -and $minor -ge 18)
    }
  }
  if (-not $valid) {
    Install-WingetPackage -Id 'OpenJS.NodeJS.LTS' -DisplayName 'Node.js LTS' -Upgrade:([bool]$node)
    $node = Find-Application 'node.exe' $known
  }
  if (-not $node) { throw 'Node.js was installed, but node.exe was not found. Restart Windows and try again.' }
  $rawVersion = (& $node --version 2>$null | Select-Object -First 1)
  if ($rawVersion -notmatch '^v(\d+)\.(\d+)\.' -or [int]$Matches[1] -lt 22) {
    throw "Node.js 22.18 or later is required; found $rawVersion."
  }
  $npm = Find-Application 'npm.cmd' @((Join-Path (Split-Path -Parent $node) 'npm.cmd'))
  if (-not $npm) { throw 'Node.js is installed, but npm.cmd was not found.' }
  return @{ Node = $node; Npm = $npm; Version = $rawVersion }
}

function Ensure-NodeDependencies {
  param([Parameter(Mandatory)][string]$Npm)
  $lockFile = Join-Path $repoRoot 'package-lock.json'
  $markerFile = Join-Path $repoRoot 'node_modules\.ragen-lock.sha256'
  $lockHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $lockFile).Hash
  $installedHash = if (Test-Path -LiteralPath $markerFile) { (Get-Content -LiteralPath $markerFile -Raw).Trim() } else { '' }
  $honoModule = Join-Path $repoRoot 'node_modules\hono\package.json'
  $chromaModule = Join-Path $repoRoot 'node_modules\chromadb\package.json'
  if ($installedHash -eq $lockHash -and (Test-Path -LiteralPath $honoModule) -and (Test-Path -LiteralPath $chromaModule)) {
    Write-Host '      npm dependencies are already prepared.' -ForegroundColor DarkGreen
    return
  }
  if ($SkipInstall) { throw 'npm dependencies are missing and automatic installation is disabled (-SkipInstall).' }
  Write-Host '      Installing npm dependencies verified by package-lock.json...' -ForegroundColor Yellow
  Push-Location $repoRoot
  try {
    & $Npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
    Set-Content -LiteralPath $markerFile -Value $lockHash -Encoding ASCII
  } finally { Pop-Location }
  Write-Host '      npm dependencies installed.' -ForegroundColor Green
}

function Ensure-ChromaRuntime {
  $chromaVersion = 'cli-1.4.4'
  $expectedHash = '8697d3f5f55c4f982c6e114ac01cf006daa0c68d87e791d9b5558b8670f89d05'
  $downloadUrl = "https://github.com/chroma-core/chroma/releases/download/$chromaVersion/chroma-windows.exe"
  $chromaRoot = Join-Path $runtimeRoot 'chroma'
  $chroma = Join-Path $chromaRoot 'chroma-windows.exe'

  if (Test-Path -LiteralPath $chroma -PathType Leaf) {
    $installedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $chroma).Hash.ToLowerInvariant()
    if ($installedHash -eq $expectedHash) { return $chroma }
  }
  if ($SkipInstall) { throw 'The local Chroma runtime is not ready and automatic installation is disabled (-SkipInstall).' }

  Write-Host "      Downloading Chroma $chromaVersion from GitHub..." -ForegroundColor Yellow
  New-Item -ItemType Directory -Force -Path $chromaRoot | Out-Null
  $temporaryFile = Join-Path $chromaRoot ("chroma-windows.exe.download-" + [guid]::NewGuid().ToString('N'))
  try {
    Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $temporaryFile
    $downloadedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $temporaryFile).Hash.ToLowerInvariant()
    if ($downloadedHash -ne $expectedHash) {
      throw "The Chroma download does not match the expected SHA-256. Expected: $expectedHash; received: $downloadedHash."
    }
    Move-Item -LiteralPath $temporaryFile -Destination $chroma -Force
  } finally {
    if (Test-Path -LiteralPath $temporaryFile) { Remove-Item -LiteralPath $temporaryFile -Force }
  }
  Write-Host '      Chroma downloaded and verified.' -ForegroundColor Green
  return $chroma
}

function Ensure-Ollama {
  param([Parameter(Mandatory)][string]$OllamaUrl)
  $known = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'),
    (Join-Path $env:ProgramFiles 'Ollama\ollama.exe')
  )
  $ollama = Find-Application 'ollama.exe' $known
  if (-not $ollama -and -not (Test-Endpoint "$OllamaUrl/api/tags")) {
    Install-WingetPackage -Id 'Ollama.Ollama' -DisplayName 'Ollama'
    $ollama = Find-Application 'ollama.exe' $known
  }
  if (-not (Test-Endpoint "$OllamaUrl/api/tags")) {
    if (-not $ollama) { throw 'Ollama was installed, but ollama.exe was not found. Restart Windows and try again.' }
    $process = Start-TrackedProcess -FilePath $ollama -ArgumentList @('serve') -WorkingDirectory $ragRoot
    Wait-Endpoint -Uri "$OllamaUrl/api/tags" -Service 'Ollama' -Seconds 45 -Process $process
    Write-Host '      Ollama started.' -ForegroundColor Green
  } else { Write-Host '      Ollama is already available.' -ForegroundColor DarkGreen }
  if (-not $ollama) { $ollama = Find-Application 'ollama.exe' $known }
  if (-not $ollama) { throw 'Ollama is responding, but ollama.exe was not found to check the models.' }
  return $ollama
}

function Ensure-OllamaModel {
  param(
    [Parameter(Mandatory)][string]$Ollama,
    [Parameter(Mandatory)][string]$OllamaUrl,
    [Parameter(Mandatory)][string]$Model
  )
  $installed = $false
  try {
    $payload = @{ model = $Model } | ConvertTo-Json -Compress
    Invoke-RestMethod -Method Post -Uri "$OllamaUrl/api/show" -ContentType 'application/json' -Body $payload -TimeoutSec 10 | Out-Null
    $installed = $true
  } catch { $installed = $false }
  if ($installed) {
    Write-Host "      Model available: $Model" -ForegroundColor DarkGreen
    return
  }
  if ($SkipInstall) { throw "Model $Model is missing and automatic installation is disabled (-SkipInstall)." }
  Write-Host "      Downloading model $Model (this may take several minutes)..." -ForegroundColor Yellow
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $Ollama pull $Model
    $pullExitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousPreference }
  if ($pullExitCode -ne 0) { throw "Could not download model $Model (exit code $pullExitCode)." }
}

function Ensure-QwenTokenizer {
  param([Parameter(Mandatory)][string]$Node)
  $tokenizerRoot = Join-Path $ragRoot 'output\tokenizer-qwen3.5'
  $required = @('tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja', 'provenance.json')
  $missing = $required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $tokenizerRoot $_) -PathType Leaf) }
  if (-not $missing) {
    Write-Host '      Qwen tokenizer available.' -ForegroundColor DarkGreen
    return
  }
  if ($SkipInstall) { throw 'The Qwen tokenizer is missing and automatic installation is disabled (-SkipInstall).' }
  Write-Host '      Downloading the compatible Qwen tokenizer...' -ForegroundColor Yellow
  Push-Location $ragRoot
  try {
    & $Node 'src/setupRag.ts' '--tokenizer-only'
    if ($LASTEXITCODE -ne 0) { throw "Could not install the tokenizer (exit code $LASTEXITCODE)." }
  } finally { Pop-Location }
  foreach ($file in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $tokenizerRoot $file) -PathType Leaf)) {
      throw "The tokenizer download did not create $file."
    }
  }
}

function Ensure-DocumentCorpus {
  $configuredDocs = Get-ProjectSetting 'DOCS_DIR' './docs'
  $docsRoot = if ([System.IO.Path]::IsPathRooted($configuredDocs)) {
    [System.IO.Path]::GetFullPath($configuredDocs)
  } else {
    [System.IO.Path]::GetFullPath((Join-Path $ragRoot $configuredDocs))
  }
  New-Item -ItemType Directory -Force -Path $docsRoot | Out-Null
  $extensions = @('.md', '.mdx', '.markdown', '.txt', '.html', '.htm', '.pdf')
  $documents = Get-ChildItem -LiteralPath $docsRoot -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $extensions -contains $_.Extension.ToLowerInvariant() } |
    Select-Object -First 1
  if ($documents) { return }
  $welcome = @'
# Welcome to RAGen

This starter document confirms that the installation is working correctly.

To use your own documents, open the folder from the chat's **Documents** button, add
supported files, and select **Regenerate RAG**. You can remove this file afterward.
'@
  Set-Content -LiteralPath (Join-Path $docsRoot 'GET-STARTED.md') -Value $welcome -Encoding UTF8
  Write-Host "      Created $docsRoot\GET-STARTED.md because the document folder was empty." -ForegroundColor Yellow
}

try {
  if (-not (Test-Path -LiteralPath (Join-Path $ragRoot 'package.json'))) { throw 'The rag/ project was not found.' }
  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'hono-chat\server.ts'))) { throw 'The hono-chat/ project was not found.' }

  Write-Host ''
  Write-Host 'RAGen - automatic setup and startup' -ForegroundColor White
  Write-Host 'The first run can take a while because of downloads.' -ForegroundColor DarkGray
  Write-Host ''

  Write-Step 1 'Checking Node.js and npm...'
  $nodeRuntime = Ensure-Node
  Write-Host "      Node.js $($nodeRuntime.Version)" -ForegroundColor DarkGreen

  Write-Step 2 'Checking project dependencies...'
  Ensure-NodeDependencies -Npm $nodeRuntime.Npm

  $ollamaUrl = (Get-ProjectSetting 'OLLAMA_URL' 'http://127.0.0.1:11434').TrimEnd('/')
  try { $ollamaUri = [System.Uri]$ollamaUrl }
  catch { throw 'OLLAMA_URL must be a valid local HTTP URL.' }
  if ($ollamaUri.Scheme -notin @('http', 'https') -or $ollamaUri.Host.ToLowerInvariant() -notin @('localhost', '127.0.0.1', '::1')) {
    throw 'OLLAMA_URL must point to localhost or a loopback address.'
  }
  Write-Step 3 'Checking Ollama and local models...'
  $ollama = Ensure-Ollama -OllamaUrl $ollamaUrl
  $chatModel = Get-ProjectSetting 'RAG_CHAT_MODEL' 'qwen3.5:4b-q4_K_M'
  $embedModel = Get-ProjectSetting 'OLLAMA_EMBED_MODEL' 'embeddinggemma'
  Ensure-OllamaModel -Ollama $ollama -OllamaUrl $ollamaUrl -Model $chatModel
  if ($embedModel.ToLowerInvariant() -ne $chatModel.ToLowerInvariant()) {
    Ensure-OllamaModel -Ollama $ollama -OllamaUrl $ollamaUrl -Model $embedModel
  }
  Ensure-QwenTokenizer -Node $nodeRuntime.Node

  Write-Step 4 'Checking the Chroma server...'
  $chromaHost = Get-ProjectSetting 'CHROMA_HOST' 'localhost'
  $chromaPort = [int](Get-ProjectSetting 'CHROMA_PORT' '8000')
  if ($chromaHost.ToLowerInvariant() -notin @('localhost', '127.0.0.1')) {
    throw 'CHROMA_HOST must be localhost or 127.0.0.1. This application does not allow Chroma to be exposed to the network.'
  }
  $chromaUrl = "http://${chromaHost}:$chromaPort"
  if (-not (Test-Endpoint "$chromaUrl/api/v2/heartbeat")) {
    $chroma = Ensure-ChromaRuntime
    $chromaData = Join-Path $ragRoot '.chroma'
    $chromaProcess = Start-TrackedProcess -FilePath $chroma -ArgumentList @('run', '--path', "`"$chromaData`"", '--host', $chromaHost, '--port', "$chromaPort") -WorkingDirectory $ragRoot
    Wait-Endpoint -Uri "$chromaUrl/api/v2/heartbeat" -Service 'Chroma' -Seconds 60 -Process $chromaProcess
    Write-Host '      Chroma Rust started on loopback.' -ForegroundColor Green
  } else { Write-Host '      Chroma is already available.' -ForegroundColor DarkGreen }

  Write-Step 5 'Validating the RAG index...'
  Ensure-DocumentCorpus
  if ($SkipPrepare) { Write-Host '      Preparation skipped by parameter.' -ForegroundColor Yellow }
  else {
    Push-Location $ragRoot
    try {
      $previousPreference = $ErrorActionPreference
      try {
        $ErrorActionPreference = 'Continue'
        $readyOutput = & $nodeRuntime.Node 'src/checkReady.ts' 2>&1
        $indexExitCode = $LASTEXITCODE
      } finally { $ErrorActionPreference = $previousPreference }
      $indexReady = $indexExitCode -eq 0
      if ($indexReady) {
        $summary = $readyOutput | Select-Object -Last 1
        Write-Host "      Index and collection verified: $summary" -ForegroundColor DarkGreen
      } else {
        Write-Host '      The index is missing or does not match Chroma; preparing it now...' -ForegroundColor Yellow
        & $nodeRuntime.Node 'src/prepareRag.ts'
        if ($LASTEXITCODE -ne 0) { throw "RAG preparation failed with exit code $LASTEXITCODE." }
        & $nodeRuntime.Node 'src/checkReady.ts'
        if ($LASTEXITCODE -ne 0) { throw 'The index was created, but it did not pass the final check.' }
        Write-Host '      Index prepared and verified.' -ForegroundColor Green
      }
    } finally { Pop-Location }
  }

  $uiHost = Get-ProjectSetting 'RAG_UI_HOST' '127.0.0.1'
  $uiPort = [int](Get-ProjectSetting 'RAG_UI_PORT' '8787')
  $browserHost = if ($uiHost -in @('0.0.0.0', '::')) { '127.0.0.1' } else { $uiHost }
  $uiUrl = "http://${browserHost}:$uiPort"
  $env:RAG_UI_HOST = $uiHost
  $env:RAG_UI_PORT = "$uiPort"
  Write-Step 6 'Starting Hono Chat...'
  if (-not (Test-Endpoint "$uiUrl/api/health")) {
    $honoEntry = Join-Path $repoRoot 'hono-chat\server.ts'
    $honoProcess = Start-TrackedProcess -FilePath $nodeRuntime.Node -ArgumentList @("`"$honoEntry`"") -WorkingDirectory $repoRoot
    Wait-Endpoint -Uri "$uiUrl/api/health" -Service 'Hono Chat' -Seconds 30 -Process $honoProcess
    Write-Host '      Hono Chat started.' -ForegroundColor Green
  } else { Write-Host '      Hono Chat is already available.' -ForegroundColor DarkGreen }

  Write-Step 7 'RAGen is ready.'
  Write-Host "      $uiUrl" -ForegroundColor Green
  if (-not $NoBrowser) { Start-Process $uiUrl }

  if (-not $ExitAfterReady) {
    Write-Host ''
    Read-Host 'Press Enter to stop the services started by this launcher'
  }
} catch {
  Write-Host ''
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Fix the problem shown above, then run START-RAG.cmd again.' -ForegroundColor Yellow
  $launcherExitCode = 1
} finally {
  try { Stop-StartedProcesses }
  catch { Write-Host "Warning during cleanup: $($_.Exception.Message)" -ForegroundColor Yellow }
}

exit $launcherExitCode
