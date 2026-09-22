$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$chromaExe = Join-Path $projectRoot ".runtime\chroma\chroma-windows.exe"

if (-not (Test-Path $chromaExe)) {
  Write-Error "The private Chroma runtime is not installed. Run ..\START-RAG.cmd once to create it."
}

$chromaDataPath = Join-Path $projectRoot ".chroma"

Write-Host "Starting Chroma server..."
Write-Host "Binary: $chromaExe"
Write-Host "Data path: $chromaDataPath"
Write-Host "URL: http://127.0.0.1:8000"

& $chromaExe run --path $chromaDataPath --host 127.0.0.1 --port 8000
