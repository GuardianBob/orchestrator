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

Write-Host "Installing orchestrator -> $OpencodeRoot" -ForegroundColor Cyan

if ((Test-Path $skillDst) -and -not $Force) {
  Write-Host "Skill already exists at $skillDst. Re-run with -Force to overwrite." -ForegroundColor Yellow
} else {
  New-Item -ItemType Directory -Force -Path $skillDst, $scriptsDst, $tplDst, $cmdDst | Out-Null
  Copy-Item "$src\skill\SKILL.md" -Destination $skillDst -Force
  Copy-Item "$src\scripts\*.mjs"  -Destination $scriptsDst -Force
  Copy-Item "$src\templates\*"    -Destination $tplDst -Force
  Write-Host "  skill files installed" -ForegroundColor Green
}

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

Write-Host ""
Write-Host "Done. Use it in any project with:" -ForegroundColor Cyan
Write-Host "  /orchestrate next            # do 1 task" -ForegroundColor White
Write-Host "  /orchestrate task-42         # specific ticket" -ForegroundColor White
Write-Host "  /orchestrate sprint-3        # all tasks in sprint 3" -ForegroundColor White
Write-Host "  /orchestrate 5               # next 5 tasks" -ForegroundColor White
