#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import shutil
import subprocess
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

update_lock = threading.Lock()
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
        header_token = self.headers.get("X-Orchestrator-Update-Token", "").strip()
        return bool(token() and (bearer == token() or header_token == token()))

    def do_GET(self) -> None:
        if self.path != "/status":
            self.send_json(404, {"error": "Not found."})
            return
        if not self.authenticated():
            self.send_json(401, {"error": "Unauthorized."})
            return
        with state_lock:
            self.send_json(200, dict(state))

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
