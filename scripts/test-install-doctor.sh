#!/usr/bin/env bash
# End-to-end test of install.sh + doctor.sh integration.
#
# Requires a fresh Linux box with: git, curl, sudo NOPASSWD, python3,
# and a checkout of this repo at $SRC. Run as a non-root user (default 'test').
#
# Suggested driver (run on a Linux host with docker):
#   tar -czf /tmp/orch.tgz --exclude=node_modules --exclude=.next --exclude=.orchestrator --exclude=.orchestrator-data --exclude=.orchestrator-node-home .
#   docker run -d --name orch-test -v /tmp/orch.tgz:/tmp/orch.tgz:ro \
#     --hostname orch-test debian:12 sleep infinity
#   docker exec orch-test bash -c '
#     apt-get update -qq && apt-get install -y -qq git curl sudo python3 ca-certificates
#     useradd -m -s /bin/bash test
#     echo "test ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/test
#     mkdir -p /home/test/src && tar -xzf /tmp/orch.tgz -C /home/test/src
#     cd /home/test/src && rm -rf .git && git init -q \
#       && git config user.email t@l && git config user.name t \
#       && git add -A && git commit -qm test
#     chown -R test:test /home/test
#   '
#   docker cp scripts/test-install-doctor.sh orch-test:/home/test/
#   docker exec -u test -w /home/test orch-test bash test-install-doctor.sh

set -uo pipefail

SRC=${SRC:-/home/test/src}
ORCH_HOME=${ORCH_HOME:-/home/test/.orchestrator}
APP_DIR=${APP_DIR:-/home/test/orchestrator}
NODE_HOME_DIR=${NODE_HOME_DIR:-/home/test/.orchestrator-node-home}
PASS=0; FAIL=0

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

ok()   { green "  PASS: $*"; PASS=$((PASS+1)); }
nope() { red   "  FAIL: $*"; FAIL=$((FAIL+1)); }
assert_eq() { if [ "$2" = "$3" ]; then ok "$1 = $3"; else nope "$1: expected '$2' got '$3'"; fi; }
assert_grep() { if echo "$3" | grep -qE "$2"; then ok "$1"; else nope "$1: pattern '$2' not in output"; echo "---tail---"; echo "$3" | tail -20; fi; }

cleanup() { rm -rf "$ORCH_HOME" "$APP_DIR" "$NODE_HOME_DIR" /home/test/.local/bin/orchestrator 2>/dev/null || true; }
make_stale_state() {
  cleanup; mkdir -p "$APP_DIR"
  git clone -q file://$SRC "$APP_DIR" 2>/dev/null
  cat > "$APP_DIR/.env" <<EE
ORCHESTRATOR_DUCKDNS_DOMAIN=stale
ORCHESTRATOR_PUBLIC_URL=https://stale.duckdns.org
EE
  echo "fake" > "$ORCH_HOME/update-bridge-token"
}

bold "== Test 1: preflight (native mode, fresh box) =="
cleanup
ORCHESTRATOR_INSTALL_MODE=native $SRC/scripts/doctor.sh preflight >/tmp/t1.log 2>&1
rc=$?
assert_eq "preflight rc" "0" "$rc"

bold "== Test 2: preflight (docker mode without docker) — warns =="
cleanup
ORCHESTRATOR_INSTALL_MODE=docker $SRC/scripts/doctor.sh preflight >/tmp/t2.log 2>&1
rc=$?
assert_eq "docker-mode preflight rc" "2" "$rc"
grep -q "Docker.*not installed" /tmp/t2.log && ok "docker warn surfaced" || nope "docker warn missing"

bold "== Test 3: inspect on fresh box is clean =="
cleanup
$SRC/scripts/doctor.sh inspect >/tmp/t3.log 2>&1
assert_eq "fresh inspect rc" "0" "$?"

bold "== Test 4: inspect detects previous-install state =="
cleanup
mkdir -p "$APP_DIR" "$ORCH_HOME/tls"
git clone -q file://$SRC "$APP_DIR" 2>/dev/null
cat > "$APP_DIR/.env" <<EE
ORCHESTRATOR_PUBLIC_URL=https://old-host.duckdns.org
ORCHESTRATOR_DUCKDNS_DOMAIN=old-host
EE
mkdir -p ~/.local/bin; touch ~/.local/bin/orchestrator
echo "fake" > "$ORCH_HOME/update-bridge-token"
mkdir -p "$APP_DIR/.orchestrator"
echo "native-state" > "$APP_DIR/.orchestrator/data.db"
$SRC/scripts/doctor.sh inspect >/tmp/t4.log 2>&1
assert_eq "inspect (state) rc" "3" "$?"
grep -q "App checkout" /tmp/t4.log && ok "checkout row present" || nope "checkout row missing"

bold "== Test 5: domain mismatch flagged =="
out="$(ORCHESTRATOR_DUCKDNS_DOMAIN=new-host $SRC/scripts/doctor.sh inspect 2>&1)"
assert_grep "domain mismatch text" "configured for old-host, but env requests new-host" "$out"

bold "== Test 6: uninstall cleans up =="
$SRC/scripts/doctor.sh uninstall --yes >/tmp/t6.log 2>&1
rc=$?
assert_eq "uninstall rc" "0" "$rc"
[ ! -d "$APP_DIR" ] && ok "app dir removed" || nope "app dir still exists"
[ ! -f /home/test/.local/bin/orchestrator ] && ok "bin removed" || nope "bin still exists"
[ ! -f "$ORCH_HOME/update-bridge-token" ] && ok "token removed" || nope "token still exists"
[ -f "$ORCH_HOME/state/data.db" ] && ok "native state preserved" || nope "native state missing"

bold "== Test 7: post-uninstall inspect is clean =="
$SRC/scripts/doctor.sh inspect >/tmp/t7.log 2>&1
assert_eq "post-uninstall inspect rc" "0" "$?"

bold "== Test 8: uninstall --purge removes preserved data =="
$SRC/scripts/doctor.sh uninstall --purge --yes >/tmp/t8.log 2>&1
rc=$?
assert_eq "purge uninstall rc" "0" "$rc"
[ ! -d "$ORCH_HOME" ] && ok "orchestrator home purged" || nope "orchestrator home still exists"
$SRC/scripts/doctor.sh inspect >/tmp/t8-inspect.log 2>&1
assert_eq "post-purge inspect rc" "0" "$?"

bold "== Test 9: install.sh non-interactive run keeps state (no /dev/tty) =="
# When stdin/tty isn't a real terminal, install.sh should fall through to keep.
make_stale_state
out=$(env \
  ORCHESTRATOR_REPO_URL="file://$SRC" \
  ORCHESTRATOR_INSTALL_MODE=native \
  ORCHESTRATOR_PUBLIC_HTTPS_SETUP=none \
  ORCHESTRATOR_HOME=$ORCH_HOME \
  ORCHESTRATOR_APP_DIR=$APP_DIR \
  timeout 30 bash $SRC/scripts/install.sh </dev/null 2>&1 || true)
assert_grep "detected previous install" "Detected state from a previous install" "$out"
assert_grep "non-interactive keep" "Non-interactive run: keeping existing state" "$out"

bold "== Test 10: ORCHESTRATOR_SKIP_DOCTOR=1 bypasses doctor =="
make_stale_state
out=$(env \
  ORCHESTRATOR_REPO_URL="file://$SRC" \
  ORCHESTRATOR_INSTALL_MODE=native \
  ORCHESTRATOR_PUBLIC_HTTPS_SETUP=none \
  ORCHESTRATOR_HOME=$ORCH_HOME \
  ORCHESTRATOR_APP_DIR=$APP_DIR \
  ORCHESTRATOR_SKIP_DOCTOR=1 \
  timeout 30 bash $SRC/scripts/install.sh </dev/null 2>&1 || true)
assert_grep "skip honored"   "Skipping doctor"            "$out"
if echo "$out" | grep -q "Running preflight checks"; then nope "preflight ran despite SKIP"; else ok "preflight skipped"; fi

bold "== Test 11: install log file is created =="
ls $ORCH_HOME/logs/install-*.log >/dev/null 2>&1 && ok "install log exists" || nope "install log missing"

bold "== Test 12: install.sh aborts on user 'a' choice via interactive pty =="
make_stale_state
# Allocate a real pty via python so install.sh's /dev/tty access works.
out=$(python3 -c "
import pty, os, sys, time
def reader(fd):
    out=b''
    while True:
        try: chunk=os.read(fd,4096)
        except OSError: break
        if not chunk: break
        out+=chunk
    return out

pid,fd=pty.fork()
if pid==0:
    os.execvpe('bash',['bash','$SRC/scripts/install.sh'], dict(os.environ,
        ORCHESTRATOR_REPO_URL='file://$SRC',
        ORCHESTRATOR_INSTALL_MODE='native',
        ORCHESTRATOR_PUBLIC_HTTPS_SETUP='none',
        ORCHESTRATOR_HOME='$ORCH_HOME',
        ORCHESTRATOR_APP_DIR='$APP_DIR'))
# Parent: wait for prompt, type 'a\n'.
import select
buf=b''
end=time.time()+60
while time.time()<end:
    r,_,_=select.select([fd],[],[],1)
    if fd in r:
        try: chunk=os.read(fd,4096)
        except OSError: break
        if not chunk: break
        buf+=chunk
        if b'[k/r/a]' in buf:
            os.write(fd,b'a\n'); break
# Drain remainder, allow it to exit.
while time.time()<end:
    r,_,_=select.select([fd],[],[],1)
    if fd in r:
        try: chunk=os.read(fd,4096)
        except OSError: break
        if not chunk: break
        buf+=chunk
    else: break
try: os.waitpid(pid, os.WNOHANG)
except OSError: pass
sys.stdout.write(buf.decode('utf-8','replace'))
" 2>&1)
assert_grep "interactive abort honored" "Aborted at user's request" "$out"

bold "== Test 13: install.sh continues on user 'k' (keep) via interactive pty =="
make_stale_state
out=$(python3 -c "
import pty, os, sys, time, select
pid,fd=pty.fork()
if pid==0:
    os.execvpe('bash',['bash','$SRC/scripts/install.sh'], dict(os.environ,
        ORCHESTRATOR_REPO_URL='file://$SRC',
        ORCHESTRATOR_INSTALL_MODE='native',
        ORCHESTRATOR_PUBLIC_HTTPS_SETUP='none',
        ORCHESTRATOR_HOME='$ORCH_HOME',
        ORCHESTRATOR_APP_DIR='$APP_DIR'))
buf=b''
end=time.time()+60
while time.time()<end:
    r,_,_=select.select([fd],[],[],1)
    if fd in r:
        try: chunk=os.read(fd,4096)
        except OSError: break
        if not chunk: break
        buf+=chunk
        if b'[k/r/a]' in buf and b'\\n' not in buf[-20:]: 
            os.write(fd,b'k\n'); 
            buf+=b'<INPUT:k>'
            break
end=time.time()+30
while time.time()<end:
    r,_,_=select.select([fd],[],[],1)
    if fd in r:
        try: chunk=os.read(fd,4096)
        except OSError: break
        if not chunk: break
        buf+=chunk
    else: break
sys.stdout.write(buf.decode('utf-8','replace'))
" 2>&1)
assert_grep "interactive keep honored" "Keeping existing state" "$out"

cleanup
echo
bold "== Summary: $PASS passed, $FAIL failed =="
[ "$FAIL" = "0" ]
