$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$chromaExe = Join-Path $projectRoot ".runtime\chroma-venv\Scripts\chroma.exe"

if (-not (Test-Path $chromaExe)) {
  Write-Error "The private Chroma runtime is not installed. Run ..\START-RAG.cmd once to create it."
}

$chromaDataPath = Join-Path $projectRoot ".chroma"

Write-Host "Starting Chroma server..."
Write-Host "Binary: $chromaExe"
Write-Host "Data path: $chromaDataPath"
Write-Host "URL: http://127.0.0.1:8000"

# `chroma run` starts Chroma's Rust server. Do not replace it with the Python/FastAPI backend.
& $chromaExe run --path $chromaDataPath --host 127.0.0.1 --port 8000
