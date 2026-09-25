<#
.SYNOPSIS
Installs what the Toolkit setup wizard needs on a fresh Windows machine, and
clones Toolkit at its latest release.

.DESCRIPTION
Installs Git for Windows, Node.js LTS, pnpm, Claude Code and, with -GitHub,
the GitHub CLI. Sets the Git options the guide recommends, then clones Toolkit
into -ToolkitDir and checks out the newest release tag. Safe to re-run:
anything already installed is left alone.

Run from PowerShell:
  powershell -ExecutionPolicy Bypass -File install-prerequisites.ps1 -GitHub -Name "Your Name" -Email "you@example.com"
#>
param(
	[switch]$GitHub,
	[string]$Name,
	[string]$Email,
	[string]$ToolkitDir = 'C:\src\Toolkit'
)
$ErrorActionPreference = 'Stop'

function Update-SessionPath {
	$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
		[Environment]::GetEnvironmentVariable('Path', 'User')
}

function Install-WingetPackage([string]$Id) {
	# Windows PowerShell 5.1 turns redirected native stderr into a terminating
	# error under 'Stop', so relax it for this probe only.
	$ErrorActionPreference = 'Continue'
	winget list --id $Id --exact --accept-source-agreements *> $null
	$found = $LASTEXITCODE -eq 0
	$ErrorActionPreference = 'Stop'
	if ($found) {
		Write-Host "$Id is already installed"
		return
	}
	Write-Host "Installing $Id"
	winget install --id $Id --exact --source winget --accept-package-agreements --accept-source-agreements
	if ($LASTEXITCODE -ne 0) { throw "winget install $Id failed with exit code $LASTEXITCODE" }
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
	throw 'winget is not available. Install "App Installer" from the Microsoft Store, then re-run this script.'
}

Install-WingetPackage 'Git.Git'
Install-WingetPackage 'OpenJS.NodeJS.LTS'
if ($GitHub) { Install-WingetPackage 'GitHub.cli' }
Update-SessionPath

$claudeBin = Join-Path $env:USERPROFILE '.local\bin'
if (-not (Get-Command claude -ErrorAction SilentlyContinue) -and
	-not (Test-Path (Join-Path $claudeBin 'claude.exe'))) {
	Write-Host 'Installing Claude Code'
	Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
}
else { Write-Host 'Claude Code is already installed' }

# Put Claude Code on the Windows user PATH so every terminal finds it:
# Git Bash, PowerShell, cmd and editor terminals.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $claudeBin) {
	[Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $claudeBin), 'User')
	Write-Host "Added $claudeBin to your user PATH"
}
Update-SessionPath

$nodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 24) { throw "Node.js 24 or later is required; found $(node --version). Install it from https://nodejs.org" }

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
	Write-Host 'Installing pnpm'
	npm install -g pnpm@11
	if ($LASTEXITCODE -ne 0) { throw 'npm install -g pnpm@11 failed' }
}
else { Write-Host 'pnpm is already installed' }

git config --global core.autocrlf input
git config --global core.longpaths true
git config --global init.defaultBranch main
if ($Name) { git config --global user.name $Name }
if ($Email) { git config --global user.email $Email }
if (-not (git config --global user.name) -or -not (git config --global user.email)) {
	Write-Warning 'Set your Git identity: git config --global user.name "Your Name"; git config --global user.email "you@example.com"'
}

if (-not (Test-Path $ToolkitDir)) {
	git clone https://github.com/ClabonConsultingLtd/Toolkit.git $ToolkitDir
	if ($LASTEXITCODE -ne 0) { throw 'git clone failed' }
}
git -C $ToolkitDir fetch --tags --quiet
$tag = git -C $ToolkitDir tag --list 'v*' --sort=-v:refname | Select-Object -First 1
git -C $ToolkitDir -c advice.detachedHead=false switch --detach $tag
if ($LASTEXITCODE -ne 0) { throw "could not check out $tag in $ToolkitDir" }

# Every tool must now resolve from the refreshed PATH. New terminals see the
# same PATH; terminals that were already open need reopening.
$tools = @('git', 'node', 'npm', 'pnpm', 'claude')
if ($GitHub) { $tools += 'gh' }
$missing = @($tools | Where-Object { -not (Get-Command $_ -ErrorAction SilentlyContinue) })
if ($missing.Count -gt 0) {
	Write-Warning ("Not on PATH: " + ($missing -join ', ') + '. See "Checking PATH" in docs/guides/claude-windows-setup.md.')
}

$bashDir = '/' + $ToolkitDir.Substring(0, 1).ToLower() + $ToolkitDir.Substring(2).Replace('\', '/')
Write-Host ''
Write-Host "Done. Toolkit $tag is in $ToolkitDir."
Write-Host 'Next, in a NEW Git Bash window (already-open terminals keep the old PATH):'
if ($GitHub) { Write-Host '  - Sign in to GitHub: gh auth login, then gh auth setup-git' }
Write-Host '  - Run claude once, sign in, then /exit'
Write-Host "  - From your repository, run: node $bashDir/packages/setup-wizard/setup.mjs"
