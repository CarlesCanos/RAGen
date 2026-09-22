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
  if ($SkipInstall) { throw "$DisplayName falta y la instalacion automatica esta desactivada (-SkipInstall)." }
  $winget = Get-Winget
  if (-not $winget) {
    throw "$DisplayName no esta instalado y no se encontro winget. Instala 'App Installer' desde Microsoft Store y vuelve a pulsar START-RAG.cmd."
  }
  $verb = if ($Upgrade) { 'upgrade' } else { 'install' }
  Write-Host "      Instalando $DisplayName mediante winget..." -ForegroundColor Yellow
  & $winget $verb --id $Id --exact --silent --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "winget no pudo instalar $DisplayName (codigo $LASTEXITCODE)." }
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
    if ($Process -and $Process.HasExited) { throw "$Service termino durante el arranque (codigo $($Process.ExitCode))." }
    Start-Sleep -Milliseconds 500
  }
  throw "$Service no respondio en $Uri despues de $Seconds segundos."
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
    } catch { Write-Host "Aviso al detener el proceso $($process.Id): $($_.Exception.Message)" -ForegroundColor Yellow }
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
  if (-not $node) { throw 'Node.js se instalo, pero node.exe no se encuentra. Reinicia Windows y vuelve a intentarlo.' }
  $rawVersion = (& $node --version 2>$null | Select-Object -First 1)
  if ($rawVersion -notmatch '^v(\d+)\.(\d+)\.' -or [int]$Matches[1] -lt 22) {
    throw "Se necesita Node.js 22.18 o posterior; se encontro $rawVersion."
  }
  $npm = Find-Application 'npm.cmd' @((Join-Path (Split-Path -Parent $node) 'npm.cmd'))
  if (-not $npm) { throw 'Node.js esta presente, pero no se encuentra npm.cmd.' }
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
    Write-Host '      Dependencias npm ya preparadas.' -ForegroundColor DarkGreen
    return
  }
  if ($SkipInstall) { throw 'Faltan dependencias npm y la instalacion automatica esta desactivada (-SkipInstall).' }
  Write-Host '      Instalando dependencias npm verificadas por package-lock.json...' -ForegroundColor Yellow
  Push-Location $repoRoot
  try {
    & $Npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci termino con codigo $LASTEXITCODE." }
    Set-Content -LiteralPath $markerFile -Value $lockHash -Encoding ASCII
  } finally { Pop-Location }
  Write-Host '      Dependencias npm instaladas.' -ForegroundColor Green
}

function Find-Python {
  $known = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python310\python.exe'),
    (Join-Path $env:ProgramFiles 'Python312\python.exe')
  )
  $candidates = @((Find-Application 'python.exe' $known)) + $known
  foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $version = (& $candidate --version 2>&1 | Select-Object -First 1)
    if ($LASTEXITCODE -eq 0 -and $version -match '^Python (\d+)\.(\d+)') {
      if ([int]$Matches[1] -eq 3 -and [int]$Matches[2] -ge 10 -and [int]$Matches[2] -le 12) { return $candidate }
    }
  }
  return $null
}

function Ensure-ChromaRuntime {
  $venvRoot = Join-Path $runtimeRoot 'chroma-venv'
  $venvPython = Join-Path $venvRoot 'Scripts\python.exe'
  $chroma = Join-Path $venvRoot 'Scripts\chroma.exe'
  $requirements = Join-Path $ragRoot 'requirements-chroma.lock.txt'
  $marker = Join-Path $venvRoot '.requirements.sha256'
  $requirementsHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $requirements).Hash
  $installedHash = if (Test-Path -LiteralPath $marker) { (Get-Content -LiteralPath $marker -Raw).Trim() } else { '' }
  if ((Test-Path -LiteralPath $venvPython) -and (Test-Path -LiteralPath $chroma) -and $installedHash -eq $requirementsHash) {
    return $chroma
  }
  if ($SkipInstall) { throw 'El runtime local de Chroma no esta preparado y la instalacion automatica esta desactivada (-SkipInstall).' }
  $python = Find-Python
  if (-not $python) {
    Install-WingetPackage -Id 'Python.Python.3.12' -DisplayName 'Python 3.12'
    $python = Find-Python
  }
  if (-not $python) { throw 'Python se instalo, pero python.exe no se encuentra. Reinicia Windows y vuelve a intentarlo.' }
  if (-not (Test-Path -LiteralPath $venvPython)) {
    Write-Host '      Creando el entorno Python privado de Chroma...' -ForegroundColor Yellow
    New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
    & $python -m venv $venvRoot | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "No se pudo crear el entorno virtual de Chroma (codigo $LASTEXITCODE)." }
  }
  Write-Host '      Instalando Chroma en el entorno privado del proyecto...' -ForegroundColor Yellow
  & $venvPython -m pip install --disable-pip-version-check --no-input --require-hashes -r $requirements | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "No se pudo instalar Chroma (codigo $LASTEXITCODE)." }
  Set-Content -LiteralPath $marker -Value $requirementsHash -Encoding ASCII
  if (-not (Test-Path -LiteralPath $chroma)) { throw 'Chroma se instalo, pero no se genero chroma.exe.' }
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
    if (-not $ollama) { throw 'Ollama se instalo, pero ollama.exe no se encuentra. Reinicia Windows y vuelve a intentarlo.' }
    $process = Start-TrackedProcess -FilePath $ollama -ArgumentList @('serve') -WorkingDirectory $ragRoot
    Wait-Endpoint -Uri "$OllamaUrl/api/tags" -Service 'Ollama' -Seconds 45 -Process $process
    Write-Host '      Ollama iniciado.' -ForegroundColor Green
  } else { Write-Host '      Ollama ya estaba disponible.' -ForegroundColor DarkGreen }
  if (-not $ollama) { $ollama = Find-Application 'ollama.exe' $known }
  if (-not $ollama) { throw 'Ollama responde, pero no se encuentra ollama.exe para comprobar los modelos.' }
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
    Write-Host "      Modelo disponible: $Model" -ForegroundColor DarkGreen
    return
  }
  if ($SkipInstall) { throw "Falta el modelo $Model y la instalacion automatica esta desactivada (-SkipInstall)." }
  Write-Host "      Descargando el modelo $Model (puede tardar varios minutos)..." -ForegroundColor Yellow
  $previousPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $Ollama pull $Model
    $pullExitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousPreference }
  if ($pullExitCode -ne 0) { throw "No se pudo descargar el modelo $Model (codigo $pullExitCode)." }
}

function Ensure-QwenTokenizer {
  param([Parameter(Mandatory)][string]$Node)
  $tokenizerRoot = Join-Path $ragRoot 'output\tokenizer-qwen3.5'
  $required = @('tokenizer.json', 'tokenizer_config.json', 'chat_template.jinja', 'provenance.json')
  $missing = $required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $tokenizerRoot $_) -PathType Leaf) }
  if (-not $missing) {
    Write-Host '      Tokenizer de Qwen disponible.' -ForegroundColor DarkGreen
    return
  }
  if ($SkipInstall) { throw 'Falta el tokenizer de Qwen y la instalacion automatica esta desactivada (-SkipInstall).' }
  Write-Host '      Descargando el tokenizer compatible de Qwen...' -ForegroundColor Yellow
  Push-Location $ragRoot
  try {
    & $Node 'src/setupRag.ts' '--tokenizer-only'
    if ($LASTEXITCODE -ne 0) { throw "No se pudo instalar el tokenizer (codigo $LASTEXITCODE)." }
  } finally { Pop-Location }
  foreach ($file in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $tokenizerRoot $file) -PathType Leaf)) {
      throw "La descarga del tokenizer no genero $file."
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
# Bienvenido a Local RAG

Este documento inicial confirma que la instalacion funciona correctamente.

Para usar tus propios documentos, abre la carpeta desde el boton **Documentos** del chat,
anade archivos compatibles y pulsa **Regenerar RAG**. Puedes eliminar este archivo despues.
'@
  Set-Content -LiteralPath (Join-Path $docsRoot 'EMPIEZA-AQUI.md') -Value $welcome -Encoding UTF8
  Write-Host "      Se creo $docsRoot\EMPIEZA-AQUI.md porque el corpus estaba vacio." -ForegroundColor Yellow
}

try {
  if (-not (Test-Path -LiteralPath (Join-Path $ragRoot 'package.json'))) { throw 'No se encuentra el proyecto rag/.' }
  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'hono-chat\server.ts'))) { throw 'No se encuentra el proyecto hono-chat/.' }

  Write-Host ''
  Write-Host 'Local RAG - instalacion y arranque automaticos' -ForegroundColor White
  Write-Host 'La primera ejecucion puede tardar por las descargas.' -ForegroundColor DarkGray
  Write-Host ''

  Write-Step 1 'Comprobando Node.js y npm...'
  $nodeRuntime = Ensure-Node
  Write-Host "      Node.js $($nodeRuntime.Version)" -ForegroundColor DarkGreen

  Write-Step 2 'Comprobando dependencias del proyecto...'
  Ensure-NodeDependencies -Npm $nodeRuntime.Npm

  $ollamaUrl = (Get-ProjectSetting 'OLLAMA_URL' 'http://127.0.0.1:11434').TrimEnd('/')
  try { $ollamaUri = [System.Uri]$ollamaUrl }
  catch { throw 'OLLAMA_URL debe ser una URL HTTP local válida.' }
  if ($ollamaUri.Scheme -notin @('http', 'https') -or $ollamaUri.Host.ToLowerInvariant() -notin @('localhost', '127.0.0.1', '::1')) {
    throw 'OLLAMA_URL debe apuntar a localhost o a una dirección de loopback.'
  }
  Write-Step 3 'Comprobando Ollama y los modelos locales...'
  $ollama = Ensure-Ollama -OllamaUrl $ollamaUrl
  $chatModel = Get-ProjectSetting 'RAG_CHAT_MODEL' 'qwen3.5:4b-q4_K_M'
  $embedModel = Get-ProjectSetting 'OLLAMA_EMBED_MODEL' 'embeddinggemma'
  Ensure-OllamaModel -Ollama $ollama -OllamaUrl $ollamaUrl -Model $chatModel
  if ($embedModel.ToLowerInvariant() -ne $chatModel.ToLowerInvariant()) {
    Ensure-OllamaModel -Ollama $ollama -OllamaUrl $ollamaUrl -Model $embedModel
  }
  Ensure-QwenTokenizer -Node $nodeRuntime.Node

  Write-Step 4 'Comprobando el servidor Chroma...'
  $chromaHost = Get-ProjectSetting 'CHROMA_HOST' 'localhost'
  $chromaPort = [int](Get-ProjectSetting 'CHROMA_PORT' '8000')
  if ($chromaHost.ToLowerInvariant() -notin @('localhost', '127.0.0.1')) {
    throw 'CHROMA_HOST debe ser localhost o 127.0.0.1. Esta aplicacion no permite exponer Chroma a la red.'
  }
  $chromaUrl = "http://${chromaHost}:$chromaPort"
  if (-not (Test-Endpoint "$chromaUrl/api/v2/heartbeat")) {
    $chroma = Ensure-ChromaRuntime
    $chromaData = Join-Path $ragRoot '.chroma'
    # `chroma run` is the Rust server; the vulnerable Python/FastAPI backend is not used.
    $chromaProcess = Start-TrackedProcess -FilePath $chroma -ArgumentList @('run', '--path', "`"$chromaData`"", '--host', $chromaHost, '--port', "$chromaPort") -WorkingDirectory $ragRoot
    Wait-Endpoint -Uri "$chromaUrl/api/v2/heartbeat" -Service 'Chroma' -Seconds 60 -Process $chromaProcess
    Write-Host '      Chroma Rust iniciado en loopback desde el entorno privado.' -ForegroundColor Green
  } else { Write-Host '      Chroma ya estaba disponible.' -ForegroundColor DarkGreen }

  Write-Step 5 'Validando el indice RAG...'
  Ensure-DocumentCorpus
  if ($SkipPrepare) { Write-Host '      Preparacion omitida por parametro.' -ForegroundColor Yellow }
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
        Write-Host "      Indice y coleccion verificados: $summary" -ForegroundColor DarkGreen
      } else {
        Write-Host '      El indice falta o no coincide con Chroma; preparandolo ahora...' -ForegroundColor Yellow
        & $nodeRuntime.Node 'src/prepareRag.ts'
        if ($LASTEXITCODE -ne 0) { throw "La preparacion del RAG termino con codigo $LASTEXITCODE." }
        & $nodeRuntime.Node 'src/checkReady.ts'
        if ($LASTEXITCODE -ne 0) { throw 'El indice se creo, pero no supero la comprobacion final.' }
        Write-Host '      Indice preparado y verificado.' -ForegroundColor Green
      }
    } finally { Pop-Location }
  }

  $uiHost = Get-ProjectSetting 'RAG_UI_HOST' '127.0.0.1'
  $uiPort = [int](Get-ProjectSetting 'RAG_UI_PORT' '8787')
  $browserHost = if ($uiHost -in @('0.0.0.0', '::')) { '127.0.0.1' } else { $uiHost }
  $uiUrl = "http://${browserHost}:$uiPort"
  $env:RAG_UI_HOST = $uiHost
  $env:RAG_UI_PORT = "$uiPort"
  Write-Step 6 'Iniciando Hono Chat...'
  if (-not (Test-Endpoint "$uiUrl/api/health")) {
    $honoEntry = Join-Path $repoRoot 'hono-chat\server.ts'
    $honoProcess = Start-TrackedProcess -FilePath $nodeRuntime.Node -ArgumentList @("`"$honoEntry`"") -WorkingDirectory $repoRoot
    Wait-Endpoint -Uri "$uiUrl/api/health" -Service 'Hono Chat' -Seconds 30 -Process $honoProcess
    Write-Host '      Hono Chat iniciado.' -ForegroundColor Green
  } else { Write-Host '      Hono Chat ya estaba disponible.' -ForegroundColor DarkGreen }

  Write-Step 7 'Local RAG listo.'
  Write-Host "      $uiUrl" -ForegroundColor Green
  if (-not $NoBrowser) { Start-Process $uiUrl }

  if (-not $ExitAfterReady) {
    Write-Host ''
    Read-Host 'Pulsa Enter para detener los servicios iniciados por este lanzador'
  }
} catch {
  Write-Host ''
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Corrige el problema indicado y vuelve a pulsar START-RAG.cmd.' -ForegroundColor Yellow
  $launcherExitCode = 1
} finally {
  try { Stop-StartedProcesses }
  catch { Write-Host "Aviso durante la limpieza: $($_.Exception.Message)" -ForegroundColor Yellow }
}

exit $launcherExitCode
