@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Local RAG
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-local-rag.ps1"
if errorlevel 1 (
  echo.
  echo The RAG startup failed, check the previous messages.
  pause
)
endlocal
