<#
  untacit installer - Windows (PowerShell 5.1+ / pwsh)

    powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/rflvz/untacit/main/install.ps1 | iex"

  With flags:

    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/rflvz/untacit/main/install.ps1))) -Ref main -Yes

  What it does:
    1. Detects the dependencies (git, Node.js >= 20, pnpm; Claude Code CLI as
       an optional extra) - offers to install the missing ones (winget / npm),
       and for anything it cannot install prints the exact command or URL.
    2. Clones the repo into %LOCALAPPDATA%\untacit\app (or reuses the checkout
       you are standing in), installs the workspace and builds it.
    3. Drops `untacit` and `untacit-mcp` launchers into %LOCALAPPDATA%\untacit\bin
       and adds that directory to your user PATH.

  Flags:
    -Ref <branch|tag>   Version to install (default: main)
    -Dir <path>         Install root (default: %LOCALAPPDATA%\untacit)
    -Yes                No prompts, assume "yes"
    -NoPath             Do not touch the user PATH; print instructions instead
    -Uninstall          Remove the install root and the PATH entry, then exit
#>
[CmdletBinding()]
param(
  [string]$Ref = 'main',
  [string]$Dir = (Join-Path $env:LOCALAPPDATA 'untacit'),
  [switch]$Yes,
  [switch]$NoPath,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$RepoUrl = 'https://github.com/rflvz/untacit.git'
$AppDir  = Join-Path $Dir 'app'
$BinDir  = Join-Path $Dir 'bin'

# ---------------------------------------------------------------- cosmetics --
$G = @{ Ok = '+'; Bad = 'x'; Warn = '!'; Dot = '*'; Arr = '->' }
$Frames = @('|', '/', '-', '\')
try {
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  $G = @{
    Ok   = [string][char]0x2713   # check mark
    Bad  = [string][char]0x2717   # cross
    Warn = '!'
    Dot  = [string][char]0x25CF   # bullet
    Arr  = [string][char]0x2192   # arrow
  }
  $Frames = @(0x280B, 0x2819, 0x2839, 0x2838, 0x283C, 0x2834, 0x2826, 0x2827, 0x2807, 0x280F |
    ForEach-Object { [string][char]$_ })
} catch { }

function Write-Ok([string]$m)   { Write-Host '    ' -NoNewline; Write-Host $G.Ok  -ForegroundColor Green  -NoNewline; Write-Host " $m" }
function Write-Bad([string]$m)  { Write-Host '    ' -NoNewline; Write-Host $G.Bad -ForegroundColor Red    -NoNewline; Write-Host " $m" }
function Write-Wrn([string]$m)  { Write-Host '    ' -NoNewline; Write-Host $G.Warn -ForegroundColor Yellow -NoNewline; Write-Host " $m" }
function Write-Head([string]$m) {
  Write-Host ''
  Write-Host "  $($G.Dot) " -ForegroundColor Magenta -NoNewline
  Write-Host $m -ForegroundColor White
}

function Show-Banner {
  $banner = @'

               _             _ _
   _   _ _ __ | |_ __ _  ___(_) |_
  | | | | '_ \| __/ _` |/ __| | __|
  | |_| | | | | || (_| | (__| | |_
   \__,_|_| |_|\__\__,_|\___|_|\__|

'@
  Write-Host $banner -ForegroundColor Cyan
  Write-Host '  typed graph of your business logic - installer' -ForegroundColor DarkGray
}

function Confirm-Step([string]$Question) {
  if ($Yes) { return $true }
  $r = Read-Host "    ? $Question [Y/n]"
  return ($r -eq '' -or $r -match '^[yYsS]')
}

# Invoke-Step: run a command line through cmd.exe with a spinner; on failure
# dump the tail of the log and stop.
function Invoke-Step {
  param([string]$Title, [string]$CommandLine, [string]$WorkDir)
  $log = Join-Path $env:TEMP ('untacit-step-' + [IO.Path]::GetRandomFileName() + '.log')
  $startArgs = @{
    FilePath     = $env:ComSpec
    ArgumentList = @('/d', '/s', '/c', "$CommandLine > `"$log`" 2>&1")
    NoNewWindow  = $true
    PassThru     = $true
  }
  if ($WorkDir) { $startArgs.WorkingDirectory = $WorkDir }
  $p = Start-Process @startArgs
  $i = 0
  while (-not $p.HasExited) {
    Write-Host "`r    " -NoNewline
    Write-Host $Frames[$i % $Frames.Count] -ForegroundColor Cyan -NoNewline
    Write-Host " $Title " -ForegroundColor DarkGray -NoNewline
    Start-Sleep -Milliseconds 90
    $i++
  }
  $p.WaitForExit()
  Write-Host "`r" -NoNewline
  if ($p.ExitCode -eq 0) {
    Write-Ok $Title
    Remove-Item $log -ErrorAction SilentlyContinue
    return
  }
  Write-Bad $Title
  Write-Host ''
  Write-Host '  ---- last lines of the log ----' -ForegroundColor DarkGray
  if (Test-Path $log) { Get-Content $log -Tail 25 | ForEach-Object { Write-Host "  $_" } }
  Write-Host '  -------------------------------' -ForegroundColor DarkGray
  Write-Host "  Full log: $log"
  throw "step failed: $Title"
}

function Get-Cmd([string]$Name) { Get-Command $Name -ErrorAction SilentlyContinue }

# Re-read PATH from the registry so tools installed a moment ago are found.
function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$machine;$user"
}

# ---------------------------------------------------------------- uninstall --
if ($Uninstall) {
  Show-Banner
  Write-Head 'Uninstalling'
  if (Test-Path $Dir) { Remove-Item -Recurse -Force $Dir; Write-Ok "removed $Dir" }
  else { Write-Wrn "$Dir not found" }
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($userPath) {
    $parts = $userPath -split ';' | Where-Object { $_ -and $_ -ne $BinDir }
    [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
    Write-Ok 'removed the PATH entry'
  }
  Write-Host ''
  return
}

# ------------------------------------------------------------- dependencies --
Show-Banner
Write-Head 'Checking dependencies'

$missingRequired = $false
$pending = New-Object System.Collections.ArrayList
function Add-Pending([string]$Title, [string]$Hint) {
  [void]$pending.Add(@{ Title = $Title; Hint = $Hint })
}

$winget = Get-Cmd 'winget'

# git - required (the graph repo *is* a git repo)
if (-not (Get-Cmd 'git')) {
  Write-Wrn 'git - not found (required: the graph lives in a git repo)'
  $installed = $false
  if ($winget -and (Confirm-Step 'Install Git via winget now?')) {
    try {
      Invoke-Step 'Installing Git (winget)' 'winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements'
      Update-SessionPath
      $installed = [bool](Get-Cmd 'git')
    } catch { $installed = $false }
  }
  if (-not $installed) {
    Add-Pending 'Install git:' 'winget install --id Git.Git -e    (or https://git-scm.com/download/win)'
    $missingRequired = $true
  }
}
if (Get-Cmd 'git') {
  $gitV = (& git --version) -replace 'git version\s*', ''
  Write-Ok "git $gitV"
}

# Node.js >= 20 - required
function Test-Node {
  if (-not (Get-Cmd 'node')) { return $null }
  $v = (& node -v) -replace '^v', ''
  $major = [int]($v -split '\.')[0]
  return @{ Version = $v; Ok = ($major -ge 20) }
}
$node = Test-Node
if (-not $node -or -not $node.Ok) {
  if ($node) { Write-Wrn "node v$($node.Version) - too old (>= 20 required)" }
  else { Write-Wrn 'node - not found (required, >= 20)' }
  $installed = $false
  if ($winget -and (Confirm-Step 'Install Node.js LTS via winget now?')) {
    try {
      Invoke-Step 'Installing Node.js LTS (winget)' 'winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements'
      Update-SessionPath
      $node = Test-Node
      $installed = ($node -and $node.Ok)
      if (-not $installed) { Write-Wrn 'node still not visible - open a new terminal and re-run the installer' }
    } catch { $installed = $false }
  }
  if (-not $installed) {
    Add-Pending 'Install Node.js >= 20 LTS:' 'winget install --id OpenJS.NodeJS.LTS -e    (or https://nodejs.org)'
    $missingRequired = $true
  }
}
if ($node -and $node.Ok) { Write-Ok "node v$($node.Version) (>= 20 required)" }

# pnpm - required, installable without admin once Node.js is present
$pnpmOk = [bool](Get-Cmd 'pnpm')
if ($pnpmOk) {
  Write-Ok "pnpm $(& pnpm --version)"
} elseif ($node -and $node.Ok) {
  Write-Wrn 'pnpm - not found'
  if (Confirm-Step 'Install pnpm now (npm -g, no admin)?') {
    try {
      Invoke-Step 'Installing pnpm' 'npm install -g pnpm || corepack enable pnpm'
      Update-SessionPath
      $pnpmOk = [bool](Get-Cmd 'pnpm')
      if ($pnpmOk) { Write-Ok "pnpm $(& pnpm --version) installed" }
    } catch { $pnpmOk = $false }
  }
  if (-not $pnpmOk) {
    Add-Pending 'Install pnpm:' 'npm install -g pnpm    (or https://pnpm.io/installation)'
    $missingRequired = $true
  }
} else {
  Write-Bad 'pnpm - not found (installable once Node.js is present)'
  $missingRequired = $true
}

# Claude Code CLI - optional (agent engine for `extract` / `interview`)
if (Get-Cmd 'claude') {
  Write-Ok 'claude (Claude Code) - optional agent engine'
} else {
  Write-Wrn "claude (Claude Code) - optional, not found: 'untacit extract'/'untacit interview' need it"
  Add-Pending 'Optional - install Claude Code:' 'npm install -g @anthropic-ai/claude-code    (https://claude.com/claude-code)'
}

if ($pending.Count -gt 0) {
  Write-Head 'Pending installs'
  foreach ($item in $pending) {
    Write-Host "    $($G.Arr) $($item.Title)"
    Write-Host "      $($item.Hint)" -ForegroundColor DarkGray
  }
}

if ($missingRequired) {
  Write-Host ''
  Write-Host "  $($G.Bad) " -ForegroundColor Red -NoNewline
  Write-Host 'Required dependencies are missing - install them with the commands above'
  Write-Host '    (a new terminal may be needed) and run this installer again.'
  exit 1
}

# ------------------------------------------------------------ fetch & build --
# Standing inside a checkout of the repo? Build in place instead of cloning.
$localMode = $false
$cwd = (Get-Location).Path
if ((Test-Path (Join-Path $cwd 'pnpm-workspace.yaml')) -and
    (Test-Path (Join-Path $cwd 'packages\cli\package.json')) -and
    (Test-Path (Join-Path $cwd 'package.json')) -and
    ((Get-Content (Join-Path $cwd 'package.json') -Raw) -match '"untacit-monorepo"')) {
  $localMode = $true
  $AppDir = $cwd
}

Write-Head 'Installing untacit'
if ($localMode) {
  Write-Ok "using the local checkout: $AppDir"
} elseif (Test-Path (Join-Path $AppDir '.git')) {
  Invoke-Step "Updating $AppDir ($Ref)" "git -C `"$AppDir`" fetch --depth 1 origin $Ref"
  Invoke-Step "Checking out $Ref" "git -C `"$AppDir`" checkout -q --detach FETCH_HEAD"
} else {
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  Invoke-Step "Cloning rflvz/untacit ($Ref)" "git clone --depth 1 --branch $Ref $RepoUrl `"$AppDir`""
}

Invoke-Step 'Installing workspace dependencies' 'pnpm install --frozen-lockfile || pnpm install' $AppDir
Invoke-Step 'Building packages' 'pnpm build' $AppDir

$CliJs = Join-Path $AppDir 'packages\cli\dist\bin.js'
$McpJs = Join-Path $AppDir 'packages\mcp\dist\bin.js'
$version = & node $CliJs --version
Write-Ok "untacit $version works"

# ------------------------------------------------------------------ launchers --
Write-Head 'Creating launchers'
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
# In the default layout the launcher can address the app relative to itself
# (%~dp0..\app); a local checkout needs the absolute path baked in.
if ($localMode) {
  $cliTarget = $CliJs
  $mcpTarget = $McpJs
} else {
  $cliTarget = '%~dp0..\app\packages\cli\dist\bin.js'
  $mcpTarget = '%~dp0..\app\packages\mcp\dist\bin.js'
}
Set-Content -Path (Join-Path $BinDir 'untacit.cmd') -Encoding Ascii -Value @"
@echo off
node "$cliTarget" %*
"@
Set-Content -Path (Join-Path $BinDir 'untacit-mcp.cmd') -Encoding Ascii -Value @"
@echo off
node "$mcpTarget" %*
"@
Write-Ok "untacit, untacit-mcp $($G.Arr) $BinDir"

$pathNote = ''
$onPath = ($env:Path -split ';') -contains $BinDir
if ($onPath) {
  Write-Ok "PATH already includes $BinDir"
} elseif ($NoPath) {
  $pathNote = "add $BinDir to your PATH"
  Write-Wrn "PATH untouched (-NoPath); $pathNote"
} else {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $userPath) { $userPath = '' }
  if (-not (($userPath -split ';') -contains $BinDir)) {
    $sep = if ($userPath -and -not $userPath.EndsWith(';')) { ';' } else { '' }
    [Environment]::SetEnvironmentVariable('Path', "$userPath$sep$BinDir", 'User')
  }
  $env:Path = "$env:Path;$BinDir"
  Write-Ok 'added to the user PATH (new terminals pick it up automatically)'
}

# -------------------------------------------------------------------- summary --
Write-Host ''
Write-Host ('  ' + ('-' * 48)) -ForegroundColor Green
Write-Host "   untacit $version is ready" -ForegroundColor White
Write-Host ''
Write-Host "   app        $AppDir"
Write-Host "   launchers  $BinDir"
if ($pathNote) { Write-Host "   note       $pathNote" -ForegroundColor Yellow }
Write-Host ''
Write-Host '   Get started:'
Write-Host '     untacit init C:\graphs\my-graph' -ForegroundColor Cyan
Write-Host '     untacit --help' -ForegroundColor Cyan
Write-Host '     guided demo: examples/acme-manufactura/DEMO.md' -ForegroundColor DarkGray
Write-Host ('  ' + ('-' * 48)) -ForegroundColor Green
Write-Host ''
