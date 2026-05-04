# install.ps1 — Copies the orchestrator skill, slash command, and scripts into the global opencode config.
# Run from anywhere:  powershell -File C:\Coding\Claude\skills_dev\orchestrator\install.ps1
param(
  [string]$OpencodeRoot = "$env:USERPROFILE\.config\opencode",
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path

$skillDst   = Join-Path $OpencodeRoot 'skills\orchestrator'
$cmdDst     = Join-Path $OpencodeRoot 'commands'
$scriptsDst = Join-Path $skillDst 'scripts'
$tplDst     = Join-Path $skillDst 'templates'
$libDst     = Join-Path $skillDst 'lib'

Write-Host "Installing orchestrator -> $OpencodeRoot" -ForegroundColor Cyan
Write-Host "Updating skill at $skillDst" -ForegroundColor Cyan

New-Item -ItemType Directory -Force -Path $skillDst, $scriptsDst, $tplDst, $libDst, $cmdDst | Out-Null
Copy-Item "$src\skill\SKILL.md" -Destination $skillDst -Force
Copy-Item "$src\scripts\*.mjs"  -Destination $scriptsDst -Force
Copy-Item "$src\lib\*"          -Destination $libDst -Force
Copy-Item "$src\templates\*"    -Destination $tplDst -Recurse -Force
Write-Host "  skill files installed" -ForegroundColor Green

Copy-Item "$src\commands\orchestrate.md" -Destination $cmdDst -Force
Write-Host "  /orchestrate slash command installed" -ForegroundColor Green

# Check BurntToast
$bt = Get-Module -ListAvailable -Name BurntToast
if (-not $bt) {
  Write-Host ""
  Write-Host "BurntToast not found. Install with:" -ForegroundColor Yellow
  Write-Host "  Install-Module -Name BurntToast -Scope CurrentUser -Force" -ForegroundColor Yellow
} else {
  Write-Host "  BurntToast OK ($($bt.Version))" -ForegroundColor Green
}

# Verify node available
try {
  $nv = node --version
  Write-Host "  Node $nv detected" -ForegroundColor Green
} catch {
  Write-Host "WARNING: node not found on PATH. Scripts will fail." -ForegroundColor Red
}

$scriptCount = (Get-ChildItem "$scriptsDst" -Filter *.mjs).Count
$libCount    = (Get-ChildItem "$libDst" -File).Count
$tplCount    = (Get-ChildItem "$tplDst" -Recurse -File).Count
$cmdCount    = (Get-ChildItem "$cmdDst" -Filter orchestrate.md).Count
Write-Host ""
Write-Host "Installed: scripts=$scriptCount  lib=$libCount  templates=$tplCount  commands=$cmdCount" -ForegroundColor Cyan

# Verify install matches source (excluding *.bak, etc)
try {
  $missing = @()
  Get-ChildItem "$src\lib" -File -Recurse | ForEach-Object {
    $rel = $_.FullName.Substring("$src\lib\".Length)
    if (-not (Test-Path (Join-Path $libDst $rel))) { $missing += "lib\$rel" }
  }
  Get-ChildItem "$src\templates" -File -Recurse | ForEach-Object {
    $rel = $_.FullName.Substring("$src\templates\".Length)
    if (-not (Test-Path (Join-Path $tplDst $rel))) { $missing += "templates\$rel" }
  }
  if ($missing.Count -gt 0) {
    Write-Host "WARNING: missing after install:" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  } else {
    Write-Host "  all source assets present in install" -ForegroundColor Green
  }
} catch {
  Write-Host "  (post-install verification skipped: $_)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done. Use it in any project with:" -ForegroundColor Cyan
Write-Host "  /orchestrate next            # do 1 task" -ForegroundColor White
Write-Host "  /orchestrate task-42         # specific ticket" -ForegroundColor White
Write-Host "  /orchestrate sprint-3        # all tasks in sprint 3" -ForegroundColor White
Write-Host "  /orchestrate 5               # next 5 tasks" -ForegroundColor White
