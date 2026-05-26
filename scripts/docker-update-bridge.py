#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import termios
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Optional


APP_DIR = Path(os.environ.get("ORCHESTRATOR_UPDATE_APP_DIR", os.getcwd())).resolve()
BRANCH = os.environ.get("ORCHESTRATOR_UPDATE_BRANCH", "master")
BIND_HOST = os.environ.get("ORCHESTRATOR_UPDATE_BRIDGE_BIND", "127.0.0.1")
PORT = int(os.environ.get("ORCHESTRATOR_UPDATE_BRIDGE_PORT", "38733"))
TOKEN_FILE = Path(os.environ.get("ORCHESTRATOR_UPDATE_TOKEN_FILE", str(APP_DIR.parent / "update-bridge-token")))
APP_PORT = os.environ.get("ORCHESTRATOR_PORT", "3000")
LOG_DIR = Path(os.environ.get("ORCHESTRATOR_UPDATE_LOG_DIR", str(APP_DIR.parent / "logs")))
LOG_PATH = LOG_DIR / "docker-update-bridge.log"
CLAUDE_USAGE_TIMEOUT_SECONDS = float(os.environ.get("ORCHESTRATOR_CLAUDE_USAGE_TIMEOUT_SECONDS", "30"))
CLAUDE_USAGE_CWD = Path(
    os.environ.get("ORCHESTRATOR_CLAUDE_USAGE_CWD", str(Path.home() / ".orchestrator" / "claude-usage-cwd"))
).expanduser().resolve()
CLAUDE_USAGE_AUTO_TRUST = os.environ.get("ORCHESTRATOR_CLAUDE_USAGE_AUTO_TRUST", "1") != "0"

update_lock = threading.Lock()
claude_usage_lock = threading.Lock()
state_lock = threading.Lock()
state = {
    "phase": "idle",
    "updatedAt": None,
    "jobId": None,
    "targetTag": None,
    "error": None,
}


def token() -> str:
    return TOKEN_FILE.read_text(encoding="utf-8").strip()


def write_log(message: str) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(f"[{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}] {message}\n")


def set_state(**patch) -> None:
    with state_lock:
        state.update(patch)
        state["updatedAt"] = int(time.time() * 1000)


def run(command: list[str], env: Optional[dict[str, str]] = None) -> None:
    write_log("$ " + " ".join(command))
    with LOG_PATH.open("a", encoding="utf-8") as handle:
        subprocess.run(command, cwd=APP_DIR, check=True, stdout=handle, stderr=handle, env=env)


def capture(command: list[str]) -> str:
    write_log("$ " + " ".join(command))
    result = subprocess.run(command, cwd=APP_DIR, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return result.stdout.strip()


def compose_command() -> list[str]:
    docker = shutil.which("docker")
    if docker:
        probe = subprocess.run([docker, "compose", "version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if probe.returncode == 0:
            return [docker, "compose"]

    legacy = shutil.which("docker-compose")
    if legacy:
        return [legacy]

    raise RuntimeError("Docker Compose is not available.")


def host_path() -> str:
    home = Path.home()
    candidates = [
        str(home / ".npm-global" / "bin"),
        str(home / ".local" / "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
    ]
    current = os.environ.get("PATH", "")
    parts = [p for p in current.split(os.pathsep) if p]
    for candidate in candidates:
        if candidate not in parts:
            parts.append(candidate)
    return os.pathsep.join(parts)


def resolve_claude_bin() -> str:
    configured = os.environ.get("ORCHESTRATOR_CLAUDE_BIN") or os.environ.get("CLAUDE_CODE_BIN")
    if configured:
        path = Path(configured).expanduser()
        if path.exists():
            return str(path)
        raise RuntimeError(f"Configured Claude Code binary does not exist: {path}")

    env = os.environ.copy()
    env["PATH"] = host_path()
    found = shutil.which("claude", path=env["PATH"])
    if found:
        return found

    raise RuntimeError("Claude Code CLI is not installed on the host. Install it with `npm install -g @anthropic-ai/claude-code` and run `claude auth login` on the host.")


def ensure_claude_usage_workspace() -> None:
    CLAUDE_USAGE_CWD.mkdir(parents=True, exist_ok=True)
    try:
        CLAUDE_USAGE_CWD.chmod(0o700)
    except OSError:
        pass
    if CLAUDE_USAGE_AUTO_TRUST:
        ensure_claude_project_trusted(CLAUDE_USAGE_CWD)


def ensure_claude_project_trusted(path: Path) -> None:
    config_path = Path.home() / ".claude.json"
    if config_path.exists():
        try:
            data = json.loads(config_path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise RuntimeError(f"Could not read {config_path}: {exc}")
        if not isinstance(data, dict):
            raise RuntimeError(f"Could not update {config_path}: expected a JSON object.")
    else:
        data = {}

    projects = data.setdefault("projects", {})
    if not isinstance(projects, dict):
        raise RuntimeError(f"Could not update {config_path}: projects is not an object.")

    key = str(path)
    project = projects.setdefault(key, {})
    if not isinstance(project, dict):
        project = {}
        projects[key] = project

    changed = False
    defaults = {
        "allowedTools": [],
        "mcpContextUris": [],
        "mcpServers": {},
        "enabledMcpjsonServers": [],
        "disabledMcpjsonServers": [],
        "hasClaudeMdExternalIncludesApproved": False,
        "hasClaudeMdExternalIncludesWarningShown": False,
    }
    for name, value in defaults.items():
        if name not in project:
            project[name] = value
            changed = True
    if project.get("hasTrustDialogAccepted") is not True:
        project["hasTrustDialogAccepted"] = True
        changed = True
    if not isinstance(project.get("projectOnboardingSeenCount"), int) or project["projectOnboardingSeenCount"] < 1:
        project["projectOnboardingSeenCount"] = 1
        changed = True

    if not changed:
        return

    tmp_path = config_path.with_name(config_path.name + ".tmp")
    tmp_path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    try:
        tmp_path.chmod(0o600)
    except OSError:
        pass
    os.replace(tmp_path, config_path)


ANSI_REPLACEMENTS = [
    re.compile(r"\x1B\[[?]?[0-9;]*[a-zA-Z@`~]"),
    re.compile(r"\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)"),
    re.compile(r"\x1B[()*+][0-9A-Za-z]"),
    re.compile(r"\x1B[=>]"),
]
CONTROL_RE = re.compile(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]")


def strip_ansi(value: str) -> str:
    cleaned = value
    for pattern in ANSI_REPLACEMENTS:
        cleaned = pattern.sub("", cleaned)
    return CONTROL_RE.sub("", cleaned)


def has_claude_usage_quota(value: str) -> bool:
    norm = re.sub(r"\s+", " ", value)
    section = r"Curr[a-z]*\s*(?:session|week)"
    used = r"\d{1,3}%\s*u\w*d"
    reset = r"Res(?:ets?|es)"
    return re.search(section + r".{0,500}?" + used + r".{0,500}?" + reset, norm, re.IGNORECASE) is not None


def terminate_process(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    except Exception:
        proc.terminate()
    deadline = time.time() + 2
    while time.time() < deadline:
        if proc.poll() is not None:
            return
        time.sleep(0.05)
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except Exception:
        proc.kill()


def capture_claude_usage() -> dict:
    if not claude_usage_lock.acquire(blocking=False):
        return {"ok": False, "error": "Claude usage capture is already running."}

    master_fd = -1
    slave_fd = -1
    proc: Optional[subprocess.Popen] = None
    try:
        claude_bin = resolve_claude_bin()
        ensure_claude_usage_workspace()
        master_fd, slave_fd = pty.openpty()
        fcntl_winsize(slave_fd, rows=50, cols=140)

        env = os.environ.copy()
        env["PATH"] = host_path()
        env["TERM"] = env.get("TERM") or "xterm-256color"
        args = [claude_bin, "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']
        proc = subprocess.Popen(
            args,
            cwd=str(CLAUDE_USAGE_CWD),
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            env=env,
            start_new_session=True,
            close_fds=True,
        )
        os.close(slave_fd)
        slave_fd = -1

        buffer = bytearray()
        started = time.time()
        last_data = started
        phase = "wait-prompt"
        enter_at: Optional[float] = None

        while True:
            now = time.time()
            if now - started > CLAUDE_USAGE_TIMEOUT_SECONDS:
                cleaned = strip_ansi(buffer.decode("utf-8", errors="ignore"))
                tail = re.sub(r"\s+", " ", cleaned[-500:]).strip()
                return {"ok": False, "error": f"Timed out waiting for Claude /usage panel. Last output: {tail}"}

            readable, _, _ = select.select([master_fd], [], [], 0.25)
            if readable:
                try:
                    chunk = os.read(master_fd, 8192)
                except OSError:
                    chunk = b""
                if chunk:
                    buffer.extend(chunk)
                    last_data = time.time()

            cleaned = strip_ansi(buffer.decode("utf-8", errors="ignore"))
            lower = cleaned.lower()
            idle = time.time() - last_data
            elapsed = time.time() - started

            if phase == "wait-prompt" and ("trust this folder" in lower or "trustthisfolder" in lower):
                return {"ok": False, "error": f"Claude needs to trust {CLAUDE_USAGE_CWD} first. Run `claude` once on the host in that directory or set ORCHESTRATOR_CLAUDE_USAGE_CWD to a trusted directory."}

            if phase == "wait-prompt" and ((idle > 1.2 and cleaned.strip()) or elapsed > 5):
                phase = "wait-panel"
                os.write(master_fd, b"/usage")
                enter_at = time.time() + 0.25

            if phase == "wait-panel" and enter_at is not None and time.time() >= enter_at:
                os.write(master_fd, b"\r")
                enter_at = None

            if phase == "wait-panel" and has_claude_usage_quota(cleaned) and idle > 1.2:
                return {"ok": True, "text": cleaned, "raw": cleaned, "fetchedAt": int(time.time() * 1000)}

            if proc.poll() is not None:
                if has_claude_usage_quota(cleaned):
                    return {"ok": True, "text": cleaned, "raw": cleaned, "fetchedAt": int(time.time() * 1000)}
                return {"ok": False, "error": "Claude exited before rendering the /usage panel."}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
    finally:
        if proc is not None:
            terminate_process(proc)
        for fd in (master_fd, slave_fd):
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
        claude_usage_lock.release()


def fcntl_winsize(fd: int, rows: int, cols: int) -> None:
    import fcntl
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def notify_app(
    job_id: str,
    phase: str,
    wait_reason: str,
    error: Optional[str] = None,
    target_commit: Optional[str] = None,
) -> None:
    try:
        payload = {
            "jobId": job_id,
            "phase": phase,
            "waitReason": wait_reason,
        }
        if error:
            payload["error"] = error
        if target_commit:
            payload["targetCommit"] = target_commit

        req = urllib.request.Request(
            f"http://127.0.0.1:{APP_PORT}/api/update/host-result",
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "Authorization": f"Bearer {token()}",
                "Content-Type": "application/json",
            },
        )
        urllib.request.urlopen(req, timeout=5).read()
    except (OSError, urllib.error.URLError, urllib.error.HTTPError) as exc:
        write_log(f"Could not notify app update result: {exc}")


def allowed_peer(host: str) -> bool:
    if host in {"127.0.0.1", "::1", "localhost"}:
        return True
    parts = host.split(".")
    if len(parts) != 4:
        return False
    try:
        first, second = int(parts[0]), int(parts[1])
    except ValueError:
        return False
    return first == 10 or (first == 172 and 16 <= second <= 31)


def safe_branch(value: object) -> str:
    branch = str(value or BRANCH).strip()
    allowed = all(ch.isalnum() or ch in "._/-" for ch in branch)
    if (
        not branch
        or branch.startswith("/")
        or branch.endswith("/")
        or ".." in branch
        or not allowed
    ):
        raise RuntimeError(f"Invalid update branch: {branch or '(empty)'}")
    return branch


def update_stack(payload: dict) -> None:
    job_id = str(payload.get("jobId") or f"manual-{int(time.time())}")
    target_tag = str(payload.get("targetTag") or "")
    branch = safe_branch(payload.get("targetBranch"))
    set_state(phase="updating", jobId=job_id, targetTag=target_tag, error=None)
    write_log(f"Starting Docker update job={job_id} target={target_tag or branch}")

    try:
        if not (APP_DIR / ".git").exists():
            raise RuntimeError(f"{APP_DIR} is not a git checkout.")

        run(["git", "-C", str(APP_DIR), "fetch", "origin", branch, "--tags"])
        run(["git", "-C", str(APP_DIR), "checkout", branch])
        run(["git", "-C", str(APP_DIR), "pull", "--ff-only", "origin", branch])
        target_commit = capture(["git", "-C", str(APP_DIR), "rev-parse", "--short=12", "HEAD"])
        notify_app(
            job_id,
            "restarting",
            "Host updater is rebuilding and restarting the Docker stack.",
            target_commit=target_commit,
        )
        compose_env = os.environ.copy()
        compose_env["ORCHESTRATOR_BUILD_COMMIT"] = target_commit
        compose_env["ORCHESTRATOR_BUILD_REF"] = branch
        run([*compose_command(), "up", "--build", "-d"], env=compose_env)
        set_state(phase="completed", error=None)
        write_log(f"Completed Docker update job={job_id}")
    except Exception as exc:
        message = str(exc)
        set_state(phase="failed", error=message)
        write_log(f"Docker update failed job={job_id}: {message}")
        notify_app(job_id, "failed", "Docker host update failed.", message)
    finally:
        if update_lock.locked():
            update_lock.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "OrchestratorDockerUpdateBridge/1.0"

    def log_message(self, fmt: str, *args) -> None:
        write_log(fmt % args)

    def send_json(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def authenticated(self) -> bool:
        if not allowed_peer(self.client_address[0]):
            return False
        auth = self.headers.get("Authorization", "")
        bearer = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        host_header_token = self.headers.get("X-Orchestrator-Host-Bridge-Token", "").strip()
        header_token = self.headers.get("X-Orchestrator-Update-Token", "").strip()
        return bool(token() and (bearer == token() or host_header_token == token() or header_token == token()))

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path not in {"/status", "/claude-usage"}:
            self.send_json(404, {"error": "Not found."})
            return
        if not self.authenticated():
            self.send_json(401, {"error": "Unauthorized."})
            return
        if path == "/status":
            with state_lock:
                self.send_json(200, dict(state))
            return

        write_log("Starting Claude usage capture")
        payload = capture_claude_usage()
        if payload.get("ok"):
            write_log("Completed Claude usage capture")
            self.send_json(200, payload)
        else:
            write_log(f"Claude usage capture failed: {payload.get('error')}")
            self.send_json(502, payload)

    def do_POST(self) -> None:
        if self.path != "/update":
            self.send_json(404, {"error": "Not found."})
            return
        if not self.authenticated():
            self.send_json(401, {"error": "Unauthorized."})
            return
        if not update_lock.acquire(blocking=False):
            self.send_json(409, {"error": "Docker update already running."})
            return

        try:
            length = min(int(self.headers.get("Content-Length", "0") or "0"), 1024 * 1024)
            raw = self.rfile.read(length) if length else b"{}"
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            update_lock.release()
            self.send_json(400, {"error": "Invalid JSON payload."})
            return

        thread = threading.Thread(target=update_stack, args=(payload,), daemon=True)
        thread.start()
        self.send_json(202, {"ok": True, "phase": "updating"})


def main() -> None:
    if not TOKEN_FILE.exists():
        raise SystemExit(f"Missing token file: {TOKEN_FILE}")
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    write_log(f"Listening on {BIND_HOST}:{PORT} for app dir {APP_DIR}")
    server = ThreadingHTTPServer((BIND_HOST, PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
