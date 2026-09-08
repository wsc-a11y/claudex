#!/usr/bin/env bash
# claudex one-liner installer for macOS / Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/aaravarr/claudex/main/install.sh | bash
#
# or, after downloading:
#
#   bash install.sh [--dir PATH] [--branch NAME] [--yes] [--skip-init] [--skip-build]
#
# What it does:
#   1. Checks git / node(>=20) / pnpm(>=9) / claude. Offers to install missing
#      deps (opt-in; never silently pulls in system-wide tools).
#   2. Clones https://github.com/aaravarr/claudex to ~/claudex (override with
#      --dir or CLAUDEX_HOME).
#   3. Runs `pnpm install` and `pnpm --filter @claudex/web build`.
#   4. Interactively collects admin username + password (hidden) and drives
#      `pnpm run init` via env vars so the TOTP QR + recovery codes print, then
#      pauses on a banner so the user actually saves them.
#   5. Offers to register claudex as a user-scoped daemon (launchd on macOS,
#      systemd --user on Linux) — user-level only, no sudo. Pass --skip-daemon
#      to opt out.
#
# Honors:
#   CLAUDEX_HOME         install dir (default: ~/claudex)
#   CLAUDEX_REPO         git URL (default: https://github.com/aaravarr/claudex.git)
#   CLAUDEX_BRANCH       branch to check out (default: main)
#   CLAUDEX_ASSUME_YES   non-interactive, auto-approve every prompt
#   NO_COLOR             disable ANSI colors
#   HTTP_PROXY / HTTPS_PROXY   respected by git / curl / nvm / npm / pnpm
#
# Never uses sudo implicitly. The only sudo path is Linux package-manager git
# install, and we always ask first.
set -euo pipefail

# ---------------------------------------------------------------------------
# Styling
# ---------------------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_CYAN=$'\033[36m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_CYAN=''
fi

say()  { printf '%s==>%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
ok()   { printf '%s[ok]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%s[err]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

banner() {
  printf '\n%s%s╭──────────────────────────────────────────────────────────────╮%s\n' "$C_BOLD" "$C_YELLOW" "$C_RESET"
  printf '%s%s│  %s  │%s\n' "$C_BOLD" "$C_YELLOW" "$1" "$C_RESET"
  printf '%s%s╰──────────────────────────────────────────────────────────────╯%s\n\n' "$C_BOLD" "$C_YELLOW" "$C_RESET"
}

# ---------------------------------------------------------------------------
# Logging — tee everything to a file so the user can always read the errors
# back, even if the terminal window is closed/scrolled past / the curl | bash
# pipeline dies mid-stream.
# ---------------------------------------------------------------------------
CLAUDEX_INSTALL_LOG="${CLAUDEX_INSTALL_LOG:-$HOME/.claudex-install.log}"
# Best-effort: if we can't create the log (read-only $HOME etc.), fall back to /tmp.
if ! { : >"$CLAUDEX_INSTALL_LOG"; } 2>/dev/null; then
  CLAUDEX_INSTALL_LOG="/tmp/claudex-install-$$.log"
  : >"$CLAUDEX_INSTALL_LOG" 2>/dev/null || CLAUDEX_INSTALL_LOG=""
fi
if [ -n "$CLAUDEX_INSTALL_LOG" ]; then
  # shellcheck disable=SC2094
  exec > >(tee -a "$CLAUDEX_INSTALL_LOG") 2> >(tee -a "$CLAUDEX_INSTALL_LOG" >&2)
  printf '\n===== claudex install log — %s =====\n' "$(date 2>/dev/null || echo now)" >>"$CLAUDEX_INSTALL_LOG"
fi

# ---------------------------------------------------------------------------
# ERR trap: identify the failing command & line number for the log
# ---------------------------------------------------------------------------
_last_cmd=""
trap '_last_cmd=$BASH_COMMAND' DEBUG
_on_err() {
  local code=$?
  printf '\n%s[err]%s line %s: command failed (exit %s): %s\n' \
    "$C_RED" "$C_RESET" "${BASH_LINENO[0]:-?}" "$code" "$_last_cmd" >&2
}
trap _on_err ERR

# ---------------------------------------------------------------------------
# EXIT trap: ALWAYS restore the terminal and, on failure, pause so the user
# can read the error before their shell window disappears. Users have
# reported "the terminal closes before I can see what went wrong" — this is
# the guard.
# ---------------------------------------------------------------------------
_on_exit() {
  local code=$?
  # Always restore echo in case a password prompt was mid-flight.
  stty echo 2>/dev/null || true
  if [ "$code" -ne 0 ]; then
    printf '\n%s[!]%s install failed with exit code %s.\n' "$C_RED" "$C_RESET" "$code" >&2
    if [ -n "${CLAUDEX_INSTALL_LOG:-}" ]; then
      printf '    full log: %s\n' "$CLAUDEX_INSTALL_LOG" >&2
    fi
    printf '    re-run with CLAUDEX_DEBUG=1 for a verbose trace.\n' >&2
    # Pause so the window doesn't slam shut. Skip only when the user has
    # explicitly opted out via CLAUDEX_ASSUME_YES=1 (scripts / CI).
    if [ -z "${CLAUDEX_ASSUME_YES:-}" ] && [ -c /dev/tty ]; then
      printf '    press Enter to close...' >&2
      # Read straight from the tty so a dead curl | bash pipeline can't
      # swallow the Enter keystroke.
      read -r _ </dev/tty 2>/dev/null || true
    fi
  fi
}
trap _on_exit EXIT

# Debug mode: CLAUDEX_DEBUG=1 → echo every command. Useful bug-report attachment.
if [ -n "${CLAUDEX_DEBUG:-}" ]; then
  set -x
fi

# ---------------------------------------------------------------------------
# Re-bind stdin to TTY when invoked via `curl ... | bash`. Guard against
# environments where /dev/tty exists but cannot be opened (orphaned
# sub-shells, some container setups) — we don't die, we just fall back to
# pipe stdin and let the confirmation prompts read whatever they can.
# ---------------------------------------------------------------------------
if [ ! -t 0 ]; then
  # Probe /dev/tty without redirecting the shell's own fds. A successful probe
  # means we can re-open it for real in the next step.
  if [ -c /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
    exec </dev/tty
  elif [ -z "${CLAUDEX_ASSUME_YES:-}" ]; then
    die "stdin is not a terminal (and /dev/tty can't be opened). Re-run locally (\`bash install.sh\`) or set CLAUDEX_ASSUME_YES=1."
  fi
fi

# ---------------------------------------------------------------------------
# Argument / env defaults
# ---------------------------------------------------------------------------
CLAUDEX_HOME="${CLAUDEX_HOME:-$HOME/claudex}"
CLAUDEX_REPO="${CLAUDEX_REPO:-https://github.com/aaravarr/claudex.git}"
CLAUDEX_BRANCH="${CLAUDEX_BRANCH:-main}"
ASSUME_YES="${CLAUDEX_ASSUME_YES:-}"
SKIP_INIT=0
SKIP_BUILD=0
SKIP_DAEMON="${CLAUDEX_SKIP_DAEMON:-0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dir)         CLAUDEX_HOME="$2"; shift 2 ;;
    --dir=*)       CLAUDEX_HOME="${1#*=}"; shift ;;
    --branch)      CLAUDEX_BRANCH="$2"; shift 2 ;;
    --branch=*)    CLAUDEX_BRANCH="${1#*=}"; shift ;;
    --repo)        CLAUDEX_REPO="$2"; shift 2 ;;
    --repo=*)      CLAUDEX_REPO="${1#*=}"; shift ;;
    --yes|-y)      ASSUME_YES=1; shift ;;
    --skip-init)   SKIP_INIT=1; shift ;;
    --skip-build)  SKIP_BUILD=1; shift ;;
    --skip-daemon) SKIP_DAEMON=1; shift ;;
    --debug)       set -x; shift ;;
    -h|--help)
      cat <<EOF
claudex installer

Usage: bash install.sh [options]

Options:
  --dir PATH        Install directory (default: \$HOME/claudex)
  --branch NAME     Git branch (default: main)
  --repo URL        Git repo (default: https://github.com/aaravarr/claudex.git)
  --yes, -y         Skip all confirmation prompts
  --skip-init       Do not run the first-admin setup (pnpm run init)
  --skip-build      Do not build the web bundle
  --skip-daemon     Do not register claudex as a user-scoped daemon
  --debug           Verbose trace (\`set -x\`) for bug reports

Env vars: CLAUDEX_HOME, CLAUDEX_REPO, CLAUDEX_BRANCH, CLAUDEX_ASSUME_YES,
CLAUDEX_SKIP_DAEMON, CLAUDEX_INSTALL_LOG (path to log file),
CLAUDEX_DEBUG, NO_COLOR.

On failure the script pauses with "press Enter to close" so the error
stays on screen even if your terminal closes on process exit. A full
log is always written to \$CLAUDEX_INSTALL_LOG (default: ~/.claudex-install.log).
EOF
      exit 0
      ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

# Tilde expansion if user passed --dir=~/foo via env
case "$CLAUDEX_HOME" in "~"*) CLAUDEX_HOME="${HOME}${CLAUDEX_HOME#\~}";; esac

# ---------------------------------------------------------------------------
# Prompt helpers
# ---------------------------------------------------------------------------
confirm() {
  local prompt="$1" default="${2:-n}" reply
  if [ -n "$ASSUME_YES" ]; then
    return 0
  fi
  local hint="[y/N]"; [ "$default" = "y" ] && hint="[Y/n]"
  printf '%s?%s %s %s ' "$C_BLUE" "$C_RESET" "$prompt" "$hint"
  IFS= read -r reply || reply=""
  reply="${reply:-$default}"
  case "$reply" in
    y|Y|yes|YES) return 0 ;;
    *)           return 1 ;;
  esac
}

read_hidden() {
  # $1 = prompt, echoes value on stdout.
  # Terminal echo is restored by the global EXIT trap (see _on_exit) even on
  # Ctrl-C, so we don't need a local trap here — and we must NOT install one,
  # since it would clobber _on_exit.
  local prompt="$1" value saved
  printf '%s' "$prompt" >&2
  saved="$(stty -g 2>/dev/null || true)"
  stty -echo 2>/dev/null || true
  IFS= read -r value || value=""
  if [ -n "$saved" ]; then
    stty "$saved" 2>/dev/null || stty echo 2>/dev/null || true
  else
    stty echo 2>/dev/null || true
  fi
  printf '\n' >&2
  printf '%s' "$value"
}

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------
OS="$(uname -s 2>/dev/null || echo unknown)"
case "$OS" in
  Darwin) PLATFORM=macos ;;
  Linux)  PLATFORM=linux ;;
  *)      die "unsupported OS: $OS (this script targets macOS and Linux; use install.ps1 on Windows)" ;;
esac

LINUX_PKG=""
if [ "$PLATFORM" = linux ] && [ -r /etc/os-release ]; then
  . /etc/os-release
  case "${ID:-}${ID_LIKE:-}" in
    *debian*|*ubuntu*) LINUX_PKG="apt" ;;
    *fedora*|*rhel*|*centos*) LINUX_PKG="dnf" ;;
    *arch*|*manjaro*)  LINUX_PKG="pacman" ;;
    *suse*|*opensuse*) LINUX_PKG="zypper" ;;
    *alpine*)          LINUX_PKG="apk" ;;
  esac
fi

say "claudex installer — ${C_BOLD}${PLATFORM}${C_RESET}"
say "install dir: ${C_BOLD}${CLAUDEX_HOME}${C_RESET}"

# ---------------------------------------------------------------------------
# Dependency: git
# ---------------------------------------------------------------------------
ensure_git() {
  if command -v git >/dev/null 2>&1; then
    ok "git $(git --version | awk '{print $3}')"
    return
  fi
  warn "git not found."
  if [ "$PLATFORM" = macos ]; then
    if confirm "Trigger Xcode Command Line Tools installer (opens a GUI dialog)?" n; then
      xcode-select --install || true
      die "Please rerun this script after the Xcode CLT install finishes."
    fi
    die "git is required. Install it (Xcode CLT or Homebrew) and rerun."
  fi
  # Linux
  if [ -z "$LINUX_PKG" ]; then
    die "git missing and I can't detect your package manager. Install git manually and rerun."
  fi
  local cmd
  case "$LINUX_PKG" in
    apt)    cmd="sudo apt-get update && sudo apt-get install -y git" ;;
    dnf)    cmd="sudo dnf install -y git" ;;
    pacman) cmd="sudo pacman -S --noconfirm git" ;;
    zypper) cmd="sudo zypper install -y git" ;;
    apk)    cmd="sudo apk add --no-cache git" ;;
  esac
  if confirm "Run: $cmd ?" y; then
    eval "$cmd" || die "git install failed."
    ok "git installed"
  else
    die "git is required."
  fi
}

# ---------------------------------------------------------------------------
# Dependency: node >= 20 (via nvm for the no-sudo path)
# ---------------------------------------------------------------------------
NVM_DIR_DEFAULT="${NVM_DIR:-$HOME/.nvm}"

load_nvm_if_present() {
  if [ -s "$NVM_DIR_DEFAULT/nvm.sh" ]; then
    # shellcheck disable=SC1090
    export NVM_DIR="$NVM_DIR_DEFAULT"
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
    return 0
  fi
  return 1
}

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -v | sed -E 's/^v([0-9]+).*/\1/'
}

ensure_node() {
  local major; major="$(node_major)"
  if [ "$major" -ge 20 ] 2>/dev/null; then
    ok "node $(node -v)"
    return
  fi
  if [ "$major" -gt 0 ] 2>/dev/null; then
    warn "node $(node -v) is too old (need >= 20)."
  else
    warn "node not found."
  fi

  # If nvm is already on disk, try loading it first.
  if load_nvm_if_present; then
    if nvm install 20 >/dev/null 2>&1 && nvm alias default 20 >/dev/null 2>&1; then
      nvm use 20 >/dev/null
      ok "node $(node -v) (via existing nvm)"
      return
    fi
  fi

  if ! confirm "Install Node.js 20 via nvm (user-local, no sudo)?" y; then
    die "Node 20+ is required. Install it manually and rerun."
  fi

  say "installing nvm..."
  if ! command -v curl >/dev/null 2>&1; then
    die "curl is required to install nvm. Install curl and rerun."
  fi
  # Pinned nvm version; bump as needed.
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | PROFILE=/dev/null bash \
    || die "nvm install failed."
  export NVM_DIR="$NVM_DIR_DEFAULT"
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh" || die "nvm loaded failed after install."

  say "installing node 20..."
  nvm install 20 || die "node install failed."
  nvm alias default 20 >/dev/null
  nvm use 20 >/dev/null
  ok "node $(node -v)"
  warn "nvm was installed. To make \`node\` available in new shells, add this to your shell rc if it isn't already:"
  printf '  export NVM_DIR="$HOME/.nvm"\n  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"\n'
}

# ---------------------------------------------------------------------------
# Dependency: pnpm >= 9 (via corepack, bundled with node)
# ---------------------------------------------------------------------------
pnpm_major() {
  command -v pnpm >/dev/null 2>&1 || { echo 0; return; }
  pnpm -v 2>/dev/null | awk -F. '{print $1+0}'
}

ensure_pnpm() {
  local major; major="$(pnpm_major)"
  if [ "$major" -ge 9 ] 2>/dev/null; then
    ok "pnpm $(pnpm -v)"
    return
  fi
  if [ "$major" -gt 0 ] 2>/dev/null; then
    warn "pnpm $(pnpm -v) is too old (need >= 9)."
  else
    warn "pnpm not found."
  fi
  if ! command -v corepack >/dev/null 2>&1; then
    die "corepack not found (comes bundled with Node 16+). Reinstall Node and rerun."
  fi
  if ! confirm "Enable pnpm via corepack?" y; then
    die "pnpm is required."
  fi
  corepack enable >/dev/null 2>&1 || true
  corepack prepare pnpm@latest --activate >/dev/null \
    || die "corepack failed to activate pnpm."
  hash -r 2>/dev/null || true
  ok "pnpm $(pnpm -v)"
}

# ---------------------------------------------------------------------------
# Dependency: claude CLI (optional, strongly recommended)
# ---------------------------------------------------------------------------
ensure_claude_cli() {
  if command -v claude >/dev/null 2>&1; then
    ok "claude $(claude --version 2>/dev/null | head -n1 || echo ?)"
    return
  fi
  warn "\`claude\` CLI not found. claudex drives the CLI as a subprocess — without it, sessions won't run."
  if ! confirm "Install @anthropic-ai/claude-code globally via npm now?" y; then
    warn "skipping. Install later with: npm install -g @anthropic-ai/claude-code"
    return
  fi
  if ! npm install -g @anthropic-ai/claude-code; then
    warn "npm install failed. You may need sudo if node came from your system package manager."
    warn "Fallback: install nvm (this installer offers that), then retry."
    return
  fi
  ok "claude $(claude --version 2>/dev/null | head -n1 || echo installed)"
  warn "Remember to log in: \`claude login\` (first run will prompt)."
}

# ---------------------------------------------------------------------------
# Clone / update the repo
# ---------------------------------------------------------------------------
clone_or_update() {
  if [ -d "$CLAUDEX_HOME/.git" ]; then
    local origin
    origin="$(git -C "$CLAUDEX_HOME" remote get-url origin 2>/dev/null || echo '')"
    if [ -z "$origin" ]; then
      die "$CLAUDEX_HOME exists and is a git repo but has no origin remote. Refusing to touch."
    fi
    say "existing checkout at $CLAUDEX_HOME (origin: $origin). Updating..."
    git -C "$CLAUDEX_HOME" fetch --tags origin "$CLAUDEX_BRANCH" \
      || die "git fetch failed."
    git -C "$CLAUDEX_HOME" checkout "$CLAUDEX_BRANCH" \
      || die "git checkout $CLAUDEX_BRANCH failed."
    git -C "$CLAUDEX_HOME" pull --ff-only origin "$CLAUDEX_BRANCH" \
      || die "git pull failed (non-fast-forward? stash or reset your local changes first)."
    ok "pulled latest $CLAUDEX_BRANCH"
    return
  fi

  if [ -e "$CLAUDEX_HOME" ]; then
    die "$CLAUDEX_HOME already exists and is not a git repo. Move it aside or pass --dir somewhere else."
  fi
  say "cloning $CLAUDEX_REPO -> $CLAUDEX_HOME"
  git clone --branch "$CLAUDEX_BRANCH" "$CLAUDEX_REPO" "$CLAUDEX_HOME" \
    || die "git clone failed."
  ok "cloned"
}

# ---------------------------------------------------------------------------
# Install deps + build
# ---------------------------------------------------------------------------
install_deps_and_build() {
  cd "$CLAUDEX_HOME"
  say "pnpm install..."
  pnpm install || die "pnpm install failed."
  ok "dependencies installed"

  if [ "$SKIP_BUILD" -eq 1 ]; then
    warn "--skip-build: leaving web/dist unbuilt. Start with \`pnpm serve\` to build+run."
    return
  fi
  say "building web bundle..."
  pnpm --filter @claudex/web build || die "web build failed."
  ok "web bundle built"
}

# ---------------------------------------------------------------------------
# First-admin init (drives pnpm run init via env vars)
# ---------------------------------------------------------------------------
already_initialized() {
  local state="${CLAUDEX_STATE_DIR:-$HOME/.claudex}"
  [ -f "$state/claudex.db" ]
}

do_init() {
  if [ "$SKIP_INIT" -eq 1 ]; then
    warn "--skip-init: leaving credentials unset. Run \`cd $CLAUDEX_HOME && pnpm run init\` when ready."
    return
  fi
  if already_initialized; then
    ok "existing admin detected in ${CLAUDEX_STATE_DIR:-$HOME/.claudex}/claudex.db — skipping init"
    warn "To rotate credentials later: \`cd $CLAUDEX_HOME && pnpm reset-credentials\`"
    return
  fi

  say "creating your first admin account"
  printf '%s(password will not be shown as you type)%s\n' "$C_DIM" "$C_RESET"

  local username password confirm
  while true; do
    printf '%s?%s Username: ' "$C_BLUE" "$C_RESET"
    IFS= read -r username || username=""
    [ -n "$username" ] && break
    warn "username cannot be empty"
  done
  while true; do
    password="$(read_hidden "$(printf '%s?%s Password (>= 8 chars): ' "$C_BLUE" "$C_RESET")")"
    if [ "${#password}" -lt 8 ]; then
      warn "too short (min 8)."
      continue
    fi
    confirm="$(read_hidden "$(printf '%s?%s Confirm password: ' "$C_BLUE" "$C_RESET")")"
    if [ "$password" != "$confirm" ]; then
      warn "passwords did not match, try again."
      continue
    fi
    break
  done

  say "running \`pnpm run init\` to provision TOTP + recovery codes..."
  # Use env vars (not argv) so the password never lands in /proc/*/cmdline.
  # `pnpm run init` sees the env vars and takes its non-interactive branch — it
  # prints the QR + codes and returns immediately. We own the "press enter"
  # pause so the user can't miss them.
  set +e
  (
    cd "$CLAUDEX_HOME"
    CLAUDEX_INIT_USERNAME="$username" \
    CLAUDEX_INIT_PASSWORD="$password" \
    pnpm run init
  )
  local rc=$?
  set -e
  # Scrub the plaintext from our own env.
  password=""; confirm=""
  unset CLAUDEX_INIT_USERNAME CLAUDEX_INIT_PASSWORD 2>/dev/null || true

  if [ $rc -ne 0 ]; then
    die "pnpm run init failed (exit $rc). Delete ~/.claudex/claudex.db and rerun if partially provisioned."
  fi

  banner "⚠  Save the TOTP secret AND recovery codes above — shown once only."
  if [ -z "$ASSUME_YES" ]; then
    printf '%s?%s Press Enter once you have saved them to finish... ' "$C_BLUE" "$C_RESET"
    IFS= read -r _ || true
  fi
  ok "admin account created"
}

# ---------------------------------------------------------------------------
# Daemonize via the host's native user-scoped service manager. User-level
# only — no sudo. Idempotent: rerun == refresh.
#
#   macOS → launchd user agent at ~/Library/LaunchAgents/com.claudex.server.plist
#   Linux → systemd --user unit at  ~/.config/systemd/user/claudex.service
#
# Persistence caveats worth knowing:
#   - macOS launchd user agents start when the user logs into the GUI.
#     `launchctl bootstrap gui/$UID` binds it to the current GUI session.
#   - Linux user units require an active user systemd instance. For
#     "run even when nobody is logged in", run `sudo loginctl enable-linger
#     $USER` — we don't auto-run sudo, but we print the hint.
# ---------------------------------------------------------------------------
LAUNCHD_LABEL="com.claudex.server"
LAUNCHD_PLIST="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
SYSTEMD_UNIT="$HOME/.config/systemd/user/claudex.service"

xml_escape() {
  # stdin -> stdout, escape & < > for XML text/attribute content.
  sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

setup_daemon_macos() {
  local pnpm_bin pnpm_dir log_dir state_dir
  pnpm_bin="$(command -v pnpm)" || die "pnpm missing (shouldn't happen — ensure_pnpm ran)"
  pnpm_dir="$(dirname "$pnpm_bin")"
  state_dir="${CLAUDEX_STATE_DIR:-$HOME/.claudex}"
  log_dir="$state_dir/logs"
  mkdir -p "$log_dir" "$(dirname "$LAUNCHD_PLIST")"

  local home_esc cwd_esc pnpm_esc path_esc out_esc err_esc
  home_esc="$(printf '%s' "$HOME" | xml_escape)"
  cwd_esc="$(printf '%s' "$CLAUDEX_HOME" | xml_escape)"
  pnpm_esc="$(printf '%s' "$pnpm_bin" | xml_escape)"
  path_esc="$(printf '%s:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' "$pnpm_dir" | xml_escape)"
  out_esc="$(printf '%s/claudex.out.log' "$log_dir" | xml_escape)"
  err_esc="$(printf '%s/claudex.err.log' "$log_dir" | xml_escape)"

  say "writing ${LAUNCHD_PLIST}..."
  cat >"$LAUNCHD_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${pnpm_esc}</string>
        <string>start</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${cwd_esc}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${home_esc}</string>
        <key>PATH</key>
        <string>${path_esc}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${out_esc}</string>
    <key>StandardErrorPath</key>
    <string>${err_esc}</string>
</dict>
</plist>
EOF

  # Idempotency: unload any previous copy first.
  launchctl bootout "gui/$(id -u)" "$LAUNCHD_PLIST" >/dev/null 2>&1 || true
  launchctl unload "$LAUNCHD_PLIST" >/dev/null 2>&1 || true

  if launchctl bootstrap "gui/$(id -u)" "$LAUNCHD_PLIST" >/dev/null 2>&1; then
    :
  elif launchctl load -w "$LAUNCHD_PLIST" >/dev/null 2>&1; then
    :
  else
    warn "failed to load launchd agent. Try: launchctl load -w $LAUNCHD_PLIST"
    return 1
  fi
  ok "launchd agent loaded (label: ${LAUNCHD_LABEL})"
  printf '  logs: %s\n' "$log_dir"
  printf '  manage:\n'
  printf '    launchctl kickstart -k gui/$(id -u)/%s    # restart\n' "$LAUNCHD_LABEL"
  printf '    launchctl bootout gui/$(id -u) %s    # stop/remove\n' "$LAUNCHD_PLIST"
  return 0
}

setup_daemon_linux() {
  if ! command -v systemctl >/dev/null 2>&1; then
    warn "systemctl not found. Skipping daemon setup; run manually:"
    printf '  nohup pnpm start >%s/logs/claudex.out.log 2>&1 &\n' "${CLAUDEX_STATE_DIR:-$HOME/.claudex}"
    return 1
  fi
  if ! systemctl --user show-environment >/dev/null 2>&1; then
    warn "user systemd instance not available (headless container / no session). Skipping."
    printf '  nohup pnpm start >%s/logs/claudex.out.log 2>&1 &\n' "${CLAUDEX_STATE_DIR:-$HOME/.claudex}"
    return 1
  fi

  local pnpm_bin pnpm_dir state_dir log_dir
  pnpm_bin="$(command -v pnpm)" || die "pnpm missing (shouldn't happen — ensure_pnpm ran)"
  pnpm_dir="$(dirname "$pnpm_bin")"
  state_dir="${CLAUDEX_STATE_DIR:-$HOME/.claudex}"
  log_dir="$state_dir/logs"
  mkdir -p "$log_dir" "$(dirname "$SYSTEMD_UNIT")"

  say "writing ${SYSTEMD_UNIT}..."
  cat >"$SYSTEMD_UNIT" <<EOF
[Unit]
Description=claudex — remote control for claude code
After=network.target

[Service]
Type=simple
WorkingDirectory=${CLAUDEX_HOME}
Environment=PATH=${pnpm_dir}:/usr/local/bin:/usr/bin:/bin
Environment=HOME=${HOME}
ExecStart=${pnpm_bin} start
Restart=on-failure
RestartSec=5
StandardOutput=append:${log_dir}/claudex.out.log
StandardError=append:${log_dir}/claudex.err.log

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now claudex.service \
    || { warn "systemctl --user enable failed. Try: journalctl --user -u claudex.service"; return 1; }

  ok "systemd --user unit enabled: claudex.service"
  printf '  logs: %s\n' "$log_dir"
  printf '  manage:\n'
  printf '    systemctl --user status  claudex.service\n'
  printf '    systemctl --user restart claudex.service\n'
  printf '    systemctl --user stop    claudex.service    # stop\n'
  printf '    systemctl --user disable --now claudex.service    # remove\n'
  if ! loginctl show-user "$USER" 2>/dev/null | grep -q 'Linger=yes'; then
    warn "tip: for run-without-login, run: sudo loginctl enable-linger $USER"
  fi
  return 0
}

setup_daemon() {
  if [ "$SKIP_DAEMON" -eq 1 ]; then
    warn "--skip-daemon: skipping daemon registration. Start manually: cd $CLAUDEX_HOME && pnpm start"
    return 1
  fi
  local prompt
  if [ "$PLATFORM" = macos ]; then
    prompt="Register claudex as a launchd user agent (auto-start on login)?"
  else
    prompt="Register claudex as a systemd --user unit (auto-restart on failure)?"
  fi
  if ! confirm "$prompt" y; then
    warn "skipping daemon setup. Start manually: cd $CLAUDEX_HOME && pnpm start"
    return 1
  fi

  case "$PLATFORM" in
    macos) setup_daemon_macos ;;
    linux) setup_daemon_linux ;;
  esac
}

# ---------------------------------------------------------------------------
# Main flow
# ---------------------------------------------------------------------------
say "checking dependencies"
ensure_git
ensure_node
ensure_pnpm
ensure_claude_cli

clone_or_update
install_deps_and_build
do_init
DAEMON_RUNNING=0
if setup_daemon; then
  DAEMON_RUNNING=1
fi

printf '\n%s%s✓ claudex installed.%s\n\n' "$C_GREEN" "$C_BOLD" "$C_RESET"
if [ "$DAEMON_RUNNING" -eq 1 ]; then
  if [ "$PLATFORM" = macos ]; then
    cat <<EOF
claudex is running as a launchd user agent (${LAUNCHD_LABEL}).
  ${C_BOLD}launchctl kickstart -k gui/\$(id -u)/${LAUNCHD_LABEL}${C_RESET}   # restart
  ${C_BOLD}launchctl bootout   gui/\$(id -u) ${LAUNCHD_PLIST}${C_RESET}   # stop/remove

Open ${C_CYAN}http://127.0.0.1:5179${C_RESET}
EOF
  else
    cat <<EOF
claudex is running as a systemd --user unit (claudex.service).
  ${C_BOLD}systemctl --user status  claudex.service${C_RESET}
  ${C_BOLD}systemctl --user restart claudex.service${C_RESET}
  ${C_BOLD}systemctl --user disable --now claudex.service${C_RESET}  # remove

Open ${C_CYAN}http://127.0.0.1:5179${C_RESET}
EOF
  fi
else
  cat <<EOF
Next steps:
  ${C_BOLD}cd $CLAUDEX_HOME${C_RESET}
  ${C_BOLD}pnpm start${C_RESET}   # or \`pnpm serve\` if you passed --skip-build
  open ${C_CYAN}http://127.0.0.1:5179${C_RESET}
EOF
fi

cat <<EOF

Remote access: claudex binds to 127.0.0.1 only by design. Put a tunnel
(Cloudflare Tunnel, frp, Tailscale Funnel, Caddy, …) in front. See README.
EOF
