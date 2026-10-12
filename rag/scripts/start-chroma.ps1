$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$chromaExe = Join-Path $projectRoot ".runtime\chroma\chroma-windows.exe"

if (-not (Test-Path $chromaExe)) {
  Write-Error "The private Chroma runtime is not installed. Run ..\START-RAG.cmd once to create it."
}

$chromaDataPath = Join-Path $projectRoot ".chroma"

function Get-ChromaSetting {
  param([string]$Name, [string]$Default)
  $fromEnvironment = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if (-not [string]::IsNullOrWhiteSpace($fromEnvironment)) { return $fromEnvironment }
  foreach ($file in @((Join-Path $projectRoot '.env'), (Join-Path $projectRoot '.env.example'))) {
    if (-not (Test-Path $file)) { continue }
    foreach ($line in [System.IO.File]::ReadAllLines($file)) {
      if ($line -match "^\s*$Name\s*=\s*(.*)$") { return $Matches[1].Trim().Trim('"', "'") }
    }
  }
  return $Default
}

$chromaHost = Get-ChromaSetting 'CHROMA_HOST' 'localhost'
$chromaPort = Get-ChromaSetting 'CHROMA_PORT' '8000'
if ($chromaHost -notin @('localhost', '127.0.0.1')) { throw 'CHROMA_HOST must be localhost or 127.0.0.1.' }
if ($chromaPort -notmatch '^[0-9]{1,5}$' -or [int]$chromaPort -lt 1 -or [int]$chromaPort -gt 65535) { throw 'CHROMA_PORT must be a valid port.' }

Write-Host "Starting Chroma server..."
Write-Host "Binary: $chromaExe"
Write-Host "Data path: $chromaDataPath"
Write-Host "URL: http://${chromaHost}:${chromaPort}"

& $chromaExe run --path $chromaDataPath --host $chromaHost --port $chromaPort
