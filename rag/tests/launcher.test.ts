import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('startup cleanup only targets orphaned workers from this Ollama installation', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', String.raw`
$ErrorActionPreference = 'Stop'
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:RAG_TEST_LAUNCHER, [ref]$null, [ref]$null)
$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Stop-OrphanedOllamaWorkers' }, $true)
Invoke-Expression $definition.Extent.Text
$workerPath = 'C:\Ollama\lib\ollama\llama-server.exe'
$created = [datetime]'2026-01-01T12:00:00Z'
$script:fakeProcesses = @{}
foreach ($workerId in @(101, 102, 103, 104, 105, 106)) {
  $process = [pscustomobject]@{ Id = $workerId; Path = $workerPath; StartTime = $created }
  $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($timeout) return $true }
  $script:fakeProcesses[$workerId] = $process
}
$script:fakeProcesses[104].Path = 'C:\Other\llama-server.exe'
$script:fakeProcesses[105].Path = $null
$script:fakeProcesses[106].StartTime = $created.AddMinutes(1)
$script:fakeProcesses[500] = [pscustomobject]@{StartTime = $created.AddMinutes(-1)}
$script:fakeProcesses[501] = [pscustomobject]@{StartTime = $created.AddMinutes(1)}
$script:stopped = @()
function Get-CimInstance {
  [CmdletBinding()]param($ClassName, $Filter)
  foreach ($workerId in @(101, 102, 103, 104, 105, 106)) {
    $parentId = 999
    if ($workerId -eq 102) { $parentId = 500 }
    if ($workerId -eq 103) { $parentId = 501 }
    [pscustomobject]@{ProcessId = $workerId; ParentProcessId = $parentId; CreationDate = $created}
  }
}
function Get-Process { [CmdletBinding()]param([int]$Id) return $script:fakeProcesses[$Id] }
function Stop-Process { [CmdletBinding()]param($InputObject) $script:stopped += $InputObject.Id }
Stop-OrphanedOllamaWorkers -Ollama 'C:\Ollama\ollama.exe'
if (($script:stopped -join ',') -ne '101,103') { throw "Wrong cleanup targets: $script:stopped" }
Write-Output 'Orphans only; live parents, other installs and reused worker PIDs preserved.'
`], { windowsHide: true, timeout: 10000, encoding: 'utf8', env: {
    ...process.env, RAG_TEST_LAUNCHER: fileURLToPath(new URL('../../start-local-rag.ps1', import.meta.url)),
  } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Orphans only/);
});

test('Windows launcher stops owned children and grandchildren but preserves an unrelated service', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ragen-launcher-'));
  try {
    await writeFile(path.join(directory, 'worker.cjs'), `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const role = process.argv[2];
if (role === 'parent' || role === 'child') {
  spawn(process.execPath, [__filename, role === 'parent' ? 'child' : 'grandchild'], { windowsHide: true, stdio: 'ignore' });
}
writeFileSync(path.join(process.env.RAG_TEST_DIR, role + '.pid'), String(process.pid));
setInterval(() => {}, 1000);
`);
    const script = path.join(directory, 'verify.ps1');
    await writeFile(script, `
$ErrorActionPreference = 'Stop'
$parseErrors = $null
$tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:RAG_TEST_LAUNCHER, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors -join [Environment]::NewLine) }
# Load only the lifecycle functions, without starting the real RAG launcher.
foreach ($name in @('Start-TrackedProcess', 'Stop-StartedProcesses')) {
  $definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if (-not $definition) { throw "Missing function: $name" }
  Invoke-Expression $definition.Extent.Text
}
$startedProcesses = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$fixtureProcesses = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$workerScript = Join-Path $env:RAG_TEST_DIR 'worker.cjs'
$quotedWorker = '"' + $workerScript + '"'
try {
  $unrelated = Start-Process -FilePath $env:RAG_TEST_NODE -ArgumentList @($quotedWorker, 'unrelated') -WindowStyle Hidden -PassThru
  [void]$fixtureProcesses.Add($unrelated)
  $parent = Start-TrackedProcess -FilePath $env:RAG_TEST_NODE -ArgumentList @($quotedWorker, 'parent') -WorkingDirectory $env:RAG_TEST_DIR
  [void]$fixtureProcesses.Add($parent)
  $deadline = (Get-Date).AddSeconds(10)
  foreach ($role in @('parent', 'child', 'grandchild', 'unrelated')) {
    $marker = Join-Path $env:RAG_TEST_DIR ($role + '.pid')
    while (-not (Test-Path -LiteralPath $marker)) {
      if ((Get-Date) -gt $deadline) { throw "Timed out starting $role" }
      Start-Sleep -Milliseconds 50
    }
    if ($role -in @('child', 'grandchild')) {
      [void]$fixtureProcesses.Add((Get-Process -Id ([int](Get-Content -LiteralPath $marker))))
    }
  }
  Stop-StartedProcesses
  foreach ($process in $fixtureProcesses) {
    if ($process.Id -eq $unrelated.Id) { continue }
    if (-not $process.WaitForExit(5000)) { throw "Owned process survived: $($process.Id)" }
  }
  if ($unrelated.HasExited) { throw 'Cleanup stopped an unrelated service' }
  # Repeated cleanup must be harmless when tracked processes have already exited.
  Stop-StartedProcesses
  Write-Output 'Owned tree stopped; unrelated service preserved.'
} finally {
  Stop-StartedProcesses
  foreach ($process in $fixtureProcesses) {
    if (-not $process.HasExited) { Stop-Process -InputObject $process -ErrorAction SilentlyContinue }
  }
}
`);
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true, timeout: 35000, encoding: 'utf8',
      env: { ...process.env, RAG_TEST_DIR: directory, RAG_TEST_NODE: process.execPath,
        RAG_TEST_LAUNCHER: fileURLToPath(new URL('../../start-local-rag.ps1', import.meta.url)) },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Owned tree stopped; unrelated service preserved/);
  } finally {
    if (path.dirname(directory) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('ragen-launcher-')) throw new Error('Unexpected test directory');
    await rm(directory, { recursive: true, force: true });
  }
});
