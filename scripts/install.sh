#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${ORCHESTRATOR_REPO_URL:-https://github.com/Horia73/orchestrator.git}"
BRANCH="${ORCHESTRATOR_BRANCH:-master}"
INSTALL_MODE="${ORCHESTRATOR_INSTALL_MODE:-auto}"
# Layout: code at $APP_DIR, runtime data at $ORCH_HOME (bind-mounted into the
# Docker container at /app/.orchestrator), container caches at $NODE_HOME_DIR.
# Separating code from data lets users back up data without the repo and lets
# the data dir grow with uploads without bloating the source checkout.
APP_DIR="${ORCHESTRATOR_APP_DIR:-$HOME/orchestrator}"
ORCH_HOME="${ORCHESTRATOR_HOME:-$HOME/.orchestrator}"
NODE_HOME_DIR="${ORCHESTRATOR_NODE_HOME:-$HOME/.orchestrator-node-home}"
PORT="${ORCHESTRATOR_PORT:-3000}"
HOST="${ORCHESTRATOR_HOST:-127.0.0.1}"
PUBLIC_URL="${ORCHESTRATOR_PUBLIC_URL:-}"
PUBLIC_HTTPS_SETUP="${ORCHESTRATOR_PUBLIC_HTTPS_SETUP:-${ORCHESTRATOR_HTTPS_SETUP:-}}"
DUCKDNS_DOMAIN="${ORCHESTRATOR_DUCKDNS_DOMAIN:-}"
DUCKDNS_TOKEN="${ORCHESTRATOR_DUCKDNS_TOKEN:-}"
LETSENCRYPT_EMAIL="${ORCHESTRATOR_LETSENCRYPT_EMAIL:-${LETSENCRYPT_EMAIL:-}}"
VNC_PORT="${ORCHESTRATOR_VNC_PORT:-${BROWSER_AGENT_VNC_WS_PORT:-6080}}"
UPDATE_BRIDGE_PORT="${ORCHESTRATOR_UPDATE_BRIDGE_PORT:-38733}"
UPDATE_BRIDGE_BIND="${ORCHESTRATOR_UPDATE_BRIDGE_BIND:-0.0.0.0}"
UPDATE_BRIDGE_TOKEN_FILE="${ORCHESTRATOR_UPDATE_TOKEN_FILE:-$ORCH_HOME/update-bridge-token}"
BIN_DIR="${ORCHESTRATOR_BIN_DIR:-$HOME/.local/bin}"
NPM_GLOBAL_PREFIX="${ORCHESTRATOR_NPM_GLOBAL_PREFIX:-$HOME/.npm-global}"
LOG_DIR="$ORCH_HOME/logs"
SERVICE_NAME="orchestrator"
UPDATE_BRIDGE_SERVICE_NAME="orchestrator-docker-update"
LAUNCHD_LABEL="com.horia.orchestrator"
INSTALL_LOG_FILE=""
SKIP_DOCTOR="${ORCHESTRATOR_SKIP_DOCTOR:-0}"

log() {
  printf '\033[1;34m[orchestrator]\033[0m %s\n' "$*"
}

fail() {
  printf '\033[1;31m[orchestrator]\033[0m %s\n' "$*" >&2
  exit 1
}

tty_available() {
  # /dev/tty can be opened. The simple [ -r ] / [ -w ] test gives false
  # positives in contexts like `docker exec` without -t, where the path
  # exists but actual I/O fails with ENXIO.
  { : < /dev/tty; } >/dev/null 2>&1
}

setup_install_logging() {
  mkdir -p "$LOG_DIR" 2>/dev/null || true
  INSTALL_LOG_FILE="$LOG_DIR/install-$(date +%Y%m%d-%H%M%S).log"
  {
    printf 'orchestrator install %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  uname: %s\n'  "$(uname -srm 2>/dev/null || true)"
    printf '  user:  %s\n'  "$(id -un 2>/dev/null || true)"
    printf '  home:  %s\n'  "$ORCH_HOME"
    printf '  log:   %s\n'  "$INSTALL_LOG_FILE"
  } > "$INSTALL_LOG_FILE" 2>/dev/null || true
  # Mirror stdout and stderr into the log. Failures here are non-fatal.
  exec > >(tee -a "$INSTALL_LOG_FILE") 2> >(tee -a "$INSTALL_LOG_FILE" >&2)
}

install_on_exit() {
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    if [ -n "$INSTALL_LOG_FILE" ]; then
      log "Install log: $INSTALL_LOG_FILE"
    fi
    return 0
  fi
  printf '\n\033[1;31m[orchestrator]\033[0m Install failed (exit %d).\n' "$rc" >&2
  if [ -n "$INSTALL_LOG_FILE" ]; then
    printf '\033[1;31m[orchestrator]\033[0m Log:   %s\n' "$INSTALL_LOG_FILE" >&2
  fi
  if [ -x "$APP_DIR/scripts/doctor.sh" ]; then
    printf '\033[1;31m[orchestrator]\033[0m Diagnose: %s/scripts/doctor.sh check\n' "$APP_DIR" >&2
  fi
}

prompt_yes_no() {
  local prompt default answer
  prompt="$1"
  default="${2:-n}"
  tty_available || return 1
  if [ "$default" = "y" ]; then
    printf '%s [Y/n] ' "$prompt" > /dev/tty
  else
    printf '%s [y/N] ' "$prompt" > /dev/tty
  fi
  IFS= read -r answer < /dev/tty || answer=""
  answer="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')"
  if [ -z "$answer" ]; then
    answer="$default"
  fi
  case "$answer" in
    y|yes) return 0 ;;
    *) return 1 ;;
  esac
}

prompt_value() {
  local prompt value
  prompt="$1"
  tty_available || return 1
  printf '%s' "$prompt" > /dev/tty
  IFS= read -r value < /dev/tty || value=""
  printf '%s' "$value"
}

prompt_secret() {
  local prompt value old_stty
  prompt="$1"
  tty_available || return 1
  printf '%s' "$prompt" > /dev/tty
  old_stty="$(stty -g < /dev/tty 2>/dev/null || true)"
  stty -echo < /dev/tty 2>/dev/null || true
  IFS= read -r value < /dev/tty || value=""
  if [ -n "$old_stty" ]; then
    stty "$old_stty" < /dev/tty 2>/dev/null || true
  else
    stty echo < /dev/tty 2>/dev/null || true
  fi
  printf '\n' > /dev/tty
  printf '%s' "$value"
}

run_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fail "Missing sudo. Install $1 manually and rerun."
  fi
}

ensure_user_npm_global_prefix() {
  mkdir -p "$NPM_GLOBAL_PREFIX/bin"
}

resolve_install_mode() {
  case "$INSTALL_MODE" in
    auto)
      if [ "$(uname -s)" = "Linux" ]; then
        printf 'docker'
      else
        printf 'native'
      fi
      ;;
    docker|native)
      printf '%s' "$INSTALL_MODE"
      ;;
    *)
      fail "Invalid ORCHESTRATOR_INSTALL_MODE=$INSTALL_MODE. Use auto, docker, or native."
      ;;
  esac
}

detect_lan_ip() {
  if command -v ip >/dev/null 2>&1; then
    ip route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }'
    return
  fi
  if command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | awk '{ print $1 }'
    return
  fi
}

normalize_duckdns_domain() {
  local raw domain
  raw="$1"
  domain="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's#^https?://##; s#/.*$##; s/[[:space:]]//g; s/[.]$//')"
  domain="${domain%.duckdns.org}"
  if ! printf '%s' "$domain" | grep -Eq '^[a-z0-9][a-z0-9-]{0,62}$'; then
    fail "Invalid DuckDNS domain '$raw'. Use a single DuckDNS subdomain such as my-orchestrator or my-orchestrator.duckdns.org."
  fi
  printf '%s' "$domain"
}

configure_public_https_inputs() {
  local mode domain token email
  mode="$(printf '%s' "$PUBLIC_HTTPS_SETUP" | tr '[:upper:]' '[:lower:]')"

  case "$mode" in
    ""|ask)
      if [ "$(uname -s)" = "Linux" ] && prompt_yes_no "Configure public HTTPS with DuckDNS for this server?" "n"; then
        mode="duckdns"
      else
        mode="none"
      fi
      ;;
    duckdns|duck|true|yes|1)
      mode="duckdns"
      ;;
    none|false|no|0)
      mode="none"
      ;;
    *)
      fail "Invalid ORCHESTRATOR_PUBLIC_HTTPS_SETUP=$PUBLIC_HTTPS_SETUP. Use duckdns or none."
      ;;
  esac

  PUBLIC_HTTPS_SETUP="$mode"
  if [ "$PUBLIC_HTTPS_SETUP" != "duckdns" ]; then
    return
  fi
  [ "$(uname -s)" = "Linux" ] || fail "DuckDNS HTTPS setup is supported by this installer on Linux servers only."

  domain="$DUCKDNS_DOMAIN"
  if [ -z "$domain" ]; then
    domain="$(prompt_value "DuckDNS domain (for example my-orchestrator or my-orchestrator.duckdns.org): " || true)"
  fi
  [ -n "$domain" ] || fail "DuckDNS domain is required. Set ORCHESTRATOR_DUCKDNS_DOMAIN or run interactively."
  DUCKDNS_DOMAIN="$(normalize_duckdns_domain "$domain")"

  token="$DUCKDNS_TOKEN"
  if [ -z "$token" ]; then
    token="$(prompt_secret "DuckDNS token: " || true)"
  fi
  [ -n "$token" ] || fail "DuckDNS token is required. Set ORCHESTRATOR_DUCKDNS_TOKEN or run interactively."
  DUCKDNS_TOKEN="$token"

  email="$LETSENCRYPT_EMAIL"
  if [ -z "$email" ]; then
    email="$(prompt_value "Let's Encrypt email (optional, press Enter to skip): " || true)"
  fi
  LETSENCRYPT_EMAIL="$email"

  PUBLIC_URL="https://$DUCKDNS_DOMAIN.duckdns.org"
  ORCHESTRATOR_SSH_HOST="${ORCHESTRATOR_SSH_HOST:-$DUCKDNS_DOMAIN.duckdns.org}"
  BROWSER_AGENT_VNC_WS_PUBLIC_URL="${BROWSER_AGENT_VNC_WS_PUBLIC_URL:-wss://$DUCKDNS_DOMAIN.duckdns.org/vnc}"
  export ORCHESTRATOR_SSH_HOST BROWSER_AGENT_VNC_WS_PUBLIC_URL

  log "Public URL: $PUBLIC_URL"
}

install_git_if_missing() {
  if command -v git >/dev/null 2>&1; then
    return
  fi

  log "Installing git"
  if command -v brew >/dev/null 2>&1; then
    brew install git
  elif command -v apt-get >/dev/null 2>&1; then
    run_sudo apt-get update
    run_sudo apt-get install -y git curl ca-certificates
  elif command -v dnf >/dev/null 2>&1; then
    run_sudo dnf install -y git curl ca-certificates
  elif command -v yum >/dev/null 2>&1; then
    run_sudo yum install -y git curl ca-certificates
  elif command -v pacman >/dev/null 2>&1; then
    run_sudo pacman -Sy --noconfirm git curl ca-certificates
  else
    fail "Could not install git automatically. Install git and rerun."
  fi
}

install_python_if_missing() {
  if command -v python3 >/dev/null 2>&1; then
    return
  fi

  log "Installing Python 3 for Docker update bridge"
  if command -v apt-get >/dev/null 2>&1; then
    run_sudo apt-get update
    run_sudo apt-get install -y python3
  elif command -v dnf >/dev/null 2>&1; then
    run_sudo dnf install -y python3
  elif command -v yum >/dev/null 2>&1; then
    run_sudo yum install -y python3
  elif command -v pacman >/dev/null 2>&1; then
    run_sudo pacman -Sy --noconfirm python
  else
    fail "Could not install Python 3 automatically. Install python3 and rerun."
  fi
}

install_linux_native_dependencies() {
  if [ "$(uname -s)" != "Linux" ]; then
    return
  fi

  log "Ensuring Linux native build/runtime dependencies"
  if command -v apt-get >/dev/null 2>&1; then
    run_sudo apt-get update
    run_sudo apt-get install -y git curl ca-certificates python3 python3-pip make g++ pkg-config chromium || \
      run_sudo apt-get install -y git curl ca-certificates python3 python3-pip make g++ pkg-config chromium-browser || \
      run_sudo apt-get install -y git curl ca-certificates python3 python3-pip make g++ pkg-config
  elif command -v dnf >/dev/null 2>&1; then
    run_sudo dnf install -y git curl ca-certificates python3 python3-pip make gcc-c++ pkgconf-pkg-config chromium || \
      run_sudo dnf install -y git curl ca-certificates python3 python3-pip make gcc-c++ pkgconf-pkg-config
  elif command -v yum >/dev/null 2>&1; then
    run_sudo yum install -y git curl ca-certificates python3 python3-pip make gcc-c++ pkgconfig chromium || \
      run_sudo yum install -y git curl ca-certificates python3 python3-pip make gcc-c++ pkgconfig
  elif command -v pacman >/dev/null 2>&1; then
    run_sudo pacman -Sy --noconfirm git curl ca-certificates python python-pip make gcc pkgconf chromium
  else
    log "Could not detect a supported package manager; assuming native dependencies are already installed."
  fi

  install_agent_runtime_tools
  install_python_doc_libs
}

# Python document-processing libraries the in-app agent uses for docx/xlsx/pptx/
# pdf work. Without them the agent falls back to raw OOXML zip parsing. The
# Docker runner stage bakes the same set in (see Dockerfile); this keeps native
# Linux installs at parity. Best-effort: PEP 668 (Debian/recent Arch) marks the
# system env externally-managed, hence --break-system-packages, and the whole
# step is non-fatal (`|| true`) since a missing wheel or older pip must never
# abort the install.
install_python_doc_libs() {
  [ "$(uname -s)" = "Linux" ] || return
  command -v python3 >/dev/null 2>&1 || return
  log "Ensuring Python document libraries (python-docx, openpyxl, python-pptx, pypdf)"
  run_sudo python3 -m pip install --break-system-packages --no-cache-dir \
    python-docx openpyxl python-pptx pypdf >/dev/null 2>&1 || \
    run_sudo python3 -m pip install --no-cache-dir \
      python-docx openpyxl python-pptx pypdf >/dev/null 2>&1 || \
    log "Could not install Python document libraries automatically; the agent will fall back to raw file parsing."
}

# CLI tools the in-app agent shells out to (ripgrep/jq/sqlite3/pdftotext/strings/ffmpeg).
# Best-effort: a package name that differs or is missing on a given distro must
# never abort the install, hence the trailing `|| true`. The container build
# installs the same set in the Dockerfile runner stage; this keeps native
# installs at parity.
install_agent_runtime_tools() {
  [ "$(uname -s)" = "Linux" ] || return
  log "Ensuring agent runtime CLI tools (ripgrep, jq, sqlite3, poppler-utils, binutils, ffmpeg)"
  if command -v apt-get >/dev/null 2>&1; then
    run_sudo apt-get install -y ripgrep jq sqlite3 poppler-utils binutils ffmpeg || true
  elif command -v dnf >/dev/null 2>&1; then
    run_sudo dnf install -y ripgrep jq sqlite poppler-utils binutils ffmpeg || true
  elif command -v yum >/dev/null 2>&1; then
    run_sudo yum install -y ripgrep jq sqlite poppler-utils binutils ffmpeg || true
  elif command -v pacman >/dev/null 2>&1; then
    run_sudo pacman -Sy --noconfirm ripgrep jq sqlite poppler binutils ffmpeg || true
  fi
}

install_docker_packages_if_needed() {
  if command -v docker >/dev/null 2>&1 && docker_compose_available; then
    return
  fi

  if [ "$(uname -s)" != "Linux" ]; then
    fail "Docker install mode requires Docker Engine/Desktop with Docker Compose already installed on this OS."
  fi

  log "Installing Docker Engine and Docker Compose"
  if command -v apt-get >/dev/null 2>&1; then
    run_sudo apt-get update
    if ! run_sudo apt-get install -y docker.io docker-compose-v2; then
      if ! run_sudo apt-get install -y docker.io docker-compose-plugin; then
        run_sudo apt-get install -y docker.io docker-compose
      fi
    fi
  elif command -v dnf >/dev/null 2>&1; then
    if ! run_sudo dnf install -y docker docker-compose-plugin; then
      run_sudo dnf install -y moby-engine docker-compose
    fi
  elif command -v yum >/dev/null 2>&1; then
    if ! run_sudo yum install -y docker docker-compose-plugin; then
      run_sudo yum install -y docker docker-compose
    fi
  elif command -v pacman >/dev/null 2>&1; then
    run_sudo pacman -Sy --noconfirm docker docker-compose
  else
    fail "Could not install Docker automatically. Install Docker Engine + Compose and rerun."
  fi

  command -v docker >/dev/null 2>&1 || fail "Docker was not installed successfully."
  docker_compose_available || fail "Docker Compose was not installed successfully."
}

docker_compose_available() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return 0
  fi
  command -v docker-compose >/dev/null 2>&1
}

start_docker_daemon() {
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    return
  fi

  if [ "$(uname -s)" = "Linux" ]; then
    log "Starting Docker daemon"
    if command -v systemctl >/dev/null 2>&1; then
      run_sudo systemctl enable --now docker >/dev/null 2>&1 || true
    fi
    if ! docker info >/dev/null 2>&1 && command -v service >/dev/null 2>&1; then
      run_sudo service docker start >/dev/null 2>&1 || true
    fi
  fi

  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    return
  fi
  if command -v docker >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    return
  fi

  fail "Docker is installed but the daemon is not running. Start Docker and rerun."
}

install_public_https_packages() {
  [ "$PUBLIC_HTTPS_SETUP" = "duckdns" ] || return
  [ "$(uname -s)" = "Linux" ] || return

  log "Installing nginx and HTTPS helper packages"
  if command -v apt-get >/dev/null 2>&1; then
    run_sudo apt-get update
    run_sudo apt-get install -y nginx curl ca-certificates socat
  elif command -v dnf >/dev/null 2>&1; then
    run_sudo dnf install -y nginx curl ca-certificates socat
  elif command -v yum >/dev/null 2>&1; then
    run_sudo yum install -y nginx curl ca-certificates socat
  elif command -v pacman >/dev/null 2>&1; then
    run_sudo pacman -Sy --noconfirm nginx curl ca-certificates socat
  else
    fail "Could not install nginx automatically. Install nginx, curl, ca-certificates, and socat, then rerun."
  fi

  if command -v systemctl >/dev/null 2>&1; then
    run_sudo systemctl enable --now nginx >/dev/null 2>&1 || run_sudo systemctl start nginx >/dev/null 2>&1 || true
  elif command -v service >/dev/null 2>&1; then
    run_sudo service nginx start >/dev/null 2>&1 || true
  fi
}

run_docker() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
  else
    run_sudo docker "$@"
  fi
}

run_compose() {
  (
    cd "$APP_DIR"
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
      run_docker compose "$@"
    elif command -v docker-compose >/dev/null 2>&1; then
      if docker info >/dev/null 2>&1; then
        docker-compose "$@"
      else
        run_sudo docker-compose "$@"
      fi
    else
      fail "Docker Compose is not available."
    fi
  )
}

ensure_node() {
  local major
  export NVM_DIR="$HOME/.nvm"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
  fi

  major="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || printf '0')"
  if [ "$major" -eq 22 ] && command -v npm >/dev/null 2>&1; then
    return
  fi

  log "Installing Node.js 22 with nvm"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm alias default 22
  nvm use 22
}

checkout_app() {
  local backup_dir
  mkdir -p "$ORCH_HOME" "$LOG_DIR"

  if [ -d "$APP_DIR/.git" ]; then
    log "Updating existing checkout at $APP_DIR"
    git -C "$APP_DIR" fetch origin "$BRANCH" --tags
    git -C "$APP_DIR" checkout "$BRANCH"
    git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
  elif [ -e "$APP_DIR" ] && [ "$(find "$APP_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')" != "0" ]; then
    # Backup goes next to the app dir, not inside the data dir — the data dir
    # is bind-mounted into the container and shouldn't contain code backups.
    backup_dir="$(dirname "$APP_DIR")/$(basename "$APP_DIR").backup.$(date +%Y%m%d%H%M%S)"
    log "$APP_DIR exists but is not a git checkout; moving it to $backup_dir"
    mv "$APP_DIR" "$backup_dir"
    log "Cloning $REPO_URL"
    git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
    if [ -f "$backup_dir/.env" ] && [ ! -f "$APP_DIR/.env" ]; then
      cp "$backup_dir/.env" "$APP_DIR/.env"
    fi
    if [ -f "$backup_dir/.env.local" ] && [ ! -f "$APP_DIR/.env.local" ]; then
      cp "$backup_dir/.env.local" "$APP_DIR/.env.local"
    fi
  else
    log "Cloning $REPO_URL"
    git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
  fi
}

dir_is_empty() {
  [ -d "$1" ] || return 0
  [ -z "$(find "$1" -mindepth 1 -maxdepth 1 2>/dev/null | head -1)" ]
}

ensure_native_state_dir() {
  local app_state="$APP_DIR/.orchestrator"
  local state_dir="${ORCHESTRATOR_NATIVE_STATE_DIR:-$ORCH_HOME/state}"
  local backup_dir

  mkdir -p "$ORCH_HOME"

  if [ -L "$app_state" ]; then
    mkdir -p "$state_dir"
    return 0
  fi

  if [ -d "$app_state" ]; then
    if [ ! -e "$state_dir" ] || dir_is_empty "$state_dir"; then
      rm -rf "$state_dir" 2>/dev/null || true
      log "Moving native runtime state to $state_dir"
      mv "$app_state" "$state_dir"
    elif dir_is_empty "$app_state"; then
      rmdir "$app_state" 2>/dev/null || rm -rf "$app_state"
    else
      backup_dir="$ORCH_HOME/state.backup.$(date +%Y%m%d%H%M%S)"
      log "Both $app_state and $state_dir contain data; moving checkout state to $backup_dir"
      mv "$app_state" "$backup_dir"
    fi
  elif [ -e "$app_state" ]; then
    backup_dir="$ORCH_HOME/state-file.backup.$(date +%Y%m%d%H%M%S)"
    log "Moving non-directory $app_state to $backup_dir"
    mv "$app_state" "$backup_dir"
  fi

  mkdir -p "$state_dir"
  ln -sfn "$state_dir" "$app_state"
}

run_doctor_after_checkout() {
  # Run doctor.sh preflight + inspect once the checkout is local.
  # Caller passes the install mode so doctor uses the right port set.
  local mode="$1" doctor="$APP_DIR/scripts/doctor.sh"
  local preflight_rc inspect_rc

  if [ "$SKIP_DOCTOR" = "1" ]; then
    log "Skipping doctor (ORCHESTRATOR_SKIP_DOCTOR=1)"
    return 0
  fi
  if [ ! -f "$doctor" ]; then
    log "doctor.sh not present in this checkout; skipping preflight/inspect"
    return 0
  fi
  chmod +x "$doctor" 2>/dev/null || true

  log "Running preflight checks (doctor preflight)"
  preflight_rc=0
  ORCHESTRATOR_INSTALL_MODE="$mode" \
  ORCHESTRATOR_HOME="$ORCH_HOME" \
  ORCHESTRATOR_PORT="$PORT" \
  ORCHESTRATOR_HOST="$HOST" \
  ORCHESTRATOR_VNC_PORT="$VNC_PORT" \
  ORCHESTRATOR_PUBLIC_HTTPS_SETUP="$PUBLIC_HTTPS_SETUP" \
  ORCHESTRATOR_DUCKDNS_DOMAIN="$DUCKDNS_DOMAIN" \
  ORCHESTRATOR_DUCKDNS_TOKEN="$DUCKDNS_TOKEN" \
    "$doctor" preflight || preflight_rc=$?
  case "$preflight_rc" in
    0) log "Preflight: clean" ;;
    2) log "Preflight: warnings only — continuing" ;;
    1)
      if prompt_yes_no "Preflight reported blockers (see above). Continue anyway?" "n"; then
        log "Continuing past preflight blockers per user confirmation"
      else
        fail "Aborted due to preflight blockers. Re-run with ORCHESTRATOR_SKIP_DOCTOR=1 to bypass entirely."
      fi
      ;;
    *)
      log "Preflight exited with code $preflight_rc; continuing"
      ;;
  esac

  log "Inspecting existing install state (doctor inspect)"
  inspect_rc=0
  ORCHESTRATOR_INSTALL_MODE="$mode" \
  ORCHESTRATOR_HOME="$ORCH_HOME" \
  ORCHESTRATOR_PORT="$PORT" \
  ORCHESTRATOR_HOST="$HOST" \
  ORCHESTRATOR_VNC_PORT="$VNC_PORT" \
  ORCHESTRATOR_PUBLIC_HTTPS_SETUP="$PUBLIC_HTTPS_SETUP" \
  ORCHESTRATOR_DUCKDNS_DOMAIN="$DUCKDNS_DOMAIN" \
  ORCHESTRATOR_DUCKDNS_TOKEN="$DUCKDNS_TOKEN" \
    "$doctor" inspect || inspect_rc=$?

  if [ "$inspect_rc" -eq 3 ]; then
    log "Detected state from a previous install."
    if tty_available; then
      printf '\n[orchestrator] How should the installer handle the existing state?\n' > /dev/tty
      printf '  [k] keep — reuse what is valid, overwrite what is stale (default)\n' > /dev/tty
      printf '  [r] reset — uninstall previous artifacts first, then install fresh\n' > /dev/tty
      printf '  [a] abort — stop now without changing the system\n' > /dev/tty
      local choice
      choice="$(prompt_value 'Choice [k/r/a]: ' || true)"
      choice="$(printf '%s' "$choice" | tr '[:upper:]' '[:lower:]')"
      case "$choice" in
        r|reset)
          log "Running 'doctor uninstall' before re-installing"
          ORCHESTRATOR_HOME="$ORCH_HOME" \
          ORCHESTRATOR_DUCKDNS_DOMAIN="$DUCKDNS_DOMAIN" \
            "$doctor" uninstall --yes || fail "doctor uninstall failed; aborting"
          # checkout was wiped; recreate it.
          checkout_app
          [ "$mode" = "native" ] && ensure_native_state_dir
          ;;
        a|abort)
          fail "Aborted at user's request. Existing install untouched."
          ;;
        *)
          log "Keeping existing state. Stale items will be overwritten where the installer touches them."
          ;;
      esac
    else
      log "Non-interactive run: keeping existing state (use ORCHESTRATOR_SKIP_DOCTOR=1 to silence inspect)"
    fi
  fi
}

build_app() {
  log "Installing npm dependencies"
  (cd "$APP_DIR" && npm ci)
  log "Installing Patchright browser"
  (cd "$APP_DIR" && npm run browsers:install)
  log "Building app"
  (cd "$APP_DIR" && npm run build)
}

upsert_env_value() {
  local file key value tmp
  file="$1"
  key="$2"
  value="$3"
  tmp="$(mktemp)"
  if [ -f "$file" ] && grep -q "^$key=" "$file"; then
    awk -v k="$key" -v v="$value" 'BEGIN { done=0 } $0 ~ "^" k "=" { print k "=" v; done=1; next } { print } END { if (!done) print k "=" v }' "$file" > "$tmp"
  else
    if [ -f "$file" ]; then
      cat "$file" > "$tmp"
      printf '\n%s=%s\n' "$key" "$value" >> "$tmp"
    else
      printf '%s=%s\n' "$key" "$value" > "$tmp"
    fi
  fi
  mv "$tmp" "$file"
}

ensure_docker_env_file() {
  local env_file ssh_user lan_ip
  env_file="$APP_DIR/.env"
  ssh_user="${ORCHESTRATOR_SSH_USER:-$(id -un 2>/dev/null || true)}"
  lan_ip="${ORCHESTRATOR_HOST_LAN_IP:-$(detect_lan_ip || true)}"
  if [ ! -f "$env_file" ]; then
    if [ -f "$APP_DIR/.env.example" ]; then
      log "Creating $env_file from .env.example"
      cp "$APP_DIR/.env.example" "$env_file"
    else
      log "Creating $env_file"
      : > "$env_file"
    fi
  fi

  upsert_env_value "$env_file" ORCHESTRATOR_HOST "$HOST"
  upsert_env_value "$env_file" ORCHESTRATOR_PORT "$PORT"
  if [ -n "$PUBLIC_URL" ]; then
    upsert_env_value "$env_file" ORCHESTRATOR_PUBLIC_URL "$PUBLIC_URL"
  fi
  if [ -n "${ORCHESTRATOR_SSH_HOST:-}" ]; then
    upsert_env_value "$env_file" ORCHESTRATOR_SSH_HOST "$ORCHESTRATOR_SSH_HOST"
  fi
  if [ -n "$ssh_user" ]; then
    upsert_env_value "$env_file" ORCHESTRATOR_SSH_USER "$ssh_user"
  fi
  if [ -n "$lan_ip" ]; then
    upsert_env_value "$env_file" ORCHESTRATOR_HOST_LAN_IP "$lan_ip"
  fi
  upsert_env_value "$env_file" ORCHESTRATOR_SERVICE_MANAGER "docker"
  upsert_env_value "$env_file" ORCHESTRATOR_HOST_BRIDGE_URL "http://host.docker.internal:$UPDATE_BRIDGE_PORT"
  upsert_env_value "$env_file" ORCHESTRATOR_HOST_BRIDGE_TOKEN "$(cat "$UPDATE_BRIDGE_TOKEN_FILE")"
  upsert_env_value "$env_file" ORCHESTRATOR_DOCKER_UPDATE_URL "http://host.docker.internal:$UPDATE_BRIDGE_PORT/update"
  upsert_env_value "$env_file" ORCHESTRATOR_DOCKER_UPDATE_TOKEN "$(cat "$UPDATE_BRIDGE_TOKEN_FILE")"
  upsert_env_value "$env_file" BROWSER_AGENT_LIVE_VIEW "1"
  upsert_env_value "$env_file" BROWSER_AGENT_VNC_WS_PORT "$VNC_PORT"
  upsert_env_value "$env_file" BROWSER_AGENT_VNC_WS_PUBLIC_URL "${BROWSER_AGENT_VNC_WS_PUBLIC_URL:-ws://127.0.0.1:$VNC_PORT}"
  # Bind mount paths + container uid/gid so docker compose creates host-owned
  # files in the right place (see docker-compose.yml volumes section).
  upsert_env_value "$env_file" ORCHESTRATOR_DATA_DIR "$ORCH_HOME"
  upsert_env_value "$env_file" ORCHESTRATOR_NODE_HOME "$NODE_HOME_DIR"
  upsert_env_value "$env_file" ORCHESTRATOR_SELF_DEV_HOST_SOURCE_DIR "$APP_DIR"
  upsert_env_value "$env_file" ORCHESTRATOR_UID "$(id -u)"
  upsert_env_value "$env_file" ORCHESTRATOR_GID "$(id -g)"
  mkdir -p "$ORCH_HOME" "$NODE_HOME_DIR"
}

install_duckdns_updater() {
  local duck_dir update_script service_dir service_file timer_file response
  [ "$PUBLIC_HTTPS_SETUP" = "duckdns" ] || return

  duck_dir="$ORCH_HOME/duckdns"
  update_script="$duck_dir/update.sh"
  mkdir -p "$duck_dir"
  chmod 700 "$duck_dir" || true

  cat > "$update_script" <<EOF
#!/usr/bin/env bash
set -euo pipefail
response="\$(curl -fsS "https://www.duckdns.org/update?domains=$DUCKDNS_DOMAIN&token=$DUCKDNS_TOKEN&ip=")"
if [ "\$response" != "OK" ]; then
  echo "DuckDNS update failed: \$response" >&2
  exit 1
fi
EOF
  chmod 700 "$update_script"

  log "Updating DuckDNS record for $DUCKDNS_DOMAIN.duckdns.org"
  response="$("$update_script" 2>&1)" || fail "$response"

  if command -v systemctl >/dev/null 2>&1; then
    service_dir="$HOME/.config/systemd/user"
    service_file="$service_dir/orchestrator-duckdns.service"
    timer_file="$service_dir/orchestrator-duckdns.timer"
    mkdir -p "$service_dir"
    cat > "$service_file" <<EOF
[Unit]
Description=Update DuckDNS record for Orchestrator

[Service]
Type=oneshot
ExecStart=$update_script
EOF
    cat > "$timer_file" <<EOF
[Unit]
Description=Run Orchestrator DuckDNS update periodically

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
Unit=orchestrator-duckdns.service

[Install]
WantedBy=timers.target
EOF
    run_sudo loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
    if systemctl --user daemon-reload >/dev/null 2>&1 && systemctl --user enable --now orchestrator-duckdns.timer >/dev/null 2>&1; then
      log "Installed DuckDNS updater timer"
      return
    fi
    log "systemd user timer unavailable; trying crontab for DuckDNS updater"
  fi

  if command -v crontab >/dev/null 2>&1; then
    (crontab -l 2>/dev/null | grep -v "$update_script" || true; printf '*/5 * * * * %s >/dev/null 2>&1\n' "$update_script") | crontab -
    log "Installed DuckDNS updater cron entry"
  else
    log "Could not install a DuckDNS timer automatically. Run $update_script periodically to keep DNS current."
  fi
}

install_acme_sh() {
  local acme_sh install_args
  [ "$PUBLIC_HTTPS_SETUP" = "duckdns" ] || return
  acme_sh="$HOME/.acme.sh/acme.sh"
  if [ -x "$acme_sh" ]; then
    return
  fi

  log "Installing acme.sh for DuckDNS DNS-01 certificates"
  if [ -n "$LETSENCRYPT_EMAIL" ]; then
    install_args="email=$LETSENCRYPT_EMAIL"
  else
    install_args=""
  fi
  if [ -n "$install_args" ]; then
    curl -fsSL https://get.acme.sh | sh -s "$install_args"
  else
    curl -fsSL https://get.acme.sh | sh
  fi
  [ -x "$acme_sh" ] || fail "acme.sh was not installed at $acme_sh"
}

issue_duckdns_certificate() {
  local acme_sh tls_dir domain
  [ "$PUBLIC_HTTPS_SETUP" = "duckdns" ] || return
  acme_sh="$HOME/.acme.sh/acme.sh"
  tls_dir="$ORCH_HOME/tls"
  domain="$DUCKDNS_DOMAIN.duckdns.org"
  mkdir -p "$tls_dir"
  chmod 700 "$tls_dir" || true

  "$acme_sh" --set-default-ca --server letsencrypt >/dev/null 2>&1 || true
  if [ ! -s "$tls_dir/fullchain.pem" ] || [ ! -s "$tls_dir/privkey.pem" ]; then
    log "Issuing Let's Encrypt certificate for $domain via DuckDNS DNS-01"
    DuckDNS_Token="$DUCKDNS_TOKEN" "$acme_sh" --issue --dns dns_duckdns -d "$domain" --keylength ec-256 --server letsencrypt
  else
    log "Using existing certificate files in $tls_dir"
  fi
  DuckDNS_Token="$DUCKDNS_TOKEN" "$acme_sh" --install-cert -d "$domain" --ecc \
    --fullchain-file "$tls_dir/fullchain.pem" \
    --key-file "$tls_dir/privkey.pem" \
    --reloadcmd "sudo systemctl reload nginx >/dev/null 2>&1 || systemctl reload nginx >/dev/null 2>&1 || true"
}

install_nginx_orchestrator_site() {
  local domain tls_dir site_file server_name_hash_bucket_size
  [ "$PUBLIC_HTTPS_SETUP" = "duckdns" ] || return
  domain="$DUCKDNS_DOMAIN.duckdns.org"
  tls_dir="$ORCH_HOME/tls"

  if [ -d /etc/nginx/sites-available ]; then
    site_file="/etc/nginx/sites-available/orchestrator.conf"
  else
    site_file="/etc/nginx/conf.d/orchestrator.conf"
  fi

  log "Configuring nginx reverse proxy for https://$domain"
  run_sudo sh -c "cat > '$site_file'" <<EOF
server {
    listen 80;
    server_name $domain;
    return 301 https://$domain\$request_uri;
}

server {
    listen 443 ssl http2;
    server_name $domain;

    ssl_certificate $tls_dir/fullchain.pem;
    ssl_certificate_key $tls_dir/privkey.pem;

    client_max_body_size 100m;

    location /vnc/ {
        proxy_pass http://127.0.0.1:$VNC_PORT/;
        proxy_http_version 1.1;
        proxy_set_header Host $domain;
        proxy_set_header X-Forwarded-Host $domain;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Port 443;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host $domain;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Host $domain;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Port 443;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF

  if [ -d /etc/nginx/sites-enabled ]; then
    run_sudo ln -sfn "$site_file" /etc/nginx/sites-enabled/orchestrator.conf
  fi

  server_name_hash_bucket_size="$(run_sudo nginx -t 2>&1 || true)"
  if printf '%s' "$server_name_hash_bucket_size" | grep -q 'could not build server_names_hash'; then
    log "nginx needs a larger server_names_hash_bucket_size; adding a small compatibility config"
    run_sudo sh -c "printf '%s\n' 'server_names_hash_bucket_size 128;' > /etc/nginx/conf.d/orchestrator-hash-bucket.conf"
  fi

  run_sudo nginx -t
  if command -v systemctl >/dev/null 2>&1; then
    run_sudo systemctl reload nginx
  elif command -v service >/dev/null 2>&1; then
    run_sudo service nginx reload
  else
    run_sudo nginx -s reload
  fi
}

install_public_https_stack() {
  [ "$PUBLIC_HTTPS_SETUP" = "duckdns" ] || return
  install_public_https_packages
  install_duckdns_updater
  install_acme_sh
  issue_duckdns_certificate
  install_nginx_orchestrator_site
}

generate_update_bridge_token() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import secrets; print(secrets.token_hex(32))'
  else
    fail "Need openssl or python3 to create the Docker update bridge token."
  fi
}

ensure_update_bridge_token() {
  mkdir -p "$ORCH_HOME"
  if [ ! -s "$UPDATE_BRIDGE_TOKEN_FILE" ]; then
    log "Creating Docker update bridge token"
    generate_update_bridge_token > "$UPDATE_BRIDGE_TOKEN_FILE"
  fi
  chmod 600 "$UPDATE_BRIDGE_TOKEN_FILE" || true
}

start_update_bridge_background() {
  local pid_file python_bin
  python_bin="$(command -v python3)"
  pid_file="$ORCH_HOME/update-bridge.pid"

  if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" >/dev/null 2>&1; then
    return
  fi

  log "Starting Docker update bridge in the background"
  (
    cd "$APP_DIR"
    ORCHESTRATOR_UPDATE_APP_DIR="$APP_DIR" \
    ORCHESTRATOR_UPDATE_BRANCH="$BRANCH" \
    ORCHESTRATOR_UPDATE_BRIDGE_BIND="$UPDATE_BRIDGE_BIND" \
    ORCHESTRATOR_UPDATE_BRIDGE_PORT="$UPDATE_BRIDGE_PORT" \
    ORCHESTRATOR_UPDATE_TOKEN_FILE="$UPDATE_BRIDGE_TOKEN_FILE" \
    ORCHESTRATOR_PORT="$PORT" \
    ORCHESTRATOR_UPDATE_LOG_DIR="$LOG_DIR" \
    PATH="$NPM_GLOBAL_PREFIX/bin:$PATH" \
      nohup "$python_bin" "$APP_DIR/scripts/docker-update-bridge.py" >/dev/null 2>&1 &
    printf '%s\n' "$!" > "$pid_file"
  )
}

install_docker_update_bridge() {
  local python_bin service_dir service_file path_value
  python_bin="$(command -v python3)"
  service_dir="$HOME/.config/systemd/user"
  service_file="$service_dir/$UPDATE_BRIDGE_SERVICE_NAME.service"
  path_value="$(dirname "$python_bin"):$NPM_GLOBAL_PREFIX/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"

  ensure_update_bridge_token

  if command -v systemctl >/dev/null 2>&1; then
    mkdir -p "$service_dir"
    cat > "$service_file" <<EOF
[Unit]
Description=Orchestrator Docker Update Bridge
After=default.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=ORCHESTRATOR_UPDATE_APP_DIR=$APP_DIR
Environment=ORCHESTRATOR_UPDATE_BRANCH=$BRANCH
Environment=ORCHESTRATOR_UPDATE_BRIDGE_BIND=$UPDATE_BRIDGE_BIND
Environment=ORCHESTRATOR_UPDATE_BRIDGE_PORT=$UPDATE_BRIDGE_PORT
Environment=ORCHESTRATOR_UPDATE_TOKEN_FILE=$UPDATE_BRIDGE_TOKEN_FILE
Environment=ORCHESTRATOR_PORT=$PORT
Environment=ORCHESTRATOR_UPDATE_LOG_DIR=$LOG_DIR
Environment=PATH=$path_value
ExecStart=$python_bin $APP_DIR/scripts/docker-update-bridge.py
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF

    run_sudo loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
    if systemctl --user daemon-reload >/dev/null 2>&1 && systemctl --user enable --now "$UPDATE_BRIDGE_SERVICE_NAME.service" >/dev/null 2>&1; then
      log "Installed Docker update bridge service"
      return
    fi

    log "systemd user service is unavailable; falling back to background Docker update bridge"
  fi

  start_update_bridge_background
}

install_systemd_service() {
  local node_bin npm_bin node_dir service_dir service_file path_value ssh_user lan_ip ssh_host
  node_bin="$(command -v node)"
  npm_bin="$(command -v npm)"
  node_dir="$(dirname "$node_bin")"
  path_value="$node_dir:$NPM_GLOBAL_PREFIX/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"
  ssh_user="${ORCHESTRATOR_SSH_USER:-$(id -un 2>/dev/null || true)}"
  lan_ip="${ORCHESTRATOR_HOST_LAN_IP:-$(detect_lan_ip || true)}"
  ssh_host="${ORCHESTRATOR_SSH_HOST:-}"
  service_dir="$HOME/.config/systemd/user"
  service_file="$service_dir/$SERVICE_NAME.service"

  mkdir -p "$service_dir"
  cat > "$service_file" <<EOF
[Unit]
Description=Orchestrator
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=ORCHESTRATOR_PORT=$PORT
Environment=ORCHESTRATOR_HOST=$HOST
Environment=ORCHESTRATOR_PUBLIC_URL=$PUBLIC_URL
Environment=ORCHESTRATOR_SSH_USER=$ssh_user
Environment=ORCHESTRATOR_SSH_HOST=$ssh_host
Environment=ORCHESTRATOR_HOST_LAN_IP=$lan_ip
Environment=HOSTNAME=$HOST
Environment=NPM_CONFIG_PREFIX=$NPM_GLOBAL_PREFIX
Environment=PATH=$path_value
Environment=ORCHESTRATOR_SERVICE_MANAGER=systemd
Environment=ORCHESTRATOR_UPDATE_REPO_OWNER=Horia73
Environment=ORCHESTRATOR_UPDATE_REPO_NAME=orchestrator
ExecStart=$npm_bin start
Restart=on-failure
RestartSec=2
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF

  log "Installing systemd user service"
  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE_NAME.service"
}

install_launchd_service() {
  local node_bin npm_bin node_dir plist path_value ssh_user lan_ip ssh_host
  node_bin="$(command -v node)"
  npm_bin="$(command -v npm)"
  node_dir="$(dirname "$node_bin")"
  path_value="$node_dir:$NPM_GLOBAL_PREFIX/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"
  ssh_user="${ORCHESTRATOR_SSH_USER:-$(id -un 2>/dev/null || true)}"
  lan_ip="${ORCHESTRATOR_HOST_LAN_IP:-$(detect_lan_ip || true)}"
  ssh_host="${ORCHESTRATOR_SSH_HOST:-}"
  plist="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"

  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LAUNCHD_LABEL</string>
  <key>WorkingDirectory</key>
  <string>$APP_DIR</string>
  <key>ProgramArguments</key>
  <array>
    <string>$npm_bin</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PORT</key>
    <string>$PORT</string>
    <key>ORCHESTRATOR_PORT</key>
    <string>$PORT</string>
    <key>ORCHESTRATOR_HOST</key>
    <string>$HOST</string>
    <key>ORCHESTRATOR_PUBLIC_URL</key>
    <string>$PUBLIC_URL</string>
    <key>ORCHESTRATOR_SSH_USER</key>
    <string>$ssh_user</string>
    <key>ORCHESTRATOR_SSH_HOST</key>
    <string>$ssh_host</string>
    <key>ORCHESTRATOR_HOST_LAN_IP</key>
    <string>$lan_ip</string>
    <key>HOSTNAME</key>
    <string>$HOST</string>
    <key>NPM_CONFIG_PREFIX</key>
    <string>$NPM_GLOBAL_PREFIX</string>
    <key>PATH</key>
    <string>$path_value</string>
    <key>ORCHESTRATOR_SERVICE_MANAGER</key>
    <string>launchd</string>
    <key>ORCHESTRATOR_UPDATE_REPO_OWNER</key>
    <string>Horia73</string>
    <key>ORCHESTRATOR_UPDATE_REPO_NAME</key>
    <string>orchestrator</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/orchestrator.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/orchestrator.err.log</string>
</dict>
</plist>
EOF

  log "Installing launchd service"
  launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  launchctl enable "gui/$(id -u)/$LAUNCHD_LABEL"
  launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL"
}

install_native_cli() {
  mkdir -p "$BIN_DIR"
  cat > "$BIN_DIR/orchestrator" <<EOF
#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$APP_DIR"
PORT="$PORT"
HOST="$HOST"
SERVICE_MANAGER="\${ORCHESTRATOR_SERVICE_MANAGER:-}"
LAUNCHD_LABEL="$LAUNCHD_LABEL"
PLIST="\$HOME/Library/LaunchAgents/\$LAUNCHD_LABEL.plist"

if [ "\$HOST" = "0.0.0.0" ] || [ "\$HOST" = "::" ]; then
  LOCAL_URL="http://127.0.0.1:\$PORT"
else
  LOCAL_URL="http://\$HOST:\$PORT"
fi

if [ -z "\$SERVICE_MANAGER" ]; then
  if command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
    SERVICE_MANAGER="systemd"
  elif [ "\$(uname -s)" = "Darwin" ]; then
    SERVICE_MANAGER="launchd"
  else
    SERVICE_MANAGER="manual"
  fi
fi

case "\${1:-status}" in
  start)
    if [ "\$SERVICE_MANAGER" = "systemd" ]; then
      systemctl --user start orchestrator.service
    elif [ "\$SERVICE_MANAGER" = "launchd" ]; then
      launchctl print "gui/\$(id -u)/\$LAUNCHD_LABEL" >/dev/null 2>&1 || launchctl bootstrap "gui/\$(id -u)" "\$PLIST"
      launchctl kickstart -k "gui/\$(id -u)/\$LAUNCHD_LABEL"
    else
      cd "\$APP_DIR" && ORCHESTRATOR_HOST="\$HOST" ORCHESTRATOR_PORT="\$PORT" PORT="\$PORT" npm start
    fi
    ;;
  stop)
    if [ "\$SERVICE_MANAGER" = "systemd" ]; then
      systemctl --user stop orchestrator.service
    elif [ "\$SERVICE_MANAGER" = "launchd" ]; then
      launchctl bootout "gui/\$(id -u)" "\$PLIST" >/dev/null 2>&1 || true
    else
      echo "Manual install: stop the npm start process."
    fi
    ;;
  restart)
    if [ "\$SERVICE_MANAGER" = "systemd" ]; then
      systemctl --user restart orchestrator.service
    elif [ "\$SERVICE_MANAGER" = "launchd" ]; then
      launchctl print "gui/\$(id -u)/\$LAUNCHD_LABEL" >/dev/null 2>&1 || launchctl bootstrap "gui/\$(id -u)" "\$PLIST"
      launchctl kickstart -k "gui/\$(id -u)/\$LAUNCHD_LABEL"
    else
      echo "Manual install: restart the npm start process."
    fi
    ;;
  status)
    if [ "\$SERVICE_MANAGER" = "systemd" ]; then
      systemctl --user status orchestrator.service --no-pager
    elif [ "\$SERVICE_MANAGER" = "launchd" ]; then
      launchctl print "gui/\$(id -u)/\$LAUNCHD_LABEL"
    else
      curl -fsS "\$LOCAL_URL/api/update/status" || true
    fi
    ;;
  logs)
    if [ "\$SERVICE_MANAGER" = "systemd" ]; then
      journalctl --user -u orchestrator.service -f
    elif [ "\$SERVICE_MANAGER" = "launchd" ]; then
      tail -f "\$HOME/.orchestrator/logs/orchestrator.out.log" "\$HOME/.orchestrator/logs/orchestrator.err.log"
    else
      echo "Manual install: logs are in the terminal running npm start."
    fi
    ;;
  update)
    curl -fsS -X POST "\$LOCAL_URL/api/update/apply"
    echo
    ;;
  doctor)
    shift || true
    if [ "\$#" -eq 0 ]; then
      exec "\$APP_DIR/scripts/doctor.sh" check
    else
      exec "\$APP_DIR/scripts/doctor.sh" "\$@"
    fi
    ;;
  uninstall)
    shift || true
    exec "\$APP_DIR/scripts/doctor.sh" uninstall "\$@"
    ;;
  *)
    echo "Usage: orchestrator {start|stop|restart|status|logs|update|doctor|uninstall}"
    echo "  doctor [preflight|inspect|check|fix]   diagnostics; default 'check'"
    echo "  uninstall [--purge] [--yes]            remove install; --purge wipes data and Orchestrator Docker volumes"
    exit 2
    ;;
esac
EOF
  chmod +x "$BIN_DIR/orchestrator"
}

install_docker_cli() {
  mkdir -p "$BIN_DIR"
  cat > "$BIN_DIR/orchestrator" <<EOF
#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$APP_DIR"
BRANCH="$BRANCH"
PORT="$PORT"
VNC_PORT="$VNC_PORT"
LOCAL_URL="http://127.0.0.1:\$PORT"

run_sudo() {
  if [ "\$(id -u)" -eq 0 ]; then
    "\$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "\$@"
  else
    echo "Missing sudo. Cannot access Docker daemon." >&2
    exit 1
  fi
}

run_docker() {
  if docker info >/dev/null 2>&1; then
    docker "\$@"
  else
    run_sudo docker "\$@"
  fi
}

compose() {
  cd "\$APP_DIR"
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    run_docker compose "\$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
      docker-compose "\$@"
    else
      run_sudo docker-compose "\$@"
    fi
  else
    echo "Docker Compose is not available." >&2
    exit 1
  fi
}

case "\${1:-status}" in
  start)
    compose up -d
    ;;
  stop)
    compose stop orchestrator
    ;;
  restart)
    compose restart orchestrator
    ;;
  status)
    compose ps
    curl -fsS "\$LOCAL_URL/api/update/status" || true
    echo
    ;;
  logs)
    compose logs -f orchestrator
    ;;
  update)
    git -C "\$APP_DIR" fetch origin "\$BRANCH" --tags
    git -C "\$APP_DIR" checkout "\$BRANCH"
    git -C "\$APP_DIR" pull --ff-only origin "\$BRANCH"
    compose up --build -d
    ;;
  doctor)
    shift || true
    if [ "\$#" -eq 0 ]; then
      exec "\$APP_DIR/scripts/doctor.sh" check
    else
      exec "\$APP_DIR/scripts/doctor.sh" "\$@"
    fi
    ;;
  uninstall)
    shift || true
    exec "\$APP_DIR/scripts/doctor.sh" uninstall "\$@"
    ;;
  *)
    echo "Usage: orchestrator {start|stop|restart|status|logs|update|doctor|uninstall}"
    echo "  doctor [preflight|inspect|check|fix]   diagnostics; default 'check'"
    echo "  uninstall [--purge] [--yes]            remove install; --purge wipes data and Orchestrator Docker volumes"
    exit 2
    ;;
esac
EOF
  chmod +x "$BIN_DIR/orchestrator"
}

install_native_stack() {
  install_git_if_missing
  install_linux_native_dependencies
  ensure_node
  ensure_user_npm_global_prefix
  checkout_app
  ensure_native_state_dir
  run_doctor_after_checkout "native"
  build_app

  if [ "$(uname -s)" = "Darwin" ]; then
    install_launchd_service
  elif command -v systemctl >/dev/null 2>&1; then
    install_systemd_service
  else
    fail "No supported service manager found. Use npm start manually from $APP_DIR."
  fi

  install_native_cli
}

install_docker_stack() {
  install_git_if_missing
  install_python_if_missing
  install_docker_packages_if_needed
  start_docker_daemon
  checkout_app
  run_doctor_after_checkout "docker"
  install_docker_update_bridge
  ensure_docker_env_file
  log "Starting Docker Compose stack"
  run_compose up --build -d
  install_docker_cli
}

main() {
  local mode
  mode="$(resolve_install_mode)"
  setup_install_logging
  trap install_on_exit EXIT
  log "Install mode: $mode"
  log "Install log: $INSTALL_LOG_FILE"
  configure_public_https_inputs

  if [ "$mode" = "docker" ]; then
    install_docker_stack
    install_public_https_stack
    if [ -n "$PUBLIC_URL" ]; then
      log "Installed Docker stack. Open $PUBLIC_URL"
    else
      log "Installed Docker stack. Open http://127.0.0.1:$PORT"
    fi
    log "Live browser view websocket: ${BROWSER_AGENT_VNC_WS_PUBLIC_URL:-ws://127.0.0.1:$VNC_PORT}"
  else
    install_native_stack
    install_public_https_stack
    if [ -n "$PUBLIC_URL" ]; then
      log "Installed native service. Open $PUBLIC_URL"
    else
      log "Installed native service. Open http://$HOST:$PORT"
    fi
  fi

  log "CLI: $BIN_DIR/orchestrator"
  if ! printf '%s' "$PATH" | grep -q "$BIN_DIR"; then
    log "Add $BIN_DIR to PATH if the orchestrator command is not found."
  fi
}

main "$@"
