#!/usr/bin/env bash
# Orchestrator doctor — preflight, state discovery, runtime health, fixes, uninstall.
#
# Subcommands:
#   preflight   Read-only pre-install checks (network, ports, sudo, deps, disk).
#   inspect     Inventory leftover state from a previous install (certs, nginx, services, ...).
#   check       Runtime health: preflight + inspect + cert expiry + DNS + app liveness.
#   fix         Apply suggested fixes for items found by check (confirms each destructive step).
#   uninstall   Remove the orchestrator installation. Keeps data unless --purge.
#   help        Show this help.
#
# Flags:
#   --json      Emit results as JSON instead of the human table. (Reserved; v1 ignores it.)
#   --yes       Skip confirmation prompts for destructive fixes / uninstall.
#   --quiet     Suppress info-level rows; show only warn/fail.
#
# Exit codes:
#   0  Healthy / clean / done.
#   1  Hard failure (blocker).
#   2  Warnings only — non-blocking.
#   3  Stale state found (inspect).

set -uo pipefail

# ---------- Config (env-overridable) ----------

APP_DIR="${ORCHESTRATOR_APP_DIR:-$HOME/orchestrator}"
ORCH_HOME="${ORCHESTRATOR_HOME:-$HOME/.orchestrator}"
NODE_HOME_DIR="${ORCHESTRATOR_NODE_HOME:-$HOME/.orchestrator-node-home}"
LOG_DIR="${ORCHESTRATOR_LOG_DIR:-$ORCH_HOME/logs}"
DOCTOR_LOG_DIR="$LOG_DIR/doctor"

PORT="${ORCHESTRATOR_PORT:-3000}"
HOST="${ORCHESTRATOR_HOST:-127.0.0.1}"
VNC_PORT="${ORCHESTRATOR_VNC_PORT:-${BROWSER_AGENT_VNC_WS_PORT:-6080}}"
PUBLIC_URL="${ORCHESTRATOR_PUBLIC_URL:-}"
DUCKDNS_DOMAIN="${ORCHESTRATOR_DUCKDNS_DOMAIN:-}"
DUCKDNS_TOKEN="${ORCHESTRATOR_DUCKDNS_TOKEN:-}"
PUBLIC_HTTPS_SETUP="${ORCHESTRATOR_PUBLIC_HTTPS_SETUP:-${ORCHESTRATOR_HTTPS_SETUP:-}}"
UPDATE_BRIDGE_PORT="${ORCHESTRATOR_UPDATE_BRIDGE_PORT:-38733}"
UPDATE_BRIDGE_TOKEN_FILE="${ORCHESTRATOR_UPDATE_TOKEN_FILE:-$ORCH_HOME/update-bridge-token}"
BIN_DIR="${ORCHESTRATOR_BIN_DIR:-$HOME/.local/bin}"

SERVICE_NAME="orchestrator"
UPDATE_BRIDGE_SERVICE_NAME="orchestrator-docker-update"
DUCKDNS_TIMER_NAME="orchestrator-duckdns"
LAUNCHD_LABEL="com.horia.orchestrator"

JSON_OUTPUT=0
ASSUME_YES=0
QUIET=0
INSTALL_MODE_HINT="${ORCHESTRATOR_INSTALL_MODE:-auto}"

# ---------- Output helpers ----------

if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  C_BOLD="$(printf '\033[1m')"
  C_DIM="$(printf '\033[2m')"
  C_RED="$(printf '\033[31m')"
  C_GRN="$(printf '\033[32m')"
  C_YLW="$(printf '\033[33m')"
  C_BLU="$(printf '\033[34m')"
  C_RST="$(printf '\033[0m')"
else
  C_BOLD=""; C_DIM=""; C_RED=""; C_GRN=""; C_YLW=""; C_BLU=""; C_RST=""
fi

log_info()  { printf '%s[doctor]%s %s\n' "$C_BLU" "$C_RST" "$*"; }
log_warn()  { printf '%s[doctor]%s %s\n' "$C_YLW" "$C_RST" "$*" >&2; }
log_error() { printf '%s[doctor]%s %s\n' "$C_RED" "$C_RST" "$*" >&2; }

icon_for() {
  case "$1" in
    ok)   printf '%s✓%s' "$C_GRN" "$C_RST" ;;
    warn) printf '%s!%s' "$C_YLW" "$C_RST" ;;
    fail) printf '%s✗%s' "$C_RED" "$C_RST" ;;
    info) printf '%s·%s' "$C_DIM" "$C_RST" ;;
    *)    printf '?' ;;
  esac
}

# ---------- Result accumulator ----------
# Bash 3.2 — parallel indexed arrays only.

RES_NAMES=()
RES_STATUSES=()
RES_DETAILS=()
RES_FIXES=()
RES_CATEGORIES=()

add_result() {
  # category, name, status, detail, [fix_action]
  RES_CATEGORIES+=("$1")
  RES_NAMES+=("$2")
  RES_STATUSES+=("$3")
  RES_DETAILS+=("$4")
  RES_FIXES+=("${5:--}")
}

reset_results() {
  RES_NAMES=(); RES_STATUSES=(); RES_DETAILS=(); RES_FIXES=(); RES_CATEGORIES=()
}

print_results() {
  local i n status detail name category last_category
  n="${#RES_NAMES[@]}"
  if [ "$n" -eq 0 ]; then
    log_info "No results."
    return
  fi
  last_category=""
  i=0
  while [ "$i" -lt "$n" ]; do
    category="${RES_CATEGORIES[$i]}"
    status="${RES_STATUSES[$i]}"
    name="${RES_NAMES[$i]}"
    detail="${RES_DETAILS[$i]}"
    if [ "$QUIET" = "1" ] && [ "$status" = "info" ]; then
      i=$((i + 1)); continue
    fi
    if [ "$category" != "$last_category" ]; then
      [ -n "$last_category" ] && printf '\n'
      printf '%s%s%s\n' "$C_BOLD" "$category" "$C_RST"
      last_category="$category"
    fi
    printf '  %s %-30s %s\n' "$(icon_for "$status")" "$name" "$detail"
    i=$((i + 1))
  done
  printf '\n'
}

results_summary_exit_code() {
  # 1 if any fail, 2 if any warn, 0 otherwise.
  local i n has_warn=0 has_fail=0
  n="${#RES_STATUSES[@]}"
  i=0
  while [ "$i" -lt "$n" ]; do
    case "${RES_STATUSES[$i]}" in
      fail) has_fail=1 ;;
      warn) has_warn=1 ;;
    esac
    i=$((i + 1))
  done
  [ "$has_fail" = "1" ] && return 1
  [ "$has_warn" = "1" ] && return 2
  return 0
}

# ---------- Tiny helpers ----------

have() { command -v "$1" >/dev/null 2>&1; }

is_linux()  { [ "$(uname -s)" = "Linux" ]; }
is_darwin() { [ "$(uname -s)" = "Darwin" ]; }

tty_available() {
  # /dev/tty can be opened for reading. Quieter than [ -r ] which can give
  # false positives in some non-tty contexts.
  { : < /dev/tty; } >/dev/null 2>&1
}

confirm() {
  # Returns 0 if user confirms, 1 otherwise (including when no tty is available).
  local prompt="$1" default="${2:-n}" answer
  if [ "$ASSUME_YES" = "1" ]; then return 0; fi
  if ! tty_available; then return 1; fi
  if [ "$default" = "y" ]; then
    printf '%s [Y/n] ' "$prompt" > /dev/tty 2>/dev/null || return 1
  else
    printf '%s [y/N] ' "$prompt" > /dev/tty 2>/dev/null || return 1
  fi
  IFS= read -r answer < /dev/tty 2>/dev/null || return 1
  answer="$(printf '%s' "$answer" | tr '[:upper:]' '[:lower:]')"
  [ -z "$answer" ] && answer="$default"
  case "$answer" in y|yes) return 0 ;; *) return 1 ;; esac
}

run_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif have sudo; then
    sudo "$@"
  else
    return 1
  fi
}

docker_reachable() {
  have docker || return 1
  docker info >/dev/null 2>&1 || run_sudo docker info >/dev/null 2>&1
}

run_docker() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
  else
    run_sudo docker "$@"
  fi
}

run_compose() {
  [ -d "$APP_DIR" ] || return 1
  if [ ! -f "$APP_DIR/docker-compose.yml" ] && [ ! -f "$APP_DIR/compose.yml" ] && [ ! -f "$APP_DIR/compose.yaml" ]; then
    return 1
  fi
  (
    cd "$APP_DIR" || exit 1
    if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
      run_docker compose "$@"
    elif command -v docker-compose >/dev/null 2>&1; then
      if docker info >/dev/null 2>&1; then
        docker-compose "$@"
      else
        run_sudo docker-compose "$@"
      fi
    else
      exit 1
    fi
  )
}

# Read $APP_DIR/.env into shell-safe vars (export ORCHESTRATOR_PUBLIC_URL etc).
# Only honors lines like KEY=VALUE with no spaces around '='. Skips quoted/multiline.
load_env_file() {
  local f="$APP_DIR/.env"
  [ -f "$f" ] || return 0
  local key value line
  while IFS= read -r line || [ -n "$line" ]; do
    # Strip CR, ignore comments and blanks.
    line="${line%$'\r'}"
    case "$line" in
      ''|\#*) continue ;;
    esac
    case "$line" in
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    # Skip lines with spaces in key.
    case "$key" in *[[:space:]]*) continue ;; esac
    # Strip surrounding single/double quotes from value.
    case "$value" in
      \"*\") value="${value#\"}"; value="${value%\"}" ;;
      \'*\') value="${value#\'}"; value="${value%\'}" ;;
    esac
    case "$key" in
      ORCHESTRATOR_PUBLIC_URL)        [ -z "$PUBLIC_URL" ] && PUBLIC_URL="$value" ;;
      ORCHESTRATOR_DUCKDNS_DOMAIN)    [ -z "$DUCKDNS_DOMAIN" ] && DUCKDNS_DOMAIN="$value" ;;
      ORCHESTRATOR_PORT)              [ "$PORT" = "3000" ] && PORT="$value" ;;
      ORCHESTRATOR_HOST)              [ "$HOST" = "127.0.0.1" ] && HOST="$value" ;;
      BROWSER_AGENT_VNC_WS_PORT)      [ "$VNC_PORT" = "6080" ] && VNC_PORT="$value" ;;
      ORCHESTRATOR_PUBLIC_HTTPS_SETUP) [ -z "$PUBLIC_HTTPS_SETUP" ] && PUBLIC_HTTPS_SETUP="$value" ;;
    esac
  done < "$f"
}

# Best-effort: who is listening on TCP port $1. Returns "pid N (cmd)" or
# "<process>" or an empty string. We try ss first (most informative), then lsof,
# then netstat. ss output without sudo only shows process info for sockets we
# own; if we don't see it as the user, retry with sudo (no-prompt) for a clearer
# answer.
port_listener() {
  local p="$1" raw="" parsed=""
  if have ss; then
    raw="$(ss -ltnp 2>/dev/null | awk -v port=":$p" '$4 ~ port"$" { print $0; exit }')"
    if [ -n "$raw" ] && ! printf '%s' "$raw" | grep -q 'users:'; then
      # No process info as the unprivileged user — try sudo non-interactively.
      if have sudo; then
        local sraw
        sraw="$(sudo -n ss -ltnp 2>/dev/null | awk -v port=":$p" '$4 ~ port"$" { print $0; exit }')"
        [ -n "$sraw" ] && raw="$sraw"
      fi
    fi
  fi
  if [ -z "$raw" ] && have lsof; then
    raw="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN 2>/dev/null | awk 'NR==2 { print "pid " $2 " (" $1 ")"; exit }')"
    parsed="$raw"
  fi
  if [ -z "$raw" ] && have netstat; then
    raw="$(netstat -an 2>/dev/null | awk -v port="\\.$p" '/LISTEN/ && $4 ~ port { print $0; exit }')"
  fi
  if [ -z "$parsed" ] && [ -n "$raw" ]; then
    # Pull "users:(("name",pid=N,fd=N))" → "pid N (name)".
    parsed="$(printf '%s' "$raw" | grep -oE 'users:\(\("[^"]+",pid=[0-9]+' | head -1 | sed -E 's|users:\(\("([^"]+)",pid=([0-9]+)|pid \2 (\1)|')"
    [ -z "$parsed" ] && parsed="$(printf '%s' "$raw" | awk '{ print $1 " on " $4 }')"
  fi
  printf '%s' "$parsed"
}

network_reach() {
  # Returns 0 if URL is reachable (HEAD or GET, 3s timeout).
  local url="$1"
  if have curl; then
    curl -sf -o /dev/null --max-time 4 -I "$url" 2>/dev/null && return 0
    curl -sf -o /dev/null --max-time 4 "$url" 2>/dev/null && return 0
  elif have wget; then
    wget -q --spider --timeout=4 "$url" 2>/dev/null && return 0
  fi
  return 1
}

resolve_install_mode() {
  case "$INSTALL_MODE_HINT" in
    docker|native) printf '%s' "$INSTALL_MODE_HINT" ;;
    *) if is_linux; then printf 'docker'; else printf 'native'; fi ;;
  esac
}

# ---------- Logging ----------

setup_log_file() {
  mkdir -p "$DOCTOR_LOG_DIR" 2>/dev/null || true
  DOCTOR_LOG_FILE="$DOCTOR_LOG_DIR/run-$(date +%Y%m%d-%H%M%S).log"
  printf 'doctor v1 run %s subcommand=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${SUBCOMMAND:-?}" > "$DOCTOR_LOG_FILE" 2>/dev/null || true
}

# ---------- Preflight checks (read-only) ----------

check_os_supported() {
  local os pm="?"
  os="$(uname -s)"
  if is_linux; then
    if have apt-get;   then pm="apt-get"
    elif have dnf;     then pm="dnf"
    elif have yum;     then pm="yum"
    elif have pacman;  then pm="pacman"
    fi
    if [ "$pm" = "?" ]; then
      add_result "preflight" "OS / package manager" "fail" "Linux but no apt/dnf/yum/pacman detected" "-"
      return
    fi
    add_result "preflight" "OS / package manager" "ok" "$os via $pm" "-"
  elif is_darwin; then
    add_result "preflight" "OS / package manager" "ok" "Darwin (macOS)" "-"
  else
    add_result "preflight" "OS / package manager" "fail" "Unsupported OS $os; only Linux and macOS are supported" "-"
  fi
}

check_disk_space() {
  local need_kb=2097152  # 2 GiB
  local parent avail
  parent="$(dirname "$ORCH_HOME")"
  [ -d "$parent" ] || parent="$HOME"
  # df -Pk: portable Posix; 1K blocks. Awk field 4 = Avail.
  avail="$(df -Pk "$parent" 2>/dev/null | awk 'NR==2 { print $4 }')"
  if [ -z "$avail" ] || [ "$avail" -eq 0 ] 2>/dev/null; then
    add_result "preflight" "Disk space" "warn" "could not determine free space at $parent" "-"
    return
  fi
  if [ "$avail" -lt "$need_kb" ]; then
    add_result "preflight" "Disk space" "fail" "only $((avail / 1024)) MiB free at $parent (need ≥ 2 GiB)" "-"
  else
    add_result "preflight" "Disk space" "ok" "$((avail / 1024)) MiB free at $parent" "-"
  fi
}

check_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    add_result "preflight" "Privileges" "ok" "running as root" "-"
    return
  fi
  if ! have sudo; then
    add_result "preflight" "Privileges" "fail" "no sudo and not root; install requires elevated privileges" "-"
    return
  fi
  # Don't try to invoke sudo -n if non-interactive; just confirm presence.
  add_result "preflight" "Privileges" "ok" "sudo available" "-"
}

check_network() {
  local urls="https://github.com https://api.github.com"
  if [ "$PUBLIC_HTTPS_SETUP" = "duckdns" ]; then
    urls="$urls https://www.duckdns.org https://get.acme.sh"
  fi
  local u missing=""
  for u in $urls; do
    if ! network_reach "$u"; then missing="$missing $u"; fi
  done
  if [ -z "$missing" ]; then
    add_result "preflight" "Network" "ok" "reachable: $(printf '%s' "$urls" | tr '\n' ' ')" "-"
  else
    add_result "preflight" "Network" "fail" "unreachable:$missing" "-"
  fi
}

check_ports() {
  local mode="$1" ports="" p listener
  ports="$PORT $VNC_PORT"
  if [ "$mode" = "docker" ]; then
    ports="$ports $UPDATE_BRIDGE_PORT"
  fi
  if [ "$PUBLIC_HTTPS_SETUP" = "duckdns" ]; then
    ports="$ports 80 443"
  fi
  for p in $ports; do
    listener="$(port_listener "$p")"
    if [ -z "$listener" ]; then
      add_result "preflight" "Port $p" "ok" "free" "-"
    else
      # If listener is "ours" (our existing nginx/orchestrator), this is the re-install case.
      # We mark warn rather than fail so install can decide to reuse.
      add_result "preflight" "Port $p" "warn" "in use: $listener" "-"
    fi
  done
}

check_docker_if_needed() {
  local mode="$1"
  [ "$mode" = "docker" ] || return 0
  if ! have docker; then
    add_result "preflight" "Docker" "warn" "not installed; installer will install it" "-"
    return
  fi
  if docker info >/dev/null 2>&1; then
    add_result "preflight" "Docker" "ok" "daemon reachable" "-"
  elif have sudo && sudo -n docker info >/dev/null 2>&1; then
    add_result "preflight" "Docker" "ok" "daemon reachable (via sudo)" "-"
  else
    add_result "preflight" "Docker" "warn" "installed but daemon not reachable (will try to start)" "fix_start_docker"
  fi
  if docker compose version >/dev/null 2>&1 || have docker-compose; then
    add_result "preflight" "Docker Compose" "ok" "available" "-"
  else
    add_result "preflight" "Docker Compose" "warn" "not installed; installer will install it" "-"
  fi
}

check_duckdns_inputs() {
  [ "$PUBLIC_HTTPS_SETUP" = "duckdns" ] || return 0
  if [ -z "$DUCKDNS_DOMAIN" ]; then
    add_result "preflight" "DuckDNS domain" "info" "not set; installer will prompt" "-"
  else
    local d="${DUCKDNS_DOMAIN%.duckdns.org}"
    if printf '%s' "$d" | grep -Eq '^[a-z0-9][a-z0-9-]{0,62}$'; then
      add_result "preflight" "DuckDNS domain" "ok" "$d.duckdns.org" "-"
    else
      add_result "preflight" "DuckDNS domain" "fail" "invalid format: $DUCKDNS_DOMAIN" "-"
    fi
  fi
  if [ -z "$DUCKDNS_TOKEN" ]; then
    add_result "preflight" "DuckDNS token" "info" "not set; installer will prompt" "-"
  else
    # DuckDNS tokens are UUID-ish (8-4-4-4-12 hex).
    if printf '%s' "$DUCKDNS_TOKEN" | grep -Eq '^[0-9a-fA-F-]{20,}$'; then
      add_result "preflight" "DuckDNS token" "ok" "format looks valid" "-"
    else
      add_result "preflight" "DuckDNS token" "warn" "token format looks unusual" "-"
    fi
  fi
}

run_preflight() {
  local mode
  mode="$(resolve_install_mode)"
  reset_results
  check_os_supported
  check_disk_space
  check_sudo
  check_network
  check_ports "$mode"
  check_docker_if_needed "$mode"
  check_duckdns_inputs
}

# ---------- Inspect: leftover state ----------

inspect_orch_home() {
  if [ ! -d "$ORCH_HOME" ]; then
    return
  fi
  # If the only thing in there is our own doctor logs, skip the row — the rest
  # of inspect_* will tell the real story.
  local extras
  extras="$(find "$ORCH_HOME" -mindepth 1 -maxdepth 1 -not -path "$LOG_DIR" 2>/dev/null | head -1)"
  if [ -z "$extras" ]; then
    return
  fi
  local size mtime
  size="$(du -sh "$ORCH_HOME" 2>/dev/null | awk '{ print $1 }')"
  mtime="$(date -r "$ORCH_HOME" '+%Y-%m-%d' 2>/dev/null || true)"
  add_result "inspect" "$ORCH_HOME" "info" "exists, ${size:-?} (mtime ${mtime:-?})" "-"
}

inspect_app_checkout() {
  if [ ! -d "$APP_DIR" ]; then
    add_result "inspect" "App checkout" "info" "$APP_DIR absent" "-"
    return
  fi
  if [ ! -d "$APP_DIR/.git" ]; then
    add_result "inspect" "App checkout" "warn" "$APP_DIR exists but is not a git checkout" "-"
    return
  fi
  local remote branch
  remote="$(git -C "$APP_DIR" remote get-url origin 2>/dev/null || true)"
  branch="$(git -C "$APP_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  add_result "inspect" "App checkout" "ok" "${branch:-?} @ ${remote:-?}" "-"
}

inspect_env_file() {
  local f="$APP_DIR/.env"
  if [ ! -f "$f" ]; then
    add_result "inspect" ".env" "info" "absent" "-"
    return
  fi
  local cur_url cur_domain
  cur_url="$(grep -E '^ORCHESTRATOR_PUBLIC_URL=' "$f" 2>/dev/null | tail -1 | cut -d= -f2-)"
  cur_domain="$(grep -E '^ORCHESTRATOR_DUCKDNS_DOMAIN=' "$f" 2>/dev/null | tail -1 | cut -d= -f2-)"
  local detail="present"
  [ -n "$cur_url" ]    && detail="$detail, PUBLIC_URL=$cur_url"
  [ -n "$cur_domain" ] && detail="$detail, DUCKDNS=$cur_domain"
  # If caller passed a different domain/url, flag.
  local status="ok"
  if [ -n "$DUCKDNS_DOMAIN" ] && [ -n "$cur_domain" ] && [ "$DUCKDNS_DOMAIN" != "$cur_domain" ] && [ "$DUCKDNS_DOMAIN" != "${cur_domain%.duckdns.org}" ]; then
    status="warn"
    detail="$detail (configured for $cur_domain, but env requests $DUCKDNS_DOMAIN)"
  fi
  add_result "inspect" ".env" "$status" "$detail" "-"
}

inspect_systemd_user_units() {
  is_linux || return 0
  have systemctl || return 0
  local units file
  for unit in "$SERVICE_NAME.service" "$UPDATE_BRIDGE_SERVICE_NAME.service" "$DUCKDNS_TIMER_NAME.timer" "$DUCKDNS_TIMER_NAME.service"; do
    file="$HOME/.config/systemd/user/$unit"
    if [ -f "$file" ]; then
      local active="inactive"
      if systemctl --user is-active --quiet "$unit" 2>/dev/null; then active="active"; fi
      add_result "inspect" "systemd:$unit" "info" "$active ($file)" "-"
    fi
  done
}

inspect_launchd() {
  is_darwin || return 0
  local plist="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
  if [ -f "$plist" ]; then
    local loaded="unloaded"
    if launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1; then loaded="loaded"; fi
    add_result "inspect" "launchd:$LAUNCHD_LABEL" "info" "$loaded ($plist)" "-"
  fi
}

inspect_nginx_site() {
  is_linux || return 0
  [ -d /etc/nginx ] || return 0

  # Find nginx files that look orchestrator-related: by filename or by content
  # (proxy_pass to our port, or server_name ending in .duckdns.org). Excludes
  # bak/backup/disabled files. Uses sudo if needed because most files are
  # owned by root.
  local files name_matches content_matches scan_dirs
  scan_dirs="/etc/nginx/sites-available /etc/nginx/sites-enabled /etc/nginx/conf.d"
  name_matches="$(run_sudo find $scan_dirs -maxdepth 1 -type f \( -iname '*orchestrator*' -o -iname '*duckdns*' \) 2>/dev/null | grep -vE '\.(bak|disabled|orig|old)' || true)"
  content_matches="$(run_sudo grep -RIl -E "proxy_pass[[:space:]]+http://127\.0\.0\.1:$PORT([^0-9]|$)|server_name[[:space:]]+[^;]*\.duckdns\.org" $scan_dirs 2>/dev/null | grep -vE '\.(bak|disabled|orig|old)' || true)"
  files="$(printf '%s\n%s\n' "$name_matches" "$content_matches" | awk 'NF' | sort -u)"

  if [ -z "$files" ]; then
    add_result "inspect" "nginx site" "info" "no orchestrator-related site in /etc/nginx" "-"
    return
  fi

  local want=""
  if [ -n "$DUCKDNS_DOMAIN" ]; then
    want="$DUCKDNS_DOMAIN"
    case "$want" in *.duckdns.org) ;; *) want="$want.duckdns.org" ;; esac
  fi

  local file existing_domain status detail cert_path
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    existing_domain="$(run_sudo grep -E '^[[:space:]]*server_name\b' "$file" 2>/dev/null | head -1 | awk '{ print $2 }' | sed 's/;$//')"
    cert_path="$(run_sudo grep -E '^[[:space:]]*ssl_certificate\s+' "$file" 2>/dev/null | head -1 | awk '{ print $2 }' | sed 's/;$//')"
    status="ok"
    detail="$file (server_name=${existing_domain:-?}"
    [ -n "$cert_path" ] && detail="$detail, cert=$cert_path"
    detail="$detail)"
    if [ -n "$want" ] && [ -n "$existing_domain" ] && [ "$existing_domain" != "$want" ]; then
      status="warn"
      detail="$detail — differs from requested $want"
    fi
    add_result "inspect" "nginx site" "$status" "$detail" "-"
  done <<EOF
$files
EOF
}

inspect_acme_sh() {
  local acme="" listing="" location=""
  if [ -x "$HOME/.acme.sh/acme.sh" ]; then
    acme="$HOME/.acme.sh/acme.sh"
    location="$HOME/.acme.sh"
    listing="$("$acme" --list 2>/dev/null | awk 'NR>1 { print $1 }' | grep -E '\.duckdns\.org$' | tr '\n' ',' | sed 's/,$//')"
  elif run_sudo test -x /root/.acme.sh/acme.sh 2>/dev/null; then
    acme="/root/.acme.sh/acme.sh"
    location="/root/.acme.sh"
    listing="$(run_sudo /root/.acme.sh/acme.sh --list 2>/dev/null | awk 'NR>1 { print $1 }' | grep -E '\.duckdns\.org$' | tr '\n' ',' | sed 's/,$//')"
  fi
  if [ -z "$acme" ]; then
    add_result "inspect" "acme.sh" "info" "not installed" "-"
    return
  fi
  if [ -z "$listing" ]; then
    add_result "inspect" "acme.sh" "info" "installed at $location, no DuckDNS certs registered" "-"
  else
    add_result "inspect" "acme.sh" "info" "$location → DuckDNS certs: $listing" "-"
  fi
}

inspect_one_cert() {
  # $1 = label, $2 = path to fullchain.pem, $3 = path to privkey.pem (optional)
  local label="$1" fc="$2" key="${3:-}" need_sudo=0
  # Existence check. Parent dir may be 700-owned-by-root, so [ -e ] from an
  # unprivileged user returns false even when the file exists. Fall back to
  # sudo test if the cheap check fails.
  local fc_exists=0 key_exists=0
  [ -e "$fc" ] && fc_exists=1
  if [ "$fc_exists" = "0" ]; then
    if run_sudo test -e "$fc" 2>/dev/null; then fc_exists=1; need_sudo=1; fi
  fi
  if [ -n "$key" ]; then
    [ -e "$key" ] && key_exists=1
    if [ "$key_exists" = "0" ]; then
      if run_sudo test -e "$key" 2>/dev/null; then key_exists=1; need_sudo=1; fi
    fi
  fi
  if [ "$fc_exists" = "0" ] && [ "$key_exists" = "0" ]; then return 0; fi
  if [ "$need_sudo" = "0" ] && [ ! -r "$fc" ]; then need_sudo=1; fi

  local fc_ok=0 key_ok=0
  if [ "$need_sudo" = "1" ]; then
    run_sudo test -s "$fc" 2>/dev/null && fc_ok=1
    [ -n "$key" ] && run_sudo test -s "$key" 2>/dev/null && key_ok=1
  else
    [ -s "$fc" ] && fc_ok=1
    [ -n "$key" ] && [ -s "$key" ] && key_ok=1
  fi
  if [ "$fc_ok" = "0" ] && [ "$key_ok" = "0" ]; then return 0; fi
  if [ "$fc_ok" = "0" ] || ([ -n "$key" ] && [ "$key_ok" = "0" ]); then
    add_result "inspect" "$label" "warn" "$fc partial cert files (one of fullchain/privkey missing or empty)" "-"
    return 0
  fi
  if ! have openssl; then
    add_result "inspect" "$label" "info" "$fc cert present (openssl not available to inspect)" "-"
    return 0
  fi
  local pem_subject pem_enddate cn end_epoch now_epoch days_left
  if [ "$need_sudo" = "1" ]; then
    pem_subject="$(run_sudo openssl x509 -in "$fc" -noout -subject 2>/dev/null)"
    pem_enddate="$(run_sudo openssl x509 -in "$fc" -noout -enddate 2>/dev/null)"
  else
    pem_subject="$(openssl x509 -in "$fc" -noout -subject 2>/dev/null)"
    pem_enddate="$(openssl x509 -in "$fc" -noout -enddate 2>/dev/null)"
  fi
  cn="$(printf '%s' "$pem_subject" | sed -n 's/.*CN[[:space:]]*=[[:space:]]*//p' | sed 's/,.*//')"
  end_epoch="$(printf '%s' "$pem_enddate" | cut -d= -f2 | { read -r d; if [ -n "$d" ]; then date -u -d "$d" +%s 2>/dev/null || date -u -j -f '%b %d %H:%M:%S %Y %Z' "$d" +%s 2>/dev/null; fi; })"
  now_epoch="$(date -u +%s)"
  local status="ok" detail="$fc (CN=${cn:-?}"
  if [ -n "$end_epoch" ]; then
    days_left=$(( (end_epoch - now_epoch) / 86400 ))
    detail="$detail, expires in ${days_left}d"
    if   [ "$days_left" -lt 0 ];  then status="fail"
    elif [ "$days_left" -lt 14 ]; then status="warn"
    fi
  fi
  detail="$detail)"
  if [ -n "$DUCKDNS_DOMAIN" ] && [ -n "$cn" ]; then
    local want="$DUCKDNS_DOMAIN"
    case "$want" in *.duckdns.org) ;; *) want="$want.duckdns.org" ;; esac
    if [ "$cn" != "$want" ]; then
      [ "$status" = "ok" ] && status="warn"
      detail="$detail — cert is for $cn, install wants $want"
    fi
  fi
  add_result "inspect" "$label" "$status" "$detail" "fix_cert_reissue"
}

inspect_tls_files() {
  local managed_fc="$ORCH_HOME/tls/fullchain.pem" managed_key="$ORCH_HOME/tls/privkey.pem"
  local managed_seen=0

  if [ -e "$managed_fc" ] || [ -e "$managed_key" ]; then
    inspect_one_cert "TLS (managed)" "$managed_fc" "$managed_key"
    managed_seen=1
  fi

  # Common manual locations. Direct paths first (no glob).
  local cand
  for cand in /etc/orchestrator/tls/duckdns/fullchain.pem /etc/orchestrator/fullchain.pem; do
    inspect_one_cert "TLS ($cand)" "$cand" "${cand%/fullchain.pem}/privkey.pem"
  done

  # /etc/letsencrypt/live/*/fullchain.pem — needs sudo to enumerate.
  local le_paths
  le_paths="$(run_sudo bash -c 'for f in /etc/letsencrypt/live/*/fullchain.pem; do [ -e "$f" ] && echo "$f"; done' 2>/dev/null || true)"
  if [ -n "$le_paths" ]; then
    local fc
    while IFS= read -r fc; do
      [ -z "$fc" ] && continue
      inspect_one_cert "TLS ($fc)" "$fc" "${fc%/fullchain.pem}/privkey.pem"
    done <<EOF
$le_paths
EOF
  fi

  # Anything nginx is configured to use that we have not yet covered.
  is_linux || { [ "$managed_seen" = "0" ] && add_result "inspect" "TLS files" "info" "$ORCH_HOME/tls empty / absent" "-"; return; }
  local nginx_certs
  nginx_certs="$(run_sudo grep -RhE '^[[:space:]]*ssl_certificate[[:space:]]+' /etc/nginx 2>/dev/null | awk '{ print $2 }' | sed 's/;$//' | grep -E 'orchestrator|duckdns' | sort -u || true)"
  if [ -n "$nginx_certs" ]; then
    local cert
    while IFS= read -r cert; do
      [ -z "$cert" ] && continue
      # Skip if already covered above.
      case "$cert" in
        "$managed_fc"|/etc/orchestrator/tls/duckdns/fullchain.pem) continue ;;
      esac
      inspect_one_cert "TLS (nginx ref)" "$cert"
    done <<EOF
$nginx_certs
EOF
  fi

  if [ "$managed_seen" = "0" ] && [ -z "$nginx_certs" ]; then
    add_result "inspect" "TLS files" "info" "$ORCH_HOME/tls empty / absent" "-"
  fi
}

inspect_crontab() {
  have crontab || return 0
  local entries
  entries="$(crontab -l 2>/dev/null | grep -iE 'orchestrator|duckdns' || true)"
  if [ -n "$entries" ]; then
    local count
    count="$(printf '%s\n' "$entries" | wc -l | tr -d ' ')"
    add_result "inspect" "crontab" "info" "$count orchestrator/duckdns entr$([ "$count" = "1" ] && printf 'y' || printf 'ies') in user crontab" "-"
  fi
}

inspect_docker_artifacts() {
  have docker || return 0
  docker info >/dev/null 2>&1 || return 0
  local containers volumes networks
  containers="$(docker ps -a --filter 'name=orchestrator' --format '{{.Names}} ({{.Status}})' 2>/dev/null | tr '\n' ',' | sed 's/,$//')"
  volumes="$(docker volume ls --filter 'name=orchestrator' --format '{{.Name}}' 2>/dev/null | tr '\n' ',' | sed 's/,$//')"
  networks="$(docker network ls --filter 'name=orchestrator' --format '{{.Name}}' 2>/dev/null | tr '\n' ',' | sed 's/,$//')"
  if [ -n "$containers" ]; then
    add_result "inspect" "docker containers" "info" "$containers" "-"
  fi
  if [ -n "$volumes" ]; then
    add_result "inspect" "docker volumes" "info" "$volumes" "-"
  fi
  if [ -n "$networks" ]; then
    add_result "inspect" "docker networks" "info" "$networks" "-"
  fi
}

inspect_bin_cli() {
  local f="$BIN_DIR/orchestrator"
  if [ -f "$f" ]; then
    add_result "inspect" "CLI" "info" "$f" "-"
  fi
}

inspect_update_bridge() {
  if [ -s "$UPDATE_BRIDGE_TOKEN_FILE" ]; then
    add_result "inspect" "update bridge token" "info" "$UPDATE_BRIDGE_TOKEN_FILE" "-"
  fi
  local pidf="$ORCH_HOME/update-bridge.pid"
  if [ -f "$pidf" ]; then
    local pid
    pid="$(cat "$pidf" 2>/dev/null)"
    if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
      add_result "inspect" "update bridge process" "info" "pid $pid alive" "-"
    else
      add_result "inspect" "update bridge process" "warn" "stale pidfile $pidf" "-"
    fi
  fi
}

run_inspect() {
  reset_results
  load_env_file
  inspect_orch_home
  inspect_app_checkout
  inspect_env_file
  inspect_systemd_user_units
  inspect_launchd
  inspect_nginx_site
  inspect_acme_sh
  inspect_tls_files
  inspect_crontab
  inspect_docker_artifacts
  inspect_bin_cli
  inspect_update_bridge
}

# Returns 0 if inspect found no concrete previous-install evidence, 3 if state present.
# Only specific named rows count as evidence; the mere existence of $ORCH_HOME
# (the directory itself) does not.
inspect_exit_code() {
  local i n=0 stale=0 name detail status
  n="${#RES_NAMES[@]}"
  i=0
  while [ "$i" -lt "$n" ]; do
    name="${RES_NAMES[$i]}"
    detail="${RES_DETAILS[$i]}"
    status="${RES_STATUSES[$i]}"
    # warn/fail anywhere → definitely stale.
    case "$status" in
      warn|fail) stale=1; i=$((i + 1)); continue ;;
    esac
    # info rows: only some names imply previous install.
    case "$name" in
      "App checkout"|".env"|"nginx site"|"TLS files"|"TLS"*|"acme.sh"|"CLI"|"crontab"|\
      "docker containers"|"docker volumes"|"docker networks"|\
      "update bridge token"|"update bridge process"|\
      systemd:*|launchd:*)
        case "$detail" in
          *absent*|*"not installed"*|"no orchestrator.conf"*|*"empty / absent"*|*"no DuckDNS certs registered"*) ;;
          *) stale=1 ;;
        esac
        ;;
    esac
    i=$((i + 1))
  done
  [ "$stale" = "1" ] && return 3
  return 0
}

# ---------- Runtime checks ----------

check_app_responds() {
  local url="http://$HOST:$PORT/api/update/status"
  if network_reach "$url"; then
    add_result "runtime" "App liveness" "ok" "$url responds" "-"
  else
    add_result "runtime" "App liveness" "warn" "$url not responding" "fix_restart_service"
  fi
}

check_dns_resolution() {
  [ "$PUBLIC_HTTPS_SETUP" = "duckdns" ] || return 0
  [ -n "$DUCKDNS_DOMAIN" ] || return 0
  local domain="$DUCKDNS_DOMAIN"
  case "$domain" in *.duckdns.org) ;; *) domain="$domain.duckdns.org" ;; esac
  local resolved="" pub_ip=""
  if have dig; then
    resolved="$(dig +short "$domain" A 2>/dev/null | tail -1)"
  elif have host; then
    resolved="$(host "$domain" 2>/dev/null | awk '/has address/ { print $4; exit }')"
  elif have getent; then
    resolved="$(getent hosts "$domain" 2>/dev/null | awk '{ print $1; exit }')"
  fi
  if [ -z "$resolved" ]; then
    add_result "runtime" "DNS resolution" "warn" "could not resolve $domain" "-"
    return
  fi
  pub_ip="$(curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || curl -fsS --max-time 4 https://ifconfig.me 2>/dev/null || true)"
  if [ -n "$pub_ip" ] && [ "$resolved" != "$pub_ip" ]; then
    add_result "runtime" "DNS resolution" "warn" "$domain → $resolved, public IP is $pub_ip" "fix_duckdns_update"
  else
    add_result "runtime" "DNS resolution" "ok" "$domain → $resolved" "-"
  fi
}

check_nginx_config() {
  is_linux || return 0
  have nginx || return 0
  if run_sudo nginx -t >/dev/null 2>&1; then
    add_result "runtime" "nginx -t" "ok" "config valid" "-"
  else
    add_result "runtime" "nginx -t" "fail" "config invalid (run: sudo nginx -t)" "fix_nginx_reload"
  fi
}

check_service_state() {
  if is_linux && have systemctl; then
    if [ -f "$HOME/.config/systemd/user/$SERVICE_NAME.service" ]; then
      if systemctl --user is-active --quiet "$SERVICE_NAME.service" 2>/dev/null; then
        add_result "runtime" "orchestrator service" "ok" "systemd user unit active" "-"
      else
        add_result "runtime" "orchestrator service" "warn" "systemd user unit not active" "fix_restart_service"
      fi
    fi
  fi
  if is_darwin; then
    if [ -f "$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist" ]; then
      if launchctl print "gui/$(id -u)/$LAUNCHD_LABEL" >/dev/null 2>&1; then
        add_result "runtime" "orchestrator service" "ok" "launchd agent loaded" "-"
      else
        add_result "runtime" "orchestrator service" "warn" "launchd agent not loaded" "fix_restart_service"
      fi
    fi
  fi
}

run_check() {
  # Combo: preflight (without exiting) + inspect + runtime liveness.
  reset_results
  load_env_file
  local mode
  mode="$(resolve_install_mode)"
  check_os_supported
  check_disk_space
  check_network
  check_ports "$mode"
  # State
  inspect_systemd_user_units
  inspect_launchd
  inspect_nginx_site
  inspect_tls_files
  # Runtime
  check_service_state
  check_app_responds
  check_dns_resolution
  check_nginx_config
}

# ---------- Fixes ----------

# Each fix function:
#   - prints what it intends to do
#   - confirms unless ASSUME_YES
#   - returns 0 on success, non-zero on failure or skip

fix_start_docker() {
  log_info "Starting docker daemon"
  if ! is_linux; then
    log_warn "Docker daemon start is only automated on Linux."
    return 1
  fi
  if have systemctl; then run_sudo systemctl enable --now docker >/dev/null 2>&1 || true; fi
  have service && run_sudo service docker start >/dev/null 2>&1 || true
  docker info >/dev/null 2>&1
}

fix_cert_reissue() {
  local acme="$HOME/.acme.sh/acme.sh"
  [ -x "$acme" ] || { log_error "acme.sh not installed at $acme"; return 1; }
  [ -n "$DUCKDNS_DOMAIN" ] || { log_error "ORCHESTRATOR_DUCKDNS_DOMAIN not set; cannot reissue"; return 1; }
  [ -n "$DUCKDNS_TOKEN" ]  || { log_error "ORCHESTRATOR_DUCKDNS_TOKEN not set; cannot reissue"; return 1; }
  local domain="$DUCKDNS_DOMAIN"
  case "$domain" in *.duckdns.org) ;; *) domain="$domain.duckdns.org" ;; esac
  local tls_dir="$ORCH_HOME/tls"
  mkdir -p "$tls_dir"; chmod 700 "$tls_dir" || true
  confirm "Re-issue Let's Encrypt cert for $domain (destructive)?" "y" || return 1
  log_info "Issuing certificate via acme.sh DNS-01"
  DuckDNS_Token="$DUCKDNS_TOKEN" "$acme" --issue --dns dns_duckdns -d "$domain" --keylength ec-256 --server letsencrypt --force || return 1
  DuckDNS_Token="$DUCKDNS_TOKEN" "$acme" --install-cert -d "$domain" --ecc \
    --fullchain-file "$tls_dir/fullchain.pem" \
    --key-file "$tls_dir/privkey.pem" \
    --reloadcmd "sudo systemctl reload nginx >/dev/null 2>&1 || systemctl reload nginx >/dev/null 2>&1 || true"
}

fix_nginx_reload() {
  is_linux || return 1
  run_sudo nginx -t || { log_error "nginx -t failed"; return 1; }
  if have systemctl; then run_sudo systemctl reload nginx; else run_sudo nginx -s reload; fi
}

fix_nginx_rewrite() {
  log_warn "fix_nginx_rewrite: not implemented; re-run scripts/install.sh to regenerate the site file."
  return 1
}

fix_restart_service() {
  if is_linux && have systemctl && [ -f "$HOME/.config/systemd/user/$SERVICE_NAME.service" ]; then
    systemctl --user restart "$SERVICE_NAME.service"
    return $?
  fi
  if is_darwin && [ -f "$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist" ]; then
    launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL"
    return $?
  fi
  log_warn "No managed service to restart."
  return 1
}

fix_duckdns_update() {
  local script="$ORCH_HOME/duckdns/update.sh"
  if [ -x "$script" ]; then
    "$script"
    return $?
  fi
  [ -n "$DUCKDNS_DOMAIN" ] || { log_error "ORCHESTRATOR_DUCKDNS_DOMAIN not set"; return 1; }
  [ -n "$DUCKDNS_TOKEN" ]  || { log_error "ORCHESTRATOR_DUCKDNS_TOKEN not set"; return 1; }
  local d="${DUCKDNS_DOMAIN%.duckdns.org}"
  local resp
  resp="$(curl -fsS "https://www.duckdns.org/update?domains=$d&token=$DUCKDNS_TOKEN&ip=")"
  [ "$resp" = "OK" ] || { log_error "DuckDNS update failed: $resp"; return 1; }
  log_info "DuckDNS updated"
}

run_fix() {
  # Iterate accumulated results from a prior run_check; apply fixes for warn/fail rows with a fix action.
  local i n applied=0 failed=0 fixname
  n="${#RES_NAMES[@]}"
  if [ "$n" -eq 0 ]; then
    log_info "Nothing to fix. Run 'doctor check' first."
    return 0
  fi
  i=0
  while [ "$i" -lt "$n" ]; do
    fixname="${RES_FIXES[$i]}"
    case "${RES_STATUSES[$i]}" in
      warn|fail) ;;
      *) i=$((i + 1)); continue ;;
    esac
    if [ "$fixname" = "-" ]; then i=$((i + 1)); continue; fi
    log_info "Applying fix '$fixname' for ${RES_NAMES[$i]}"
    if "$fixname"; then
      applied=$((applied + 1))
    else
      failed=$((failed + 1))
    fi
    i=$((i + 1))
  done
  log_info "Fixes applied: $applied, failed: $failed"
  [ "$failed" = "0" ]
}

# ---------- Uninstall ----------

uninstall_systemd() {
  is_linux || return 0
  have systemctl || return 0
  local unit
  for unit in "$SERVICE_NAME.service" "$UPDATE_BRIDGE_SERVICE_NAME.service" "$DUCKDNS_TIMER_NAME.timer" "$DUCKDNS_TIMER_NAME.service"; do
    local file="$HOME/.config/systemd/user/$unit"
    [ -f "$file" ] || continue
    log_info "Disabling and removing $unit"
    systemctl --user disable --now "$unit" >/dev/null 2>&1 || true
    rm -f "$file"
  done
  systemctl --user daemon-reload >/dev/null 2>&1 || true
}

uninstall_launchd() {
  is_darwin || return 0
  local plist="$HOME/Library/LaunchAgents/$LAUNCHD_LABEL.plist"
  [ -f "$plist" ] || return 0
  log_info "Booting out launchd agent and removing $plist"
  launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
  rm -f "$plist"
}

uninstall_crontab() {
  have crontab || return 0
  if crontab -l 2>/dev/null | grep -qE 'orchestrator|duckdns'; then
    log_info "Removing orchestrator/duckdns entries from user crontab"
    crontab -l 2>/dev/null | grep -vE 'orchestrator|duckdns' | crontab - || true
  fi
}

uninstall_nginx_site() {
  is_linux || return 0
  local f
  for f in /etc/nginx/sites-available/orchestrator.conf /etc/nginx/conf.d/orchestrator.conf /etc/nginx/sites-enabled/orchestrator.conf /etc/nginx/conf.d/orchestrator-hash-bucket.conf; do
    if [ -e "$f" ] || [ -L "$f" ]; then
      log_info "Removing $f"
      run_sudo rm -f "$f" || true
    fi
  done
  if have nginx; then
    run_sudo nginx -t >/dev/null 2>&1 && {
      have systemctl && run_sudo systemctl reload nginx >/dev/null 2>&1 || run_sudo nginx -s reload >/dev/null 2>&1 || true
    }
  fi
}

uninstall_acme_cert() {
  local acme="$HOME/.acme.sh/acme.sh"
  [ -x "$acme" ] || return 0
  [ -n "$DUCKDNS_DOMAIN" ] || return 0
  local domain="$DUCKDNS_DOMAIN"
  case "$domain" in *.duckdns.org) ;; *) domain="$domain.duckdns.org" ;; esac
  if "$acme" --list 2>/dev/null | awk 'NR>1 { print $1 }' | grep -qx "$domain"; then
    log_info "Removing acme.sh cert and renewal entry for $domain"
    "$acme" --remove -d "$domain" --ecc >/dev/null 2>&1 || true
    "$acme" --revoke -d "$domain" --ecc >/dev/null 2>&1 || true
  fi
}

uninstall_docker_artifacts() {
  local purge="$1"
  docker_reachable || return 0

  if [ "$purge" = "1" ]; then
    if run_compose down --remove-orphans --volumes >/dev/null 2>&1; then
      log_info "Stopped Docker Compose stack and removed Orchestrator volumes"
    fi
  else
    if run_compose down --remove-orphans >/dev/null 2>&1; then
      log_info "Stopped Docker Compose stack (kept persistent volumes)"
    fi
  fi

  local ids id names volumes volume networks network
  ids="$(
    {
      run_docker ps -a --filter 'name=orchestrator' --format '{{.ID}}' 2>/dev/null || true
      run_docker ps -a --filter "label=com.docker.compose.project.working_dir=$APP_DIR" --filter 'label=com.docker.compose.service=orchestrator' --format '{{.ID}}' 2>/dev/null || true
    } | sort -u
  )"
  if [ -n "$ids" ]; then
    names="$(
      for id in $ids; do
        run_docker inspect --format '{{.Name}}' "$id" 2>/dev/null | sed 's|^/||'
      done | tr '\n' ' '
    )"
    log_info "Stopping and removing docker containers: $names"
    for id in $ids; do
      run_docker rm -f "$id" >/dev/null 2>&1 || true
    done
  fi

  networks="$(run_docker network ls --filter 'name=orchestrator' --format '{{.Name}}' 2>/dev/null | sort -u || true)"
  if [ -n "$networks" ]; then
    log_info "Removing docker networks: $(printf '%s' "$networks" | tr '\n' ' ')"
    for network in $networks; do
      run_docker network rm "$network" >/dev/null 2>&1 || true
    done
  fi

  if [ "$purge" = "1" ]; then
    volumes="$(
      {
        run_docker volume ls --filter 'name=orchestrator' --format '{{.Name}}' 2>/dev/null || true
        run_docker volume ls --filter 'label=com.docker.compose.volume=orchestrator-data' --format '{{.Name}}' 2>/dev/null || true
        run_docker volume ls --filter 'label=com.docker.compose.volume=orchestrator-node-home' --format '{{.Name}}' 2>/dev/null || true
      } | sort -u
    )"
    if [ -n "$volumes" ]; then
      log_info "Removing docker volumes: $(printf '%s' "$volumes" | tr '\n' ' ')"
      for volume in $volumes; do
        run_docker volume rm "$volume" >/dev/null 2>&1 || true
      done
    fi
    if run_docker image inspect orchestrator:local >/dev/null 2>&1; then
      log_info "Removing docker image: orchestrator:local"
      run_docker image rm orchestrator:local >/dev/null 2>&1 || true
    fi
  fi
}

dir_is_empty() {
  [ -d "$1" ] || return 0
  [ -z "$(find "$1" -mindepth 1 -maxdepth 1 2>/dev/null | head -1)" ]
}

preserve_app_state() {
  local app_state="$APP_DIR/.orchestrator" state_dir="$ORCH_HOME/state" backup_dir
  [ -e "$app_state" ] || [ -L "$app_state" ] || return 0

  if [ -L "$app_state" ]; then
    # Removing the checkout removes the symlink, not the state directory.
    return 0
  fi

  mkdir -p "$ORCH_HOME" 2>/dev/null || true
  if [ -d "$app_state" ] && { [ ! -e "$state_dir" ] || dir_is_empty "$state_dir"; }; then
    rm -rf "$state_dir" 2>/dev/null || true
    log_info "Preserving native runtime state at $state_dir"
    if ! mv "$app_state" "$state_dir" 2>/dev/null; then
      log_error "Could not preserve native runtime state from $app_state"
      return 1
    fi
    return 0
  fi

  backup_dir="$ORCH_HOME/state.backup.$(date +%Y%m%d%H%M%S)"
  log_warn "Preserving native runtime state at $backup_dir because $state_dir already exists"
  if ! mv "$app_state" "$backup_dir" 2>/dev/null; then
    log_error "Could not preserve native runtime state from $app_state"
    return 1
  fi
}

uninstall_app_dir() {
  local purge="$1"
  if [ "$purge" != "1" ]; then
    preserve_app_state || return 1
  fi
  if [ -d "$APP_DIR" ]; then
    log_info "Removing $APP_DIR"
    rm -rf "$APP_DIR"
  fi
  if [ "$purge" = "1" ]; then
    [ -d "$ORCH_HOME" ] && {
      log_info "Purging $ORCH_HOME (data and logs)"
      rm -rf "$ORCH_HOME"
    }
    [ -d "$NODE_HOME_DIR" ] && {
      log_info "Purging $NODE_HOME_DIR (container cache)"
      rm -rf "$NODE_HOME_DIR"
    }
  else
    rm -f "$ORCH_HOME/update-bridge-token" "$ORCH_HOME/update-bridge.pid" 2>/dev/null || true
    if [ -d "$ORCH_HOME/duckdns" ]; then rm -rf "$ORCH_HOME/duckdns"; fi
  fi
}

uninstall_bin() {
  if [ -f "$BIN_DIR/orchestrator" ]; then
    log_info "Removing $BIN_DIR/orchestrator"
    rm -f "$BIN_DIR/orchestrator"
  fi
}

run_uninstall() {
  local purge=0
  for arg in "$@"; do
    case "$arg" in
      --purge) purge=1 ;;
    esac
  done

  log_warn "About to remove the orchestrator installation:"
  log_warn "  - systemd user units, launchd agent, crontab entries"
  log_warn "  - nginx site config (under sudo)"
  log_warn "  - acme.sh cert and renewal (if DUCKDNS_DOMAIN known)"
  log_warn "  - docker orchestrator containers and networks"
  log_warn "  - $APP_DIR"
  log_warn "  - $BIN_DIR/orchestrator"
  if [ "$purge" = "1" ]; then
    log_warn "  - docker orchestrator volumes and image"
    log_warn "  - $ORCH_HOME (data + logs) — PURGED"
    log_warn "  - $NODE_HOME_DIR (container cache) — PURGED"
  else
    log_warn "  Keeping: $ORCH_HOME data/logs, $NODE_HOME_DIR cache, and docker volumes. Pass --purge to remove."
  fi

  confirm "Proceed with uninstall?" "n" || { log_info "Aborted."; return 1; }

  load_env_file
  uninstall_systemd
  uninstall_launchd
  uninstall_crontab
  uninstall_nginx_site
  uninstall_docker_artifacts "$purge"
  uninstall_acme_cert
  uninstall_app_dir "$purge" || return 1
  uninstall_bin

  if [ "$purge" = "1" ]; then
    log_info "Uninstall complete. Run-log was purged with $ORCH_HOME."
  else
    log_info "Uninstall complete. Run-log: $DOCTOR_LOG_FILE"
  fi
}

# ---------- Help / dispatch ----------

usage() {
  cat <<'EOF'
orchestrator doctor — preflight, state discovery, runtime health, fixes, uninstall

Usage:
  doctor preflight             Read-only pre-install checks (network, ports, sudo, deps).
  doctor inspect               List leftover state from previous install.
  doctor check                 Runtime health: preflight + inspect + service/DNS/cert.
  doctor fix                   Apply suggested fixes for the last check run.
  doctor uninstall [--purge]   Remove the installation. --purge also wipes data and Orchestrator Docker volumes.
  doctor help                  Show this message.

Flags:
  --yes        Skip confirmation prompts for destructive steps.
  --quiet      Hide info-level rows; show only warn/fail.
  --json       Reserved; currently same as plain output.

Exit codes:
  0  healthy / clean / done
  1  hard failure (blocker)
  2  warnings only
  3  stale state found (inspect)

Examples:
  ORCHESTRATOR_PUBLIC_HTTPS_SETUP=duckdns \
  ORCHESTRATOR_DUCKDNS_DOMAIN=my-orch \
    scripts/doctor.sh preflight

  scripts/doctor.sh inspect
  scripts/doctor.sh check
  scripts/doctor.sh fix
  scripts/doctor.sh uninstall --purge --yes
EOF
}

SUBCOMMAND="${1:-help}"; shift || true

# Parse flags from remaining args.
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --json)   JSON_OUTPUT=1 ;;
    --quiet|-q) QUIET=1 ;;
  esac
done

# Only create the doctor log dir for commands that actually do work.
case "$SUBCOMMAND" in
  help|-h|--help|"") : ;;
  *) setup_log_file ;;
esac

case "$SUBCOMMAND" in
  preflight)
    run_preflight
    print_results
    results_summary_exit_code
    rc=$?
    exit "$rc"
    ;;
  inspect)
    run_inspect
    print_results
    inspect_exit_code
    exit $?
    ;;
  check)
    run_check
    print_results
    results_summary_exit_code
    exit $?
    ;;
  fix)
    # Recompute check then apply fixes.
    run_check
    print_results
    run_fix
    exit $?
    ;;
  uninstall)
    run_uninstall "$@"
    exit $?
    ;;
  help|-h|--help|"")
    usage
    exit 0
    ;;
  *)
    log_error "Unknown subcommand: $SUBCOMMAND"
    usage
    exit 4
    ;;
esac
