#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${ORCHESTRATOR_REPO_URL:-https://github.com/Horia73/orchestrator.git}"
BRANCH="${ORCHESTRATOR_BRANCH:-master}"
INSTALL_MODE="${ORCHESTRATOR_INSTALL_MODE:-auto}"
ORCH_HOME="${ORCHESTRATOR_HOME:-$HOME/.orchestrator}"
APP_DIR="${ORCHESTRATOR_APP_DIR:-$ORCH_HOME/app}"
PORT="${ORCHESTRATOR_PORT:-3000}"
HOST="${ORCHESTRATOR_HOST:-127.0.0.1}"
PUBLIC_URL="${ORCHESTRATOR_PUBLIC_URL:-}"
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

log() {
  printf '\033[1;34m[orchestrator]\033[0m %s\n' "$*"
}

fail() {
  printf '\033[1;31m[orchestrator]\033[0m %s\n' "$*" >&2
  exit 1
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
    run_sudo apt-get install -y git curl ca-certificates python3 make g++ pkg-config chromium || \
      run_sudo apt-get install -y git curl ca-certificates python3 make g++ pkg-config chromium-browser || \
      run_sudo apt-get install -y git curl ca-certificates python3 make g++ pkg-config
  elif command -v dnf >/dev/null 2>&1; then
    run_sudo dnf install -y git curl ca-certificates python3 make gcc-c++ pkgconf-pkg-config chromium || \
      run_sudo dnf install -y git curl ca-certificates python3 make gcc-c++ pkgconf-pkg-config
  elif command -v yum >/dev/null 2>&1; then
    run_sudo yum install -y git curl ca-certificates python3 make gcc-c++ pkgconfig chromium || \
      run_sudo yum install -y git curl ca-certificates python3 make gcc-c++ pkgconfig
  elif command -v pacman >/dev/null 2>&1; then
    run_sudo pacman -Sy --noconfirm git curl ca-certificates python make gcc pkgconf chromium
  else
    log "Could not detect a supported package manager; assuming native dependencies are already installed."
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
    backup_dir="$ORCH_HOME/app.backup.$(date +%Y%m%d%H%M%S)"
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
  upsert_env_value "$env_file" ORCHESTRATOR_DOCKER_UPDATE_URL "http://host.docker.internal:$UPDATE_BRIDGE_PORT/update"
  upsert_env_value "$env_file" ORCHESTRATOR_DOCKER_UPDATE_TOKEN "$(cat "$UPDATE_BRIDGE_TOKEN_FILE")"
  upsert_env_value "$env_file" BROWSER_AGENT_LIVE_VIEW "1"
  upsert_env_value "$env_file" BROWSER_AGENT_VNC_WS_PORT "$VNC_PORT"
  upsert_env_value "$env_file" BROWSER_AGENT_VNC_WS_PUBLIC_URL "${BROWSER_AGENT_VNC_WS_PUBLIC_URL:-ws://127.0.0.1:$VNC_PORT}"
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
      nohup "$python_bin" "$APP_DIR/scripts/docker-update-bridge.py" >/dev/null 2>&1 &
    printf '%s\n' "$!" > "$pid_file"
  )
}

install_docker_update_bridge() {
  local python_bin service_dir service_file path_value
  python_bin="$(command -v python3)"
  service_dir="$HOME/.config/systemd/user"
  service_file="$service_dir/$UPDATE_BRIDGE_SERVICE_NAME.service"
  path_value="$(dirname "$python_bin"):/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"

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
  *)
    echo "Usage: orchestrator {start|stop|restart|status|logs|update}"
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
  *)
    echo "Usage: orchestrator {start|stop|restart|status|logs|update}"
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
  install_docker_update_bridge
  ensure_docker_env_file
  log "Starting Docker Compose stack"
  run_compose up --build -d
  install_docker_cli
}

main() {
  local mode
  mode="$(resolve_install_mode)"
  log "Install mode: $mode"

  if [ "$mode" = "docker" ]; then
    install_docker_stack
    log "Installed Docker stack. Open http://127.0.0.1:$PORT"
    log "Live browser view websocket: ws://127.0.0.1:$VNC_PORT"
  else
    install_native_stack
    log "Installed native service. Open http://$HOST:$PORT"
  fi

  log "CLI: $BIN_DIR/orchestrator"
  if ! printf '%s' "$PATH" | grep -q "$BIN_DIR"; then
    log "Add $BIN_DIR to PATH if the orchestrator command is not found."
  fi
}

main "$@"
