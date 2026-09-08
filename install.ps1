# claudex one-liner installer for Windows (PowerShell 5.1+ / 7+).
#
#   irm https://raw.githubusercontent.com/aaravarr/claudex/main/install.ps1 | iex
#
# or locally:
#
#   pwsh -File install.ps1 [-Dir PATH] [-Branch NAME] [-Yes] [-SkipInit] [-SkipBuild]
#
# What it does:
#   1. Checks git / node (>=20) / pnpm (>=9) / claude. Offers to install missing
#      deps via winget (opt-in).
#   2. Clones https://github.com/aaravarr/claudex to %USERPROFILE%\claudex
#      (override with -Dir or $env:CLAUDEX_HOME).
#   3. Runs `pnpm install` and the web bundle build.
#   4. Interactively collects admin username + password (hidden), drives
#      `pnpm run init` via env vars so the TOTP QR + recovery codes print, then
#      pauses on a banner so the user actually saves them.
#   5. Offers to register claudex as a background service via pm2 (installs
#      pm2 + pm2-windows-startup globally via npm; pass -SkipDaemon to opt out).
#
# Never runs with elevated privileges implicitly; winget usage is opt-in.
[CmdletBinding()]
param(
    [string]$Dir,
    [string]$Branch,
    [string]$Repo,
    [switch]$Yes,
    [switch]$SkipInit,
    [switch]$SkipBuild,
    [switch]$SkipDaemon,
    [switch]$Trace
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Logging — mirror everything to a transcript file so the user can always
# read errors back, even if the PowerShell window closes on process exit.
# ---------------------------------------------------------------------------
$script:InstallLog = if ($env:CLAUDEX_INSTALL_LOG) { $env:CLAUDEX_INSTALL_LOG } `
                     else { Join-Path $env:USERPROFILE '.claudex-install.log' }
try {
    Start-Transcript -Path $script:InstallLog -Append -ErrorAction Stop | Out-Null
    $script:TranscriptStarted = $true
} catch {
    $script:TranscriptStarted = $false
}

if ($Trace -or $env:CLAUDEX_DEBUG) { Set-PSDebug -Trace 1 }

# ---------------------------------------------------------------------------
# Trap any terminating error so the window pauses before closing. Users have
# reported "the terminal closes before I can see what went wrong" — this is
# the guard.
# ---------------------------------------------------------------------------
trap {
    Write-Host ''
    Write-Host "[!] install failed: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.InvocationInfo -and $_.InvocationInfo.PositionMessage) {
        Write-Host $_.InvocationInfo.PositionMessage -ForegroundColor DarkGray
    }
    if ($script:InstallLog) {
        Write-Host "    full log: $script:InstallLog" -ForegroundColor Red
    }
    Write-Host '    re-run with -Trace or $env:CLAUDEX_DEBUG=1 for a verbose trace.' -ForegroundColor Red
    if (-not $Yes) {
        try { Read-Host '    press Enter to close' | Out-Null } catch {}
    }
    if ($script:TranscriptStarted) { try { Stop-Transcript | Out-Null } catch {} }
    exit 1
}

# ---------------------------------------------------------------------------
# Defaults (env > param)
# ---------------------------------------------------------------------------
if (-not $Dir)    { $Dir    = if ($env:CLAUDEX_HOME)   { $env:CLAUDEX_HOME }   else { Join-Path $env:USERPROFILE 'claudex' } }
if (-not $Branch) { $Branch = if ($env:CLAUDEX_BRANCH) { $env:CLAUDEX_BRANCH } else { 'main' } }
if (-not $Repo)   { $Repo   = if ($env:CLAUDEX_REPO)   { $env:CLAUDEX_REPO }   else { 'https://github.com/aaravarr/claudex.git' } }
if (-not $Yes -and $env:CLAUDEX_ASSUME_YES) { $Yes = $true }
if (-not $SkipDaemon -and $env:CLAUDEX_SKIP_DAEMON) { $SkipDaemon = $true }

# ---------------------------------------------------------------------------
# Styling helpers
# ---------------------------------------------------------------------------
$script:UseColor = ($Host.UI.RawUI -ne $null) -and (-not $env:NO_COLOR)
function Say   ([string]$msg) { if ($script:UseColor) { Write-Host "==> " -NoNewline -ForegroundColor Cyan;   Write-Host $msg } else { Write-Host "==> $msg" } }
function Ok    ([string]$msg) { if ($script:UseColor) { Write-Host "[ok] " -NoNewline -ForegroundColor Green; Write-Host $msg } else { Write-Host "[ok] $msg" } }
function WarnM ([string]$msg) { if ($script:UseColor) { Write-Host "[warn] " -NoNewline -ForegroundColor Yellow;Write-Host $msg } else { Write-Host "[warn] $msg" } }
function DieM  ([string]$msg) {
    # Throw so the global trap fires, pausing the window before exit.
    throw $msg
}

function Banner([string]$msg) {
    Write-Host ''
    if ($script:UseColor) { Write-Host ('╭' + ('─' * 62) + '╮') -ForegroundColor Yellow }
    else                  { Write-Host ('+' + ('-' * 62) + '+') }
    $pad = 60 - $msg.Length
    if ($pad -lt 1) { $pad = 1 }
    $line = '│  ' + $msg + (' ' * $pad) + '│'
    if ($script:UseColor) { Write-Host $line -ForegroundColor Yellow } else { Write-Host $line }
    if ($script:UseColor) { Write-Host ('╰' + ('─' * 62) + '╯') -ForegroundColor Yellow }
    else                  { Write-Host ('+' + ('-' * 62) + '+') }
    Write-Host ''
}

function Confirm-Step([string]$prompt, [bool]$default = $false) {
    if ($Yes) { return $true }
    $hint = if ($default) { '[Y/n]' } else { '[y/N]' }
    $reply = Read-Host "? $prompt $hint"
    if ([string]::IsNullOrWhiteSpace($reply)) { return $default }
    return ($reply -match '^(y|yes)$')
}

function Add-ToPath([string]$path) {
    if (Test-Path $path) {
        if (-not (($env:PATH -split ';') -contains $path)) {
            $env:PATH = "$path;$env:PATH"
        }
    }
}

function Refresh-Env() {
    # winget installs don't update the current process PATH. Grab the machine
    # + user PATH from the registry and merge into $env:PATH so freshly
    # installed tools become callable without opening a new shell.
    try {
        $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
        $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
        $merged  = @($machine, $user, $env:PATH) -join ';'
        $seen = @{}; $uniq = @()
        foreach ($p in ($merged -split ';')) {
            if ($p -and -not $seen.ContainsKey($p)) { $seen[$p] = 1; $uniq += $p }
        }
        $env:PATH = ($uniq -join ';')
    } catch {
        # Non-fatal.
    }
    # Known fallbacks.
    Add-ToPath (Join-Path $env:ProgramFiles 'nodejs')
    Add-ToPath (Join-Path $env:ProgramFiles 'Git\cmd')
    Add-ToPath (Join-Path $env:APPDATA 'npm')
}

function Have([string]$name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Have-Winget() { return Have 'winget' }

function Winget-Install([string]$id, [string]$label) {
    if (-not (Have-Winget)) {
        DieM "winget not available. Install $label manually from the vendor's site and rerun."
    }
    Say "installing $label via winget ($id)..."
    & winget install --id $id -e --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) { DieM "winget install $label failed (exit $LASTEXITCODE)." }
    Refresh-Env
}

# ---------------------------------------------------------------------------
# Dependency: git
# ---------------------------------------------------------------------------
function Ensure-Git() {
    if (Have 'git') { Ok "git $((git --version).Split(' ')[2])"; return }
    WarnM 'git not found.'
    if (-not (Confirm-Step 'Install Git for Windows via winget?' $true)) {
        DieM 'git is required.'
    }
    Winget-Install 'Git.Git' 'Git'
    if (-not (Have 'git')) { DieM 'git still not on PATH. Open a new PowerShell and rerun.' }
    Ok "git $((git --version).Split(' ')[2])"
}

# ---------------------------------------------------------------------------
# Dependency: node >= 20
# ---------------------------------------------------------------------------
function Node-Major() {
    if (-not (Have 'node')) { return 0 }
    $v = (& node -v).TrimStart('v')
    return [int]($v.Split('.')[0])
}

function Ensure-Node() {
    $major = Node-Major
    if ($major -ge 20) { Ok "node $(node -v)"; return }
    if ($major -gt 0) { WarnM "node $(node -v) is too old (need >= 20)." }
    else              { WarnM 'node not found.' }
    if (-not (Confirm-Step 'Install Node.js LTS via winget?' $true)) {
        DieM 'Node 20+ is required.'
    }
    Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js LTS'
    if ((Node-Major) -lt 20) {
        DieM 'node is still below 20 after install. Open a new PowerShell window and rerun.'
    }
    Ok "node $(node -v)"
}

# ---------------------------------------------------------------------------
# Dependency: pnpm >= 9 (via corepack)
# ---------------------------------------------------------------------------
function Pnpm-Major() {
    if (-not (Have 'pnpm')) { return 0 }
    $v = (& pnpm -v)
    return [int]($v.Split('.')[0])
}

function Ensure-Pnpm() {
    $major = Pnpm-Major
    if ($major -ge 9) { Ok "pnpm $(pnpm -v)"; return }
    if ($major -gt 0) { WarnM "pnpm $(pnpm -v) is too old (need >= 9)." }
    else              { WarnM 'pnpm not found.' }
    if (-not (Have 'corepack')) { DieM 'corepack missing (ships with Node 16+). Reinstall Node.' }
    if (-not (Confirm-Step 'Enable pnpm via corepack?' $true)) { DieM 'pnpm is required.' }
    & corepack enable | Out-Null
    & corepack prepare pnpm@latest --activate | Out-Null
    if ($LASTEXITCODE -ne 0) { DieM 'corepack failed to activate pnpm.' }
    Refresh-Env
    Ok "pnpm $(pnpm -v)"
}

# ---------------------------------------------------------------------------
# Dependency: claude CLI (recommended)
# ---------------------------------------------------------------------------
function Ensure-Claude() {
    if (Have 'claude') {
        try { Ok "claude $((claude --version 2>$null | Select-Object -First 1))" } catch { Ok 'claude installed' }
        return
    }
    WarnM "``claude`` CLI not found. claudex drives the CLI as a subprocess — without it, sessions won't run."
    if (-not (Confirm-Step 'Install @anthropic-ai/claude-code globally via npm now?' $true)) {
        WarnM 'skipping. Install later with: npm install -g @anthropic-ai/claude-code'
        return
    }
    & npm install -g '@anthropic-ai/claude-code'
    if ($LASTEXITCODE -ne 0) {
        WarnM 'npm install failed. You may need an elevated PowerShell.'
        return
    }
    Refresh-Env
    Ok 'claude installed'
    WarnM 'Remember to log in: `claude login` (first run will prompt).'
}

# ---------------------------------------------------------------------------
# Clone / update
# ---------------------------------------------------------------------------
function Clone-Or-Update() {
    if (Test-Path (Join-Path $Dir '.git')) {
        $origin = & git -C $Dir remote get-url origin 2>$null
        if (-not $origin) { DieM "$Dir exists and is a git repo but has no origin remote. Refusing to touch." }
        Say "existing checkout at $Dir (origin: $origin). Updating..."
        & git -C $Dir fetch --tags origin $Branch; if ($LASTEXITCODE -ne 0) { DieM 'git fetch failed.' }
        & git -C $Dir checkout $Branch;            if ($LASTEXITCODE -ne 0) { DieM "git checkout $Branch failed." }
        & git -C $Dir pull --ff-only origin $Branch
        if ($LASTEXITCODE -ne 0) { DieM 'git pull failed (non-fast-forward? stash or reset your local changes first).' }
        Ok "pulled latest $Branch"
        return
    }
    if (Test-Path $Dir) {
        DieM "$Dir already exists and is not a git repo. Move it aside or pass -Dir somewhere else."
    }
    Say "cloning $Repo -> $Dir"
    & git clone --branch $Branch $Repo $Dir
    if ($LASTEXITCODE -ne 0) { DieM 'git clone failed.' }
    Ok 'cloned'
}

# ---------------------------------------------------------------------------
# Install deps + build
# ---------------------------------------------------------------------------
function Install-Deps-And-Build() {
    Push-Location $Dir
    try {
        Say 'pnpm install...'
        & pnpm install
        if ($LASTEXITCODE -ne 0) { DieM 'pnpm install failed.' }
        Ok 'dependencies installed'

        if ($SkipBuild) {
            WarnM '-SkipBuild: leaving web/dist unbuilt. Start with `pnpm serve` to build+run.'
            return
        }
        Say 'building web bundle...'
        & pnpm --filter '@claudex/web' build
        if ($LASTEXITCODE -ne 0) { DieM 'web build failed.' }
        Ok 'web bundle built'
    } finally {
        Pop-Location
    }
}

# ---------------------------------------------------------------------------
# First-admin init
# ---------------------------------------------------------------------------
function StateDir() {
    if ($env:CLAUDEX_STATE_DIR) { return $env:CLAUDEX_STATE_DIR }
    return Join-Path $env:USERPROFILE '.claudex'
}

function Already-Initialized() {
    return Test-Path (Join-Path (StateDir) 'claudex.db')
}

function SecureString-ToPlain([System.Security.SecureString]$s) {
    $ptr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try   { return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function Do-Init() {
    if ($SkipInit) {
        WarnM "-SkipInit: leaving credentials unset. Run ``cd $Dir; pnpm run init`` when ready."
        return
    }
    if (Already-Initialized) {
        Ok "existing admin detected in $((StateDir)) — skipping init"
        WarnM "To rotate credentials later: ``cd $Dir; pnpm reset-credentials``"
        return
    }

    Say 'creating your first admin account'
    Write-Host '(password will not be shown as you type)' -ForegroundColor DarkGray

    $username = ''
    while (-not $username) {
        $username = Read-Host '? Username'
        if (-not $username) { WarnM 'username cannot be empty' }
    }

    $password = $null
    while ($true) {
        $pSec = Read-Host '? Password (>= 8 chars)' -AsSecureString
        $p    = SecureString-ToPlain $pSec
        if ($p.Length -lt 8) { WarnM 'too short (min 8).'; continue }
        $cSec = Read-Host '? Confirm password' -AsSecureString
        $c    = SecureString-ToPlain $cSec
        if ($p -ne $c) { WarnM 'passwords did not match, try again.'; continue }
        $password = $p
        $c = ''; $cSec = $null; $pSec = $null
        break
    }

    Say 'running `pnpm run init` to provision TOTP + recovery codes...'
    $env:CLAUDEX_INIT_USERNAME = $username
    $env:CLAUDEX_INIT_PASSWORD = $password
    try {
        Push-Location $Dir
        & pnpm run init
        $rc = $LASTEXITCODE
        Pop-Location
    } finally {
        Remove-Item Env:CLAUDEX_INIT_USERNAME -ErrorAction SilentlyContinue
        Remove-Item Env:CLAUDEX_INIT_PASSWORD -ErrorAction SilentlyContinue
        $password = ''
    }

    if ($rc -ne 0) {
        DieM "pnpm run init failed (exit $rc). Delete $((StateDir))\claudex.db and rerun if partially provisioned."
    }

    Banner '⚠  Save the TOTP secret AND recovery codes above — shown once only.'
    if (-not $Yes) {
        Read-Host '? Press Enter once you have saved them to finish' | Out-Null
    }
    Ok 'admin account created'
}

# ---------------------------------------------------------------------------
# Daemonize via pm2 (Windows's answer to launchd / systemd --user).
#
# Idempotent: rerun == refresh. If pm2 / pm2-windows-startup aren't present,
# installs them globally via npm. Uses `pm2 startOrReload` so a second run
# just picks up the latest ecosystem config.
# ---------------------------------------------------------------------------
function Ensure-Pm2() {
    if (-not (Have 'pm2')) {
        Say 'installing pm2 globally via npm...'
        & npm install -g pm2
        if ($LASTEXITCODE -ne 0) { DieM 'pm2 install failed.' }
        Refresh-Env
    }
    if (-not (Have 'pm2')) { DieM 'pm2 still not on PATH after install.' }
    if (-not (Have 'pm2-startup')) {
        Say 'installing pm2-windows-startup globally via npm...'
        & npm install -g pm2-windows-startup
        if ($LASTEXITCODE -ne 0) {
            WarnM 'pm2-windows-startup install failed. Daemon will run now but won''t auto-start on reboot.'
        } else {
            Refresh-Env
        }
    }
}

function Setup-Daemon() {
    $script:DaemonRunning = $false
    if ($SkipDaemon) {
        WarnM "-SkipDaemon: skipping pm2 registration. Start manually with ``cd $Dir; pnpm start``."
        return
    }
    if (-not (Confirm-Step 'Run claudex in the background via pm2 (auto-restart + boot)?' $true)) {
        WarnM "skipping daemon setup. Start manually with ``cd $Dir; pnpm start`` when ready."
        return
    }

    Ensure-Pm2

    Push-Location $Dir
    try {
        Say 'registering claudex with pm2...'
        & pm2 startOrReload ecosystem.config.cjs | Out-Host
        if ($LASTEXITCODE -ne 0) { DieM "pm2 start failed (exit $LASTEXITCODE). Check ``pm2 logs claudex``." }
        & pm2 save | Out-Host
    } finally {
        Pop-Location
    }

    if (Have 'pm2-startup') {
        Say 'registering pm2 for auto-start on login...'
        & pm2-startup install | Out-Host
        if ($LASTEXITCODE -ne 0) {
            WarnM 'pm2-startup install failed; daemon will still run now but may not auto-start after reboot.'
        }
    }

    Ok 'claudex is running under pm2'
    $script:DaemonRunning = $true
}

# ---------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------
Refresh-Env
Say "claudex installer — windows"
Say "install dir: $Dir"

Say 'checking dependencies'
Ensure-Git
Ensure-Node
Ensure-Pnpm
Ensure-Claude

Clone-Or-Update
Install-Deps-And-Build
Do-Init
Setup-Daemon

Write-Host ''
if ($script:UseColor) {
    Write-Host '✓ claudex installed.' -ForegroundColor Green
} else {
    Write-Host '[ok] claudex installed.'
}
Write-Host ''
if ($script:DaemonRunning) {
    Write-Host 'claudex is running under pm2:'
    Write-Host '  pm2 status         # check process state'
    Write-Host '  pm2 logs claudex   # tail stdout/stderr'
    Write-Host '  pm2 restart claudex'
    Write-Host '  pm2 stop claudex'
    Write-Host ''
    Write-Host 'Open http://127.0.0.1:5179'
} else {
    Write-Host 'Next steps:'
    Write-Host "  cd $Dir"
    Write-Host '  pnpm start   # or `pnpm serve` if you passed -SkipBuild'
    Write-Host '  open http://127.0.0.1:5179'
}
Write-Host ''
Write-Host 'Remote access: claudex binds to 127.0.0.1 only by design. Put a tunnel'
Write-Host '(Cloudflare Tunnel, frp, Tailscale Funnel, Caddy, ...) in front. See README.'

if ($script:TranscriptStarted) { try { Stop-Transcript | Out-Null } catch {} }
