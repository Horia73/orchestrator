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
import sys
import termios
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from pathlib import Path
from typing import Optional


APP_DIR = Path(os.environ.get("ORCHESTRATOR_UPDATE_APP_DIR", os.getcwd())).resolve()
BRANCH = os.environ.get("ORCHESTRATOR_UPDATE_BRANCH", "master")
BIND_HOST = os.environ.get("ORCHESTRATOR_UPDATE_BRIDGE_BIND", "127.0.0.1")
PORT = int(os.environ.get("ORCHESTRATOR_UPDATE_BRIDGE_PORT", "38733"))
TOKEN_FILE = Path(os.environ.get("ORCHESTRATOR_UPDATE_TOKEN_FILE", str(APP_DIR.parent / "update-bridge-token")))
APP_PORT = os.environ.get("ORCHESTRATOR_PORT", "3000")
SERVICE_NAME = os.environ.get("ORCHESTRATOR_UPDATE_SERVICE", "orchestrator")
AI_WORKER_SERVICE_NAME = os.environ.get("ORCHESTRATOR_AI_WORKER_SERVICE", "ai-worker")
AI_WORKER_HOST_PORT = int(os.environ.get("ORCHESTRATOR_AI_WORKER_HOST_PORT", "3101"))
AI_WORKER_GREEN_SERVICE_NAME = os.environ.get("ORCHESTRATOR_AI_WORKER_GREEN_SERVICE", "ai-worker-green")
AI_WORKER_GREEN_HOST_PORT = int(os.environ.get("ORCHESTRATOR_AI_WORKER_GREEN_HOST_PORT", "3102"))
AI_WORKER_HANDOFF_PROFILE = os.environ.get("ORCHESTRATOR_AI_WORKER_HANDOFF_PROFILE", "ai-handoff")
IMAGE_NAME = os.environ.get("ORCHESTRATOR_UPDATE_IMAGE", "orchestrator:local")
ROLLBACK_IMAGE_NAME = os.environ.get("ORCHESTRATOR_ROLLBACK_IMAGE", "orchestrator:rollback")
PRUNE_AFTER_UPDATE = os.environ.get("ORCHESTRATOR_UPDATE_PRUNE_AFTER_BUILD", "1") != "0"
# CLIs live in the bind-mounted /home/node volume, so neither the image build
# nor their own headless (`-p`) runs ever update them. These let the Updates
# page refresh them in place inside that volume.
CLI_UPDATE_PACKAGES = [
    pkg.strip()
    for pkg in os.environ.get(
        "ORCHESTRATOR_CLI_UPDATE_PACKAGES",
        "@anthropic-ai/claude-code@latest,@openai/codex@0.144.4",
    ).split(",")
    if pkg.strip()
]
CLI_VERSION_PROBE = (
    "/home/node/.npm-global/bin/claude --version 2>/dev/null; "
    "/home/node/.npm-global/bin/codex --version 2>/dev/null"
)
LOG_DIR = Path(os.environ.get("ORCHESTRATOR_UPDATE_LOG_DIR", str(APP_DIR.parent / "logs")))
LOG_PATH = LOG_DIR / "docker-update-bridge.log"
ROLLBACK_STATE_PATH = Path(
    os.environ.get("ORCHESTRATOR_ROLLBACK_STATE_FILE", str(LOG_DIR.parent / "rollback-state.json"))
)
CLAUDE_USAGE_TIMEOUT_SECONDS = float(os.environ.get("ORCHESTRATOR_CLAUDE_USAGE_TIMEOUT_SECONDS", "30"))
CLAUDE_API_BILLING_USAGE_ERROR = (
    "The host claude is running on API-key billing (its /usage panel shows no plan "
    "quota windows), so the host fallback has no subscription gauge to read."
)
CLAUDE_LOGGED_OUT_USAGE_ERROR = (
    "The host claude is logged out (its OAuth credentials are empty). The app reads "
    "usage from its own CLI login first, so this fallback only matters when that "
    "login is unavailable — run `claude` on the host and use /login to restore it."
)
CLAUDE_USAGE_CWD = Path(
    os.environ.get("ORCHESTRATOR_CLAUDE_USAGE_CWD", str(Path.home() / ".orchestrator" / "claude-usage-cwd"))
).expanduser().resolve()
CLAUDE_USAGE_AUTO_TRUST = os.environ.get("ORCHESTRATOR_CLAUDE_USAGE_AUTO_TRUST", "1") != "0"
LOG_STREAM_CATCHUP_BYTES = int(os.environ.get("ORCHESTRATOR_UPDATE_LOG_CATCHUP_BYTES", str(32 * 1024)))
LOG_STREAM_MAX_DURATION_S = float(os.environ.get("ORCHESTRATOR_UPDATE_LOG_MAX_DURATION_S", "3600"))
LOG_STREAM_HEARTBEAT_S = float(os.environ.get("ORCHESTRATOR_UPDATE_LOG_HEARTBEAT_S", "15"))
LOG_STREAM_POLL_S = float(os.environ.get("ORCHESTRATOR_UPDATE_LOG_POLL_S", "0.4"))

# Match ANSI CSI (colors, cursor moves) and OSC sequences emitted by docker
# compose so the streamed log stays as plain text in the browser.
ANSI_ESCAPE_RE = re.compile(rb"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")

update_lock = threading.Lock()
claude_usage_lock = threading.Lock()
state_lock = threading.Lock()
state = {
    "phase": "idle",
    "updatedAt": None,
    "jobId": None,
    "targetTag": None,
    "error": None,
    "rollback": None,
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


def capture_optional(command: list[str], cwd: Optional[Path] = None) -> str:
    try:
        result = subprocess.run(
            command,
            cwd=cwd or APP_DIR,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=10,
        )
        return result.stdout.strip()
    except Exception:
        return ""


def docker_command() -> str:
    docker = shutil.which("docker")
    if not docker:
        raise RuntimeError("Docker is not available.")
    return docker


def docker_image_id(image: str) -> str:
    try:
        return capture_optional([docker_command(), "image", "inspect", image, "--format", "{{.Id}}"])
    except Exception:
        return ""


def image_supports_durable_ai_worker(image: str) -> bool:
    value = capture_optional([
        docker_command(), "image", "inspect", image,
        "--format", '{{index .Config.Labels "io.orchestrator.durable-ai-worker"}}',
    ])
    return value.strip() == "1"


def image_supports_ai_worker_handoff(image: str) -> bool:
    value = capture_optional([
        docker_command(), "image", "inspect", image,
        "--format", '{{index .Config.Labels "io.orchestrator.ai-worker-handoff"}}',
    ])
    try:
        return int(value.strip() or "0") >= 2
    except ValueError:
        return False


def running_service_supports_ai_worker_handoff() -> bool:
    container_id = capture_optional([*compose_command(), "ps", "-q", SERVICE_NAME])
    if not container_id:
        return False
    value = capture_optional([
        docker_command(), "inspect", container_id,
        "--format", '{{index .Config.Labels "io.orchestrator.ai-worker-handoff"}}',
    ])
    try:
        return int(value.strip() or "0") >= 2
    except ValueError:
        return False


def running_service_metadata() -> dict:
    """Read rollback provenance from the container actually serving traffic.

    The host checkout may already point at the target release during a manual
    deploy, so git/package.json on disk cannot describe the image we are about
    to preserve. `.build-info.json` is baked into that image specifically to be
    immune to stale runtime env overrides; read it together with the package
    version from the live container and fall back only on malformed/legacy
    images.
    """
    container_id = capture_optional([
        *compose_command(), "ps", "-q", SERVICE_NAME,
    ])
    if not container_id:
        return {}
    script = (
        "const fs=require('fs');"
        "let build={};let version=null;"
        "try{build=JSON.parse(fs.readFileSync('/app/.build-info.json','utf8'))}catch{};"
        "try{version=JSON.parse(fs.readFileSync('/app/package.json','utf8')).version||null}catch{};"
        "process.stdout.write(JSON.stringify({version,commit:build.commit||null,ref:build.ref||null}))"
    )
    raw = capture_optional([
        docker_command(), "exec", container_id, "node", "-e", script,
    ])
    try:
        parsed = json.loads(raw)
    except Exception:
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {
        key: value.strip()
        for key, value in parsed.items()
        if key in {"version", "commit", "ref"} and isinstance(value, str) and value.strip()
    }


def read_package_version() -> Optional[str]:
    try:
        parsed = json.loads((APP_DIR / "package.json").read_text(encoding="utf-8"))
        version = parsed.get("version")
        return version if isinstance(version, str) and version else None
    except Exception:
        return None


def current_git_ref() -> Optional[str]:
    branch = capture_optional(["git", "-C", str(APP_DIR), "branch", "--show-current"])
    if branch:
        return branch
    tag = capture_optional(["git", "-C", str(APP_DIR), "describe", "--tags", "--exact-match"])
    return tag or None


def read_rollback_state() -> Optional[dict]:
    try:
        parsed = json.loads(ROLLBACK_STATE_PATH.read_text(encoding="utf-8"))
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def write_rollback_state(payload: dict) -> None:
    ROLLBACK_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = ROLLBACK_STATE_PATH.with_suffix(ROLLBACK_STATE_PATH.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    tmp.replace(ROLLBACK_STATE_PATH)


def rollback_status() -> Optional[dict]:
    saved = read_rollback_state()
    image_id = docker_image_id(ROLLBACK_IMAGE_NAME)
    if not saved and not image_id:
        return None
    payload = dict(saved or {})
    payload["image"] = ROLLBACK_IMAGE_NAME
    payload["available"] = bool(image_id)
    payload["imageId"] = image_id or None
    if not image_id:
        payload["unavailableReason"] = f"Rollback image {ROLLBACK_IMAGE_NAME} is missing."
    return payload


def save_current_image_for_rollback(job_id: str, target_ref: str) -> None:
    source_image_id = docker_image_id(IMAGE_NAME)
    if not source_image_id:
        write_log(f"Rollback slot not updated: current image {IMAGE_NAME} does not exist.")
        return

    running = running_service_metadata()
    commit = running.get("commit") or capture_optional([
        "git", "-C", str(APP_DIR), "rev-parse", "--short=12", "HEAD",
    ]) or None
    ref = running.get("ref") or current_git_ref()
    version = running.get("version") or read_package_version()
    run([docker_command(), "tag", IMAGE_NAME, ROLLBACK_IMAGE_NAME])
    rollback_image_id = docker_image_id(ROLLBACK_IMAGE_NAME)
    saved_at = int(time.time() * 1000)
    payload = {
        "available": bool(rollback_image_id),
        "image": ROLLBACK_IMAGE_NAME,
        "sourceImage": IMAGE_NAME,
        "imageId": rollback_image_id or source_image_id,
        "sourceImageId": source_image_id,
        "version": version,
        "commit": commit,
        "ref": ref,
        "savedAt": saved_at,
        "savedFromJobId": job_id,
        "savedBeforeTarget": target_ref,
    }
    write_rollback_state(payload)
    set_state(rollback=rollback_status())
    write_log(
        "Saved rollback image "
        f"{ROLLBACK_IMAGE_NAME} from {IMAGE_NAME}"
        f"{f' version={version}' if version else ''}"
        f"{f' commit={commit}' if commit else ''}."
    )


def prune_docker_build_artifacts(stage: str) -> None:
    if not PRUNE_AFTER_UPDATE:
        write_log(
            f"Skipping Docker prune {stage}; "
            "ORCHESTRATOR_UPDATE_PRUNE_AFTER_BUILD=0."
        )
        return

    docker = docker_command()
    write_log(
        f"Pruning Docker build artifacts {stage}; "
        f"preserving tagged images such as {ROLLBACK_IMAGE_NAME}."
    )
    commands = [
        [docker, "image", "prune", "-f"],
        [docker, "builder", "prune", "-a", "-f"],
    ]
    for command in commands:
        code, _ = run_capture(command)
        if code != 0:
            write_log(
                "Best-effort Docker prune command failed "
                f"with exit code {code}: {' '.join(command)}"
            )


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


def is_claude_api_usage_billing(value: str) -> bool:
    norm = re.sub(r"\s+", " ", value).lower()
    return (
        "usage stats" in norm
        and "total cost" in norm
        and "usage:" in norm
        and not has_claude_usage_quota(value)
    )


def claude_header_shows_api_billing(value: str) -> bool:
    # The welcome banner prints the billing mode next to the model name
    # ("Opus 4.8 · API Usage Billing"). The TUI's absolute positioning sometimes
    # swallows the spaces after ANSI stripping, hence \s*.
    return re.search(r"API\s*Usage\s*Billing", value, re.IGNORECASE) is not None


def claude_login_state() -> str:
    """Best-effort read of the host claude OAuth state: 'ok', 'logged_out', or
    'unknown' (missing/unreadable file — do not block the scrape on it)."""
    creds_path = Path.home() / ".claude" / ".credentials.json"
    try:
        data = json.loads(creds_path.read_text(encoding="utf-8"))
    except Exception:
        return "unknown"
    oauth = data.get("claudeAiOauth")
    if not isinstance(oauth, dict):
        return "unknown"
    access = str(oauth.get("accessToken") or "").strip()
    refresh = str(oauth.get("refreshToken") or "").strip()
    if not access and not refresh:
        return "logged_out"
    return "ok"


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
        if claude_login_state() == "logged_out":
            return {"ok": False, "error": CLAUDE_LOGGED_OUT_USAGE_ERROR}
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

            # Since Claude 2.1.x, /usage opens a tabbed panel whose tab bar
            # ("… Usage Stats") and session-cost section render on subscription
            # accounts too — sometimes before the quota windows load. Only the
            # welcome-banner billing mode reliably marks an account that will
            # never show plan quotas; otherwise keep waiting until the timeout.
            if (
                phase == "wait-panel"
                and claude_header_shows_api_billing(cleaned)
                and is_claude_api_usage_billing(cleaned)
                and idle > 1.2
            ):
                return {"ok": False, "error": CLAUDE_API_BILLING_USAGE_ERROR}

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


WORKER_SLOTS = {
    "blue": {
        "id": "blue",
        "service": AI_WORKER_SERVICE_NAME,
        "url": f"http://{AI_WORKER_SERVICE_NAME}:3100",
        "hostPort": AI_WORKER_HOST_PORT,
    },
    "green": {
        "id": "green",
        "service": AI_WORKER_GREEN_SERVICE_NAME,
        "url": f"http://{AI_WORKER_GREEN_SERVICE_NAME}:3100",
        "hostPort": AI_WORKER_GREEN_HOST_PORT,
    },
}
_worker_registry_path_cache: Optional[Path] = None


def worker_slot(worker_id: str) -> dict:
    slot = WORKER_SLOTS.get(worker_id)
    if not slot:
        raise RuntimeError(f"Unknown AI worker generation: {worker_id}")
    return dict(slot)


def worker_compose_command(worker_id: str) -> list[str]:
    command = compose_command()
    if worker_id == "green":
        command += ["--profile", AI_WORKER_HANDOFF_PROFILE]
    return command


def worker_registry_path() -> Path:
    global _worker_registry_path_cache
    configured = os.environ.get("ORCHESTRATOR_AI_WORKER_REGISTRY_PATH", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    if _worker_registry_path_cache is not None:
        return _worker_registry_path_cache
    try:
        inspect = app_container_inspect()
        for mount in (inspect or {}).get("Mounts") or []:
            if mount.get("Destination") == "/app/.orchestrator" and mount.get("Source"):
                _worker_registry_path_cache = (
                    Path(str(mount["Source"])) / "ai-worker-generations.json"
                )
                return _worker_registry_path_cache
    except Exception:
        pass
    return TOKEN_FILE.parent / "ai-worker-generations.json"


def worker_target(worker_id: str, build_commit: Optional[str] = None) -> dict:
    target = worker_slot(worker_id)
    target["buildCommit"] = build_commit
    return target


def read_worker_registry() -> Optional[dict]:
    try:
        parsed = json.loads(worker_registry_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(parsed, dict):
        return None
    current = parsed.get("current")
    if not isinstance(current, dict) or current.get("id") not in WORKER_SLOTS:
        return None
    draining = parsed.get("draining")
    if not isinstance(draining, list):
        draining = []
    return {
        "protocolVersion": 1,
        "current": worker_target(str(current["id"]), current.get("buildCommit")),
        "draining": [
            worker_target(str(item.get("id")), item.get("buildCommit"))
            for item in draining
            if isinstance(item, dict)
            and item.get("id") in WORKER_SLOTS
            and item.get("id") != current.get("id")
        ],
        "backgroundOwner": parsed.get("backgroundOwner")
        if parsed.get("backgroundOwner") in WORKER_SLOTS else None,
        "updatedAt": int(parsed.get("updatedAt") or 0),
    }


def write_worker_registry(
    current_id: str,
    draining_ids: list[str],
    background_owner: Optional[str],
    commits: Optional[dict[str, Optional[str]]] = None,
) -> dict:
    commits = commits or {}
    current = worker_target(current_id, commits.get(current_id))
    draining = [
        worker_target(worker_id, commits.get(worker_id))
        for worker_id in draining_ids
        if worker_id in WORKER_SLOTS and worker_id != current_id
    ]
    payload = {
        "protocolVersion": 1,
        "current": current,
        "draining": draining,
        "backgroundOwner": background_owner if background_owner in WORKER_SLOTS else None,
        "updatedAt": int(time.time() * 1000),
    }
    path = worker_registry_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    return payload


def ensure_worker_registry() -> dict:
    existing = read_worker_registry()
    if existing:
        return existing
    blue_status = ai_worker_control_for("blue")
    commit = blue_status.get("buildCommit") if blue_status else None
    registry = write_worker_registry("blue", [], "blue", {"blue": commit})
    write_log("Initialized durable AI worker generation registry with blue current.")
    return registry


def ai_worker_container_exists_for(worker_id: str) -> bool:
    slot = worker_slot(worker_id)
    container_id = capture_optional([
        *worker_compose_command(worker_id), "ps", "-a", "-q", slot["service"],
    ])
    return bool(container_id.strip())


def ai_worker_container_running_for(worker_id: str) -> bool:
    slot = worker_slot(worker_id)
    container_id = capture_optional([
        *worker_compose_command(worker_id), "ps", "-q", slot["service"],
    ])
    return bool(container_id.strip())


def ai_worker_container_exists() -> bool:
    return ai_worker_container_exists_for("blue")


def ai_worker_control_for(
    worker_id: str,
    action: Optional[str] = None,
    timeout: float = 10,
) -> Optional[dict]:
    """Read or change the durable worker lifecycle through its loopback-only
    control route. None means the service/route is not available (including a
    pre-durable-worker installation); callers must never interpret that as an
    idle worker when a container is known to exist."""
    try:
        payload = json.dumps({"action": action}).encode("utf-8") if action else None
        slot = worker_slot(worker_id)
        req = urllib.request.Request(
            f"http://127.0.0.1:{slot['hostPort']}/api/internal/ai-worker/control",
            data=payload,
            method="POST" if action else "GET",
            headers={
                "Authorization": f"Bearer {token()}",
                "Content-Type": "application/json",
            },
        )
        raw = urllib.request.urlopen(req, timeout=timeout).read()
        parsed = json.loads(raw.decode("utf-8") or "{}")
        return parsed if isinstance(parsed, dict) else None
    except (OSError, ValueError, urllib.error.URLError, urllib.error.HTTPError):
        return None


def ai_worker_control(action: Optional[str] = None, timeout: float = 10) -> Optional[dict]:
    return ai_worker_control_for("blue", action, timeout)


def resume_ai_worker() -> None:
    result = ai_worker_control("resume")
    if result and result.get("ok"):
        write_log("Re-opened durable AI worker admission after update failure.")


def drain_ai_worker_before_update() -> bool:
    if not ai_worker_container_exists():
        return False
    result = ai_worker_control("drain")
    if not result or not result.get("ok"):
        # The POST may have reached the worker even if its response was lost.
        # Re-open admission best-effort before refusing the update so a
        # transient loopback failure cannot strand the worker in drain mode.
        ai_worker_control("resume")
        raise RuntimeError(
            "The durable AI worker exists but its drain control route is unavailable; "
            "refusing an update that could interrupt active AI work."
        )
    active = int(result.get("activeRunCount") or 0)
    write_log(f"Durable AI worker admission closed; {active} active run(s) may finish on the old image.")
    return True


def wait_for_ai_worker_control(timeout_seconds: float = 180) -> dict:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        result = ai_worker_control()
        if result and result.get("ok"):
            return result
        time.sleep(2)
    raise RuntimeError("Durable AI worker did not become healthy in time.")


def wait_for_ai_worker_control_for(worker_id: str, timeout_seconds: float = 180) -> dict:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        result = ai_worker_control_for(worker_id)
        if result and result.get("ok"):
            return result
        time.sleep(2)
    raise RuntimeError(f"Durable AI worker {worker_id} did not become healthy in time.")


def wait_for_ai_worker_idle_for(worker_id: str) -> None:
    last_reported: Optional[int] = None
    while True:
        result = ai_worker_control_for(worker_id)
        if result and result.get("ok"):
            active = int(result.get("activeRunCount") or 0)
            if active != last_reported:
                set_state(
                    phase="restarting",
                    waitReason=f"Waiting for {active} active AI run(s) on {worker_id}.",
                    activeRunCount=active,
                )
                write_log(f"Waiting for durable AI worker {worker_id}: {active} active run(s).")
                last_reported = active
            if active == 0:
                return
        elif not ai_worker_container_running_for(worker_id):
            return
        time.sleep(2)


def wait_for_ai_worker_web_requests_for(worker_id: str) -> None:
    last_reported: Optional[int] = None
    while True:
        result = ai_worker_control_for(worker_id)
        if result and result.get("ok"):
            app_runs = [
                run
                for run in (result.get("agentRuns") or [])
                if isinstance(run, dict) and run.get("kind") == "app"
            ]
            active = len(app_runs)
            if active != last_reported:
                set_state(
                    phase="restarting",
                    waitReason=f"Waiting for {active} response-bound app AI request(s) on {worker_id}.",
                    responseBoundRunCount=active,
                )
                write_log(f"Waiting before web rotation on {worker_id}: {active} response-bound app AI request(s).")
                last_reported = active
            if active == 0:
                return
        elif not ai_worker_container_exists_for(worker_id):
            return
        time.sleep(2)


def start_worker_slot(worker_id: str, compose_env: Optional[dict[str, str]] = None) -> dict:
    slot = worker_slot(worker_id)
    run([
        *worker_compose_command(worker_id), "up", "-d", "--no-deps",
        "--force-recreate", slot["service"],
    ], env=compose_env)
    status = wait_for_ai_worker_control_for(worker_id)
    if int(status.get("protocolVersion") or 0) < 2:
        raise RuntimeError(f"AI worker {worker_id} does not support generation handoff protocol v2.")
    if status.get("workerId") != worker_id:
        raise RuntimeError(
            f"AI worker slot mismatch: expected {worker_id}, got {status.get('workerId') or 'unknown'}."
        )
    return status


def stop_drained_worker_slot(worker_id: str) -> None:
    if worker_id == "blue":
        # Blue owns the stable :6080 VNC router even while green is current.
        result = ai_worker_control_for("blue", "standby", timeout=30)
        if not result or not result.get("ok"):
            raise RuntimeError("Blue AI worker did not enter router-only standby cleanly.")
        write_log("Blue AI worker drained and remains online as the stable VNC router.")
        return
    slot = worker_slot(worker_id)
    run([*worker_compose_command(worker_id), "stop", slot["service"]])
    write_log(f"Stopped drained AI worker generation {worker_id}.")


def wait_for_background_owner_ready(worker_id: str, timeout_seconds: float = 180) -> None:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        status = ai_worker_control_for(worker_id)
        if status and status.get("ok") and status.get("backgroundReady") is True:
            return
        time.sleep(1)
    raise RuntimeError(f"AI worker {worker_id} did not assume background leadership in time.")


def recover_incomplete_worker_handoff(phase: str = "restarting") -> bool:
    """Finish a cutover that survived a bridge/web/process interruption.

    Once the registry exposes a new current generation it is unsafe to point
    admission back at the old one: the new worker may already own accepted
    runs. Recovery therefore always moves forward, re-drains the retired slot,
    waits for it to become idle, then transfers background leadership.
    """
    registry = read_worker_registry()
    if not registry or not registry.get("draining"):
        return False

    current_id = str(registry["current"]["id"])
    current_status = ai_worker_control_for(current_id)
    if (
        not current_status
        or not current_status.get("ok")
        or int(current_status.get("protocolVersion") or 0) < 2
    ):
        raise RuntimeError(
            f"Cannot recover AI worker handoff: current generation {current_id} is unavailable."
        )

    commits = {
        current_id: current_status.get("buildCommit")
        or registry["current"].get("buildCommit")
    }
    draining_ids = [str(target["id"]) for target in registry["draining"]]
    write_log(
        f"Recovering interrupted AI worker handoff: current={current_id}, "
        f"draining={','.join(draining_ids)}."
    )
    set_state(
        phase=phase,
        waitReason="Finishing an interrupted AI worker generation handoff.",
    )

    for old_id in draining_ids:
        old_status = ai_worker_control_for(old_id)
        if old_status and old_status.get("ok"):
            commits[old_id] = old_status.get("buildCommit") or next(
                (
                    target.get("buildCommit")
                    for target in registry["draining"]
                    if target.get("id") == old_id
                ),
                None,
            )
            drained = ai_worker_control_for(old_id, "drain")
            if not drained or not drained.get("ok"):
                raise RuntimeError(
                    f"Cannot recover AI worker handoff: generation {old_id} could not be drained."
                )
        elif ai_worker_container_running_for(old_id):
            raise RuntimeError(
                f"Cannot recover AI worker handoff: draining generation {old_id} is running "
                "but its control route is unavailable."
            )

        wait_for_ai_worker_idle_for(old_id)
        if ai_worker_container_running_for(old_id):
            stop_drained_worker_slot(old_id)

    write_worker_registry(current_id, [], current_id, commits)
    wait_for_background_owner_ready(current_id)
    set_state(activeRunCount=0, responseBoundRunCount=0)
    write_log(
        f"Recovered AI worker handoff; {current_id} is now the sole generation and background owner."
    )
    return True


def wait_for_ai_worker_idle() -> None:
    last_reported: Optional[int] = None
    while True:
        result = ai_worker_control()
        if result and result.get("ok"):
            active = int(result.get("activeRunCount") or 0)
            if active != last_reported:
                set_state(
                    phase="restarting",
                    waitReason=f"Waiting for {active} active AI run(s).",
                    activeRunCount=active,
                )
                write_log(f"Waiting for durable AI worker: {active} active run(s).")
                last_reported = active
            if active == 0:
                return
        elif not ai_worker_container_exists():
            return
        time.sleep(2)


def wait_for_ai_worker_web_requests() -> None:
    """Let response-bound app AI calls finish before replacing the web proxy.

    Chat streams can reattach after a web deploy and detached inbox/scheduled
    runs persist their result independently. App AI calls currently return
    their result on the original HTTP response, so keep the web container alive
    for those calls after admission closes. They still execute in the durable
    worker and therefore remain protected if the web process fails unexpectedly.
    """
    last_reported: Optional[int] = None
    while True:
        result = ai_worker_control()
        if result and result.get("ok"):
            app_runs = [
                run
                for run in (result.get("agentRuns") or [])
                if isinstance(run, dict) and run.get("kind") == "app"
            ]
            active = len(app_runs)
            if active != last_reported:
                set_state(
                    phase="restarting",
                    waitReason=f"Waiting for {active} response-bound app AI request(s).",
                    responseBoundRunCount=active,
                )
                write_log(f"Waiting before web rotation: {active} response-bound app AI request(s).")
                last_reported = active
            if active == 0:
                return
        elif not ai_worker_container_exists():
            return
        time.sleep(2)


def refresh_ai_worker_after_update(worker_was_running: bool) -> None:
    """Move the worker to the freshly tagged image without interrupting work.

    Existing workers are drained only after the replacement image is built,
    immediately before web rotation: already-accepted runs continue, while new
    admissions wait. Once the active count reaches zero, compose recreates only
    the worker. A first-time install has no old worker and can start the service
    immediately.
    """
    if not worker_was_running:
        set_state(phase="restarting", waitReason="Starting durable AI worker.")
        run([*compose_command(), "up", "-d", "--no-deps", AI_WORKER_SERVICE_NAME])
        wait_for_ai_worker_control()
        write_log("Started durable AI worker on the current image.")
        return

    wait_for_ai_worker_idle()

    set_state(phase="restarting", waitReason="Rotating durable AI worker.", activeRunCount=0)
    run([
        *compose_command(), "up", "-d", "--no-deps", "--force-recreate",
        AI_WORKER_SERVICE_NAME,
    ])
    wait_for_ai_worker_control()
    write_log("Rotated durable AI worker onto the current image after all active runs drained.")


def perform_blue_green_handoff(
    target_commit: Optional[str],
    compose_env: Optional[dict[str, str]] = None,
) -> None:
    """Cut new admissions to the freshly-built slot while old accepted trees
    keep running on their pinned image. Background schedulers are deliberately
    paused between cutover and old-worker retirement; this avoids duplicate
    recovery/monitor execution against shared profile DBs."""
    registry = ensure_worker_registry()
    if registry.get("draining"):
        raise RuntimeError(
            "A previous AI worker handoff is still draining; finish or recover it before starting another update."
        )
    old_id = str(registry["current"]["id"])
    new_id = "green" if old_id == "blue" else "blue"
    old_commit = registry["current"].get("buildCommit")
    commits = {old_id: old_commit, new_id: target_commit}
    cutover = False

    set_state(
        phase="restarting",
        waitReason=f"Starting AI worker generation {new_id} on the new image.",
    )
    write_log(f"Starting standby AI worker generation {new_id} on the new image.")
    try:
        new_status = start_worker_slot(new_id, compose_env)
        running_commit = str(new_status.get("buildCommit") or "")
        if target_commit and running_commit and not running_commit.startswith(target_commit):
            raise RuntimeError(
                f"AI worker {new_id} booted commit {running_commit}, expected {target_commit}."
            )
        commits[new_id] = running_commit or target_commit

        # A fresh standby has an open in-process admission gate, but the web
        # registry still points at old. Close it explicitly until the atomic
        # switch so no direct/internal caller can start work early.
        standby = ai_worker_control_for(new_id, "drain")
        if not standby or not standby.get("ok"):
            raise RuntimeError(f"Could not hold AI worker {new_id} in standby before cutover.")

        drained = ai_worker_control_for(old_id, "drain")
        if not drained or not drained.get("ok"):
            raise RuntimeError(f"Could not close admission on AI worker {old_id}.")
        active = int(drained.get("activeRunCount") or 0)
        write_log(
            f"AI worker {old_id} admission closed with {active} active run(s); "
            f"new work will move to {new_id}."
        )
        wait_for_ai_worker_web_requests_for(old_id)

        resumed = ai_worker_control_for(new_id, "resume")
        if not resumed or not resumed.get("ok"):
            raise RuntimeError(f"Could not open admission on AI worker {new_id}.")

        write_worker_registry(new_id, [old_id], None, commits)
        cutover = True
        set_state(
            phase="restarting",
            waitReason=(
                f"New AI work is live on {new_id}; waiting for {active} old run(s) on {old_id}."
            ),
            activeRunCount=active,
        )
        write_log(
            f"Atomic AI cutover complete: current={new_id}, draining={old_id}; "
            "background schedulers paused until the old generation retires."
        )

        # The existing web already understands the shared registry, so new AI
        # admission is available before this short request-proxy recreation.
        run([
            *compose_command(), "up", "-d", "--no-build", "--no-deps",
            "--force-recreate", SERVICE_NAME,
        ], env=compose_env)

        wait_for_ai_worker_idle_for(old_id)
        stop_drained_worker_slot(old_id)
        write_worker_registry(new_id, [], new_id, commits)
        wait_for_background_owner_ready(new_id)
        set_state(activeRunCount=0, responseBoundRunCount=0)
        write_log(
            f"Promoted AI worker {new_id} to sole generation and transferred background leadership."
        )
    except Exception:
        if not cutover:
            ai_worker_control_for(old_id, "resume")
            ai_worker_control_for(new_id, "standby")
            if new_id == "green":
                try:
                    slot = worker_slot("green")
                    run([*worker_compose_command("green"), "stop", slot["service"]])
                except Exception:
                    pass
            write_worker_registry(old_id, [], old_id, commits)
        else:
            # Never roll the registry backward after the new generation was
            # exposed: it may already own accepted runs. Leave an explicit,
            # recoverable fleet state instead of interrupting either side.
            write_log(
                f"AI cutover to {new_id} succeeded but retirement of {old_id} did not finish; "
                "leaving both generations registered for safe recovery."
            )
        raise


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


def safe_tag(value: object) -> str:
    tag = str(value or "").strip()
    if not tag:
        return ""
    allowed = all(ch.isalnum() or ch in "._/-+" for ch in tag)
    if (
        tag.startswith(("/", "-"))
        or tag.endswith("/")
        or ".." in tag
        or "@{" in tag
        or not allowed
    ):
        raise RuntimeError(f"Invalid update tag: {tag or '(empty)'}")
    return tag


def update_stack(payload: dict) -> None:
    job_id = str(payload.get("jobId") or f"manual-{int(time.time())}")
    skip_git = bool(payload.get("skipGit"))
    target_tag = safe_tag(payload.get("targetTag"))
    branch = safe_branch(payload.get("targetBranch"))
    target_ref = target_tag or branch
    set_state(phase="updating", jobId=job_id, targetTag=target_ref, error=None)
    write_log(f"Starting Docker update job={job_id} target={target_ref}")

    worker_was_running = False
    current_supports_handoff = running_service_supports_ai_worker_handoff()
    try:
        if not (APP_DIR / ".git").exists():
            raise RuntimeError(f"{APP_DIR} is not a git checkout.")

        if current_supports_handoff:
            recover_incomplete_worker_handoff("updating")

        save_current_image_for_rollback(job_id, target_ref)
        prune_docker_build_artifacts("before rebuild")

        if not skip_git:
            if target_tag:
                run(["git", "-C", str(APP_DIR), "fetch", "origin", "tag", target_tag, "--tags"])
                run(["git", "-C", str(APP_DIR), "checkout", "--detach", target_tag])
            else:
                run(["git", "-C", str(APP_DIR), "fetch", "origin", branch, "--tags"])
                run(["git", "-C", str(APP_DIR), "checkout", branch])
                run(["git", "-C", str(APP_DIR), "pull", "--ff-only", "origin", branch])
        else:
            target_ref = current_git_ref() or target_ref
            write_log(f"Deploying current checkout without changing git state ({target_ref}).")
        target_commit = capture(["git", "-C", str(APP_DIR), "rev-parse", "--short=12", "HEAD"])
        notify_app(
            job_id,
            "restarting",
            "Host updater is rebuilding the image; AI remains available through generation handoff.",
            target_commit=target_commit,
        )
        compose_env = os.environ.copy()
        compose_env["ORCHESTRATOR_BUILD_COMMIT"] = target_commit
        compose_env["ORCHESTRATOR_BUILD_REF"] = target_ref
        # Strip any historical BUILD_COMMIT / BUILD_REF lines from `.env`
        # before invoking compose. `env_file` is loaded into container
        # runtime AFTER the image's baked ENV, so a stale line there silently
        # overrides the freshly built `/app/.build-info.json` and the image
        # ENV. Old installs sometimes ended up with these in `.env`; scrub
        # them defensively every update.
        scrub_stale_build_env(APP_DIR / ".env")
        # Build first while the durable worker remains fully open on its old,
        # immutable image digest. Splitting `build` from `up` is essential: it
        # keeps the long fetch/build phase available to AI and gives us an
        # atomic admission boundary immediately before container rotation.
        run([
            *compose_command(), "build", SERVICE_NAME,
        ], env=compose_env)

        if current_supports_handoff and image_supports_ai_worker_handoff(IMAGE_NAME):
            write_log("Docker image build complete; starting blue/green AI worker handoff.")
            perform_blue_green_handoff(target_commit, compose_env)
        else:
            # One compatibility rotation is required when upgrading from the
            # original single-worker image. The canonical blue service and VNC
            # binding remain backward-compatible, so even an already-running
            # old bridge can perform this migration safely. Every later update
            # takes the zero-admission-downtime path above.
            set_state(
                phase="restarting",
                waitReason="Closing new AI admissions for compatibility rotation.",
            )
            write_log("Docker image build complete; entering compatibility AI drain and container rotation.")
            worker_was_running = drain_ai_worker_before_update()
            if worker_was_running:
                wait_for_ai_worker_web_requests()
            run([
                *compose_command(), "up", "-d", "--no-build", "--no-deps",
                "--force-recreate", SERVICE_NAME,
            ], env=compose_env)
            refresh_ai_worker_after_update(worker_was_running)
            if image_supports_ai_worker_handoff(IMAGE_NAME):
                blue_status = wait_for_ai_worker_control_for("blue")
                write_worker_registry(
                    "blue", [], "blue", {"blue": blue_status.get("buildCommit") or target_commit}
                )
        prune_docker_build_artifacts("after rebuild")
        notify_app(
            job_id,
            "completed",
            "Host updater finished rebuilding the Docker stack.",
            target_commit=target_commit,
        )
        set_state(
            phase="completed",
            error=None,
            waitReason=None,
            activeRunCount=0,
            responseBoundRunCount=0,
        )
        write_log(f"Completed Docker update job={job_id}")
    except Exception as exc:
        if worker_was_running:
            resume_ai_worker()
        message = str(exc)
        set_state(phase="failed", error=message)
        write_log(f"Docker update failed job={job_id}: {message}")
        notify_app(job_id, "failed", "Docker host update failed.", message)
    finally:
        if update_lock.locked():
            update_lock.release()


_STALE_BUILD_ENV_KEYS = ("ORCHESTRATOR_BUILD_COMMIT", "ORCHESTRATOR_BUILD_REF")


def scrub_stale_build_env(env_path: Path) -> None:
    """Remove `ORCHESTRATOR_BUILD_COMMIT` / `ORCHESTRATOR_BUILD_REF` lines
    from a docker-compose `.env` file.

    Build provenance must come from the image (its baked ENV + the
    `/app/.build-info.json` file written from build args). When these keys
    end up in `.env` via legacy installs, docker-compose's `env_file`
    loads them into the container's runtime environment, overriding the
    fresh value baked into the image and producing false-positive
    "running commit does not match target" notices after every update.
    Best-effort: missing files and read/write failures are tolerated.
    """
    try:
        if not env_path.exists():
            return
        original_lines = env_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return

    kept: list[str] = []
    removed_any = False
    for line in original_lines:
        stripped = line.lstrip()
        if any(stripped.startswith(f"{key}=") for key in _STALE_BUILD_ENV_KEYS):
            removed_any = True
            continue
        kept.append(line)

    if not removed_any:
        return

    new_text = "\n".join(kept)
    if original_lines and original_lines[-1] != "" and not new_text.endswith("\n"):
        new_text += "\n"
    try:
        env_path.write_text(new_text, encoding="utf-8")
        write_log(f"Scrubbed stale build provenance lines from {env_path}")
    except OSError as exc:
        write_log(f"Could not scrub stale build provenance from {env_path}: {exc}")


def stream_update_log(handler: "Handler") -> None:
    """Stream `docker-update-bridge.log` as SSE.

    Behavior:
    - Sends the last `LOG_STREAM_CATCHUP_BYTES` of the log file as catch-up
      events on first connect. On reconnect (when the client sends a numeric
      `Last-Event-ID` header), resumes from that byte offset instead.
    - Tails the file for new content, emitting one SSE `log` event per line.
      Each event carries the post-line byte offset as its `id` so the client
      can resume cleanly.
    - Emits SSE comments (`: heartbeat`) every `LOG_STREAM_HEARTBEAT_S`
      seconds so proxies and the browser keep the connection open.
    - Caps stream duration at `LOG_STREAM_MAX_DURATION_S` to avoid leaked
      threads if a client never disconnects.
    - Strips ANSI escape codes (docker compose colors) for plain-text output.
    """
    out = handler.wfile

    try:
        handler.send_response(200)
        handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
        handler.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        handler.send_header("Connection", "keep-alive")
        # Tell nginx/cloudflare-style proxies not to buffer the response.
        handler.send_header("X-Accel-Buffering", "no")
        handler.end_headers()
    except (BrokenPipeError, ConnectionResetError, OSError):
        return

    def write_raw(payload: bytes) -> bool:
        try:
            out.write(payload)
            out.flush()
            return True
        except (BrokenPipeError, ConnectionResetError, OSError):
            return False

    def emit(event_name: Optional[str], data: str, event_id: Optional[int] = None) -> bool:
        payload = b""
        if event_id is not None:
            payload += f"id: {event_id}\n".encode("utf-8")
        if event_name and event_name != "message":
            payload += f"event: {event_name}\n".encode("utf-8")
        # SSE requires every \n in data to be prefixed by `data:`.
        # An empty data field still needs one `data:` line per the spec.
        for piece in (data.split("\n") if data else [""]):
            payload += b"data: " + piece.encode("utf-8") + b"\n"
        payload += b"\n"
        return write_raw(payload)

    def emit_log_line(raw_bytes: bytes, event_id: int) -> bool:
        cleaned = ANSI_ESCAPE_RE.sub(b"", raw_bytes).decode("utf-8", errors="replace")
        # Strip trailing \r left over from CRLF lines.
        cleaned = cleaned.rstrip("\r")
        return emit("log", cleaned, event_id)

    # Determine starting offset: prefer Last-Event-ID, fall back to catch-up tail.
    resume_header = handler.headers.get("Last-Event-ID", "").strip()
    resume_offset: Optional[int] = None
    if resume_header.isdigit():
        try:
            resume_offset = int(resume_header)
        except ValueError:
            resume_offset = None

    try:
        file_size = LOG_PATH.stat().st_size if LOG_PATH.exists() else 0
    except OSError:
        file_size = 0

    if resume_offset is not None and 0 <= resume_offset <= file_size:
        offset = resume_offset
    else:
        offset = max(0, file_size - LOG_STREAM_CATCHUP_BYTES)
        # When seeking into the middle of a file we skip the first partial line.
        if offset > 0:
            try:
                with LOG_PATH.open("rb") as fh:
                    fh.seek(offset)
                    discard = fh.readline()
                    offset += len(discard)
            except OSError:
                offset = 0

    if not emit("ready", str(offset), offset):
        return

    pending = b""
    start_time = time.time()
    last_heartbeat = start_time

    while time.time() - start_time < LOG_STREAM_MAX_DURATION_S:
        try:
            current_size = LOG_PATH.stat().st_size if LOG_PATH.exists() else 0
        except OSError:
            current_size = 0

        if current_size < offset:
            # Log was truncated/rotated under us — restart from the new top.
            offset = 0
            pending = b""

        if current_size > offset:
            try:
                with LOG_PATH.open("rb") as fh:
                    fh.seek(offset)
                    chunk = fh.read(current_size - offset)
            except OSError:
                chunk = b""
            offset += len(chunk)
            pending += chunk
            while b"\n" in pending:
                line, _, pending = pending.partition(b"\n")
                # event id = byte offset of the newline that ended this line + 1
                line_end_offset = offset - len(pending)
                if not emit_log_line(line, line_end_offset):
                    return

        now = time.time()
        if now - last_heartbeat > LOG_STREAM_HEARTBEAT_S:
            if not write_raw(b": heartbeat\n\n"):
                return
            last_heartbeat = now

        time.sleep(LOG_STREAM_POLL_S)


def run_capture(
    command: list[str],
    timeout: Optional[float] = None,
    env: Optional[dict[str, str]] = None,
) -> tuple[int, str]:
    """Run a command, mirror its combined output into the bridge log, and
    return (exit_code, output). Unlike `run`, this never raises on a non-zero
    exit — the caller decides how to report it."""
    write_log("$ " + " ".join(command))
    try:
        result = subprocess.run(
            command,
            cwd=APP_DIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=timeout,
            env=env,
        )
    except subprocess.TimeoutExpired:
        write_log(f"Command timed out after {timeout}s: {' '.join(command)}")
        return 124, f"Command timed out after {timeout}s."
    output = result.stdout or ""
    if output:
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(output if output.endswith("\n") else output + "\n")
    return result.returncode, output


def detect_remote_access() -> dict:
    """Read-only probe of the host's connectivity options for the Remote Access
    UI. Never raises; missing tailscale just reports installed=False."""
    ts = {
        "installed": bool(shutil.which("tailscale")),
        "running": False,
        "loggedIn": False,
        "dnsName": None,
        "webhookFunnelEnabled": False,
        "funnelUrl": None,
        "appFunnelEnabled": False,
        "appFunnelUrl": None,
        "publishedAppFunnels": [],
    }
    status_raw = capture_optional(["tailscale", "status", "--json"])
    if status_raw:
        ts["installed"] = True
        try:
            data = json.loads(status_raw)
            backend = data.get("BackendState")
            ts["running"] = backend == "Running"
            ts["loggedIn"] = backend not in (None, "", "NeedsLogin", "NoState", "Stopped")
            self_node = data.get("Self") or {}
            dns_name = (self_node.get("DNSName") or "").rstrip(".")
            ts["dnsName"] = dns_name or None
        except Exception:
            pass
    serve_blob = (
        capture_optional(["tailscale", "serve", "status"])
        + "\n"
        + capture_optional(["tailscale", "funnel", "status"])
    )
    if "/api/webhooks" in serve_blob:
        ts["webhookFunnelEnabled"] = True
        if ts["dnsName"]:
            ts["funnelUrl"] = f"https://{ts['dnsName']}/api/webhooks"
    root_proxy_re = re.compile(
        r"(?m)(?:^|\s)(?:\|--\s*)?/\s+(?:proxy\s+)?https?://127[.]0[.]0[.]1:"
        + re.escape(str(APP_PORT))
        + r"(?:[/\s]|$)"
    )
    if root_proxy_re.search(serve_blob):
        ts["appFunnelEnabled"] = True
        if ts["dnsName"]:
            ts["appFunnelUrl"] = f"https://{ts['dnsName']}/"
    published_slugs = sorted(set(re.findall(r"/published-apps/([a-z0-9][a-z0-9-]{0,79})(?=[/\s]|$)", serve_blob)))
    if ts["dnsName"]:
        ts["publishedAppFunnels"] = [
            {
                "slug": slug,
                "path": f"/published-apps/{slug}",
                "url": f"https://{ts['dnsName']}/published-apps/{slug}/",
            }
            for slug in published_slugs
        ]
    else:
        ts["publishedAppFunnels"] = [
            {"slug": slug, "path": f"/published-apps/{slug}", "url": None}
            for slug in published_slugs
        ]
    return {"ok": True, "tailscale": ts}


def set_webhook_funnel(enable: bool) -> dict:
    """Toggle a public Tailscale Funnel scoped to ONLY /api/webhooks, pointed at
    the app's loopback port. The UI/whole app is never exposed by this."""
    target = f"http://127.0.0.1:{APP_PORT}/api/webhooks"
    if enable:
        code, out = run_capture(
            ["tailscale", "funnel", "--bg", "--set-path", "/api/webhooks", target],
            timeout=45,
        )
    else:
        code, out = run_capture(
            ["tailscale", "funnel", "--set-path", "/api/webhooks", "off"],
            timeout=45,
        )
    detected = detect_remote_access()
    return {
        "ok": code == 0,
        "exitCode": code,
        "output": (out or "").strip()[-1500:],
        "tailscale": detected.get("tailscale"),
    }


def set_app_funnel(enable: bool) -> dict:
    """Toggle a public Tailscale Funnel for the full Orchestrator UI.

    This intentionally differs from the scoped webhook/published-app funnels:
    the root mount exposes the whole app on the public internet, protected by
    Orchestrator's own profile/session controls.
    """
    target = f"http://127.0.0.1:{APP_PORT}"
    if enable:
        code, out = run_capture(
            ["tailscale", "funnel", "--bg", target],
            timeout=45,
        )
    else:
        code, out = run_capture(
            ["tailscale", "funnel", "--set-path", "/", "off"],
            timeout=45,
        )
    detected = detect_remote_access()
    ts = detected.get("tailscale") or {}
    app_url = ts.get("appFunnelUrl")
    if enable and not app_url and ts.get("dnsName"):
        app_url = f"https://{ts['dnsName']}/"
    return {
        "ok": code == 0 and (not enable or bool(app_url)),
        "exitCode": code,
        "output": (out or "").strip()[-1500:],
        "funnelUrl": app_url,
        "tailscale": ts,
    }


def set_published_app_funnel(slug: str, enable: bool) -> dict:
    """Toggle a public Tailscale Funnel scoped to one published static app.

    The funnel path is /published-apps/<slug> and points back to the same path
    on the app's loopback port, so the rest of Orchestrator is not exposed.
    """
    clean_slug = (slug or "").strip().lower()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", clean_slug):
        return {"ok": False, "error": "Invalid published app slug.", "funnelUrl": None}
    funnel_path = f"/published-apps/{clean_slug}"
    target = f"http://127.0.0.1:{APP_PORT}{funnel_path}"
    if enable:
        code, out = run_capture(
            ["tailscale", "funnel", "--bg", "--set-path", funnel_path, target],
            timeout=45,
        )
    else:
        code, out = run_capture(
            ["tailscale", "funnel", "--set-path", funnel_path, "off"],
            timeout=45,
        )
    detected = detect_remote_access()
    ts = detected.get("tailscale") or {}
    funnel_url = None
    for item in ts.get("publishedAppFunnels") or []:
        if item.get("slug") == clean_slug:
            funnel_url = item.get("url")
            break
    if enable and not funnel_url and ts.get("dnsName"):
        funnel_url = f"https://{ts['dnsName']}{funnel_path}/"
    return {
        "ok": code == 0 and (not enable or bool(funnel_url)),
        "exitCode": code,
        "output": (out or "").strip()[-1500:],
        "slug": clean_slug,
        "path": funnel_path,
        "funnelUrl": funnel_url,
        "tailscale": ts,
    }


def install_tailscale() -> dict:
    """Best-effort install of Tailscale via the official script. Needs root, so
    it may fail on hosts without passwordless sudo — the caller falls back to
    showing the manual command. After install the user still runs `tailscale up`
    to authenticate the node (interactive browser login)."""
    code, out = run_capture(
        ["sh", "-c", "curl -fsSL https://tailscale.com/install.sh | sh"],
        timeout=240,
    )
    detected = detect_remote_access()
    installed = bool(detected.get("tailscale", {}).get("installed"))
    return {
        "ok": code == 0 and installed,
        "exitCode": code,
        "output": (out or "").strip()[-2000:],
        "tailscale": detected.get("tailscale"),
    }


def setup_https_duckdns(domain: str, token: str, email: str) -> dict:
    """Provision public HTTPS (DuckDNS + Let's Encrypt + nginx) by invoking the
    installer's focused `setup-https` entrypoint with the supplied inputs. Needs
    root, so on hosts without passwordless sudo it fails and the caller falls
    back to showing the manual command. Best-effort; never raises."""
    script = APP_DIR / "scripts" / "install.sh"
    if not script.exists():
        return {"ok": False, "error": "install.sh not found in the app directory.", "publicUrl": None}
    child_env = dict(os.environ)
    child_env.update(
        {
            "ORCHESTRATOR_APP_DIR": str(APP_DIR),
            "ORCHESTRATOR_HOME": str(TOKEN_FILE.parent),
            "ORCHESTRATOR_PORT": str(APP_PORT),
            "ORCHESTRATOR_PUBLIC_HTTPS_SETUP": "duckdns",
            "ORCHESTRATOR_DUCKDNS_DOMAIN": domain,
            "ORCHESTRATOR_DUCKDNS_TOKEN": token,
            "ORCHESTRATOR_LETSENCRYPT_EMAIL": email or "",
        }
    )
    code, out = run_capture(["bash", str(script), "setup-https"], timeout=300, env=child_env)
    public_url = None
    for line in (out or "").splitlines():
        s = line.strip()
        if s.startswith("ORCHESTRATOR_PUBLIC_URL="):
            public_url = s.split("=", 1)[1].strip()
    return {
        "ok": code == 0 and bool(public_url),
        "exitCode": code,
        "output": (out or "").strip()[-2500:],
        "publicUrl": public_url,
    }


def restart_container_async(delay: float = 0.4) -> None:
    """Restart the orchestrator container shortly after the HTTP response is
    flushed. Done in a background thread because the restart tears down the
    very app process that proxied this request — we want the caller to receive
    its response first."""
    def _do() -> None:
        time.sleep(delay)
        worker_was_running = False
        worker_to_resume = "blue"
        web_was_stopped = False
        try:
            if running_service_supports_ai_worker_handoff():
                recover_incomplete_worker_handoff()
                registry = ensure_worker_registry()
                worker_to_resume = str(registry["current"]["id"])
                drained = ai_worker_control_for(worker_to_resume, "drain")
                if not drained or not drained.get("ok"):
                    raise RuntimeError(
                        f"Could not close admission on AI worker {worker_to_resume} for restart."
                    )
                worker_was_running = True
                wait_for_ai_worker_idle_for(worker_to_resume)

                # A staged restore requires every process that may hold a DB
                # handle to be down at the same time. With no accepted work
                # left, canonicalize the restarted fleet back to blue; this
                # also guarantees that the stable VNC router is online.
                run([*compose_command(), "stop", SERVICE_NAME])
                web_was_stopped = True
                for worker_id in ("green", "blue"):
                    if ai_worker_container_exists_for(worker_id):
                        slot = worker_slot(worker_id)
                        run([*worker_compose_command(worker_id), "stop", slot["service"]])
                previous_commit = registry["current"].get("buildCommit")
                write_worker_registry("blue", [], "blue", {"blue": previous_commit})
                blue_status = start_worker_slot("blue")
                write_worker_registry(
                    "blue", [], "blue", {"blue": blue_status.get("buildCommit") or previous_commit}
                )
                wait_for_background_owner_ready("blue")
                run([*compose_command(), "up", "-d", "--no-deps", SERVICE_NAME])
                web_was_stopped = False
                write_log(
                    f"Coordinated generation-aware restart completed for '{AI_WORKER_SERVICE_NAME}' "
                    f"and '{SERVICE_NAME}'."
                )
                return

            worker_was_running = drain_ai_worker_before_update()
            if worker_was_running:
                wait_for_ai_worker_idle()
                # Stop every process that may hold a profile DB before the
                # worker boot applies a staged restore. The worker comes back
                # first and is the sole restore owner; web starts only after
                # the worker health/control route confirms completion.
                run([*compose_command(), "stop", SERVICE_NAME])
                run([*compose_command(), "restart", AI_WORKER_SERVICE_NAME])
                wait_for_ai_worker_control()
                run([*compose_command(), "up", "-d", "--no-deps", SERVICE_NAME])
                write_log(
                    f"Coordinated restart completed for '{AI_WORKER_SERVICE_NAME}' and '{SERVICE_NAME}'."
                )
            else:
                run([*compose_command(), "restart", SERVICE_NAME])
                write_log(f"Restarted container service '{SERVICE_NAME}'.")
        except Exception as exc:  # noqa: BLE001 — log and move on
            if worker_was_running:
                ai_worker_control_for(worker_to_resume, "resume")
            if web_was_stopped:
                try:
                    run([*compose_command(), "up", "-d", "--no-deps", SERVICE_NAME])
                except Exception:
                    pass
            write_log(f"Container restart failed: {exc}")
        finally:
            if update_lock.locked():
                update_lock.release()
    threading.Thread(target=_do, daemon=True).start()


def rollback_container_async(delay: float = 0.4) -> None:
    """Switch the compose service back to the one cached rollback image.

    The HTTP caller is the app container that is about to be recreated, so this
    mirrors `restart_container_async`: acknowledge first, then mutate Docker in
    the background.
    """
    def _do() -> None:
        time.sleep(delay)
        set_state(phase="rolling_back", error=None, rollback=rollback_status())
        worker_was_running = False
        worker_to_resume = "blue"
        web_was_stopped = False
        try:
            image_id = docker_image_id(ROLLBACK_IMAGE_NAME)
            if not image_id:
                raise RuntimeError(f"No rollback image is available at {ROLLBACK_IMAGE_NAME}.")

            target_supports_worker = image_supports_durable_ai_worker(ROLLBACK_IMAGE_NAME)
            target_supports_handoff = image_supports_ai_worker_handoff(ROLLBACK_IMAGE_NAME)
            current_supports_handoff = running_service_supports_ai_worker_handoff()

            if current_supports_handoff:
                recover_incomplete_worker_handoff("rolling_back")
                registry = ensure_worker_registry()
                worker_to_resume = str(registry["current"]["id"])

                # Tag first: running containers remain pinned to their image
                # digest, while any replacement slot now boots the cached
                # rollback image.
                run([docker_command(), "tag", ROLLBACK_IMAGE_NAME, IMAGE_NAME])
                if target_supports_handoff:
                    perform_blue_green_handoff(None)
                else:
                    drained = ai_worker_control_for(worker_to_resume, "drain")
                    if not drained or not drained.get("ok"):
                        raise RuntimeError(
                            f"Could not close admission on AI worker {worker_to_resume} for rollback."
                        )
                    worker_was_running = True
                    if target_supports_worker:
                        wait_for_ai_worker_web_requests_for(worker_to_resume)
                    wait_for_ai_worker_idle_for(worker_to_resume)

                    run([*compose_command(), "stop", SERVICE_NAME])
                    web_was_stopped = True
                    for worker_id in ("green", "blue"):
                        if ai_worker_container_exists_for(worker_id):
                            slot = worker_slot(worker_id)
                            run([*worker_compose_command(worker_id), "rm", "-f", "-s", slot["service"]])

                    if target_supports_worker:
                        # Rollbacks to the original durable-worker generation
                        # use its canonical blue endpoint. The old image ignores
                        # the generation registry; keeping it canonical makes a
                        # later forward upgrade deterministic.
                        write_worker_registry("blue", [], "blue")
                        run([
                            *compose_command(), "up", "-d", "--no-build", "--no-deps",
                            "--force-recreate", AI_WORKER_SERVICE_NAME,
                        ])
                        blue_status = wait_for_ai_worker_control()
                        write_worker_registry(
                            "blue", [], "blue", {"blue": blue_status.get("buildCommit")}
                        )
                    else:
                        try:
                            worker_registry_path().unlink(missing_ok=True)
                        except OSError:
                            pass
                        write_log(
                            "Rollback target predates the durable worker; returned to single-process mode."
                        )

                    run([
                        *compose_command(), "up", "-d", "--no-build", "--no-deps",
                        "--force-recreate", SERVICE_NAME,
                    ])
                    web_was_stopped = False

                set_state(
                    phase="completed",
                    error=None,
                    rollback=rollback_status(),
                    waitReason=None,
                    activeRunCount=0,
                    responseBoundRunCount=0,
                )
                write_log(
                    f"Rolled back generation-aware container service '{SERVICE_NAME}' "
                    f"to {ROLLBACK_IMAGE_NAME}."
                )
                return

            worker_was_running = drain_ai_worker_before_update()
            if worker_was_running and target_supports_worker:
                wait_for_ai_worker_web_requests()
            elif worker_was_running:
                # The first rollback after introducing the split architecture
                # can target an image that predates the worker role/proxy. Such
                # an image would start a scheduler in BOTH Compose services.
                # Drain completely and remove the worker before booting the
                # legacy app in its original single-process mode.
                wait_for_ai_worker_idle()
            run([docker_command(), "tag", ROLLBACK_IMAGE_NAME, IMAGE_NAME])
            if worker_was_running and not target_supports_worker:
                run([
                    *compose_command(), "rm", "-f", "-s", AI_WORKER_SERVICE_NAME,
                ])
                worker_was_running = False
                write_log(
                    "Rollback target predates the durable worker; returned to single-process mode."
                )
            run([
                *compose_command(), "up", "-d", "--no-build", "--no-deps",
                "--force-recreate", SERVICE_NAME,
            ])
            if target_supports_worker:
                refresh_ai_worker_after_update(worker_was_running)
            set_state(
                phase="completed",
                error=None,
                rollback=rollback_status(),
                waitReason=None,
                activeRunCount=0,
                responseBoundRunCount=0,
            )
            write_log(f"Rolled back container service '{SERVICE_NAME}' to {ROLLBACK_IMAGE_NAME}.")
        except Exception as exc:  # noqa: BLE001 — log and surface through /status
            if worker_was_running:
                ai_worker_control_for(worker_to_resume, "resume")
            if web_was_stopped:
                try:
                    run([*compose_command(), "up", "-d", "--no-deps", SERVICE_NAME])
                except Exception:
                    pass
            message = str(exc)
            set_state(phase="failed", error=message, rollback=rollback_status())
            write_log(f"Container rollback failed: {message}")
        finally:
            if update_lock.locked():
                update_lock.release()
    threading.Thread(target=_do, daemon=True).start()


# npm stages each package into node_modules/.<name>-<hash> (and the scoped
# variant node_modules/@scope/.<name>-<hash>) before renaming it into place. An
# install interrupted mid-rename (container restart, OOM, `docker system prune`
# racing the volume, a download slower than the timeout) orphans that temp dir,
# and then EVERY later `npm install` dies with
# `ENOTEMPTY: rename ... -> .<name>-<hash>`, freezing the CLI half-written —
# typically the placeholder stub with no native binary, which exits 1 on every
# invocation. Sweep the orphans before installing so the update self-heals.
NPM_GLOBAL_NODE_MODULES = "/home/node/.npm-global/lib/node_modules"
NPM_STAGING_SWEEP = (
    'for d in "$N" "$N"/@*; do [ -d "$d" ] || continue; '
    'for t in "$d"/.*-*; do [ -d "$t" ] && rm -rf "$t"; done; done; true'
)
# `npm install` exits 0 even when a platform-native optionalDependency silently
# failed to download — that leaves `claude` as a stub that errors on every run.
# Probe each bin so we report a broken install instead of a false success.
CLI_VERIFY_PROBE = (
    'rc=0; for b in /home/node/.npm-global/bin/claude /home/node/.npm-global/bin/codex; do '
    '[ -e "$b" ] || continue; '
    '"$b" --version >/dev/null 2>&1 || { echo "BROKEN: $b"; rc=1; }; done; exit $rc'
)


def update_clis() -> dict:
    """Update the CLIs inside the running container's npm-global volume, then
    restart the container. Returns the install result; the restart runs in the
    background after this returns so the response reaches the app first."""
    if not CLI_UPDATE_PACKAGES:
        return {"ok": False, "error": "No CLI packages configured to update."}
    write_log("Starting CLI update: " + ", ".join(CLI_UPDATE_PACKAGES))

    # Claude/Codex live in a shared bind-mounted npm prefix used by both
    # services. Mutating that prefix while an agent process is executing can
    # replace its binary/package files mid-run, so close admission and wait for
    # every accepted worker run before touching the installation.
    worker_was_running = drain_ai_worker_before_update()
    if worker_was_running:
        wait_for_ai_worker_idle()

    try:
        # Clear orphaned npm staging temp dirs that would otherwise block the
        # install with ENOTEMPTY (see NPM_STAGING_SWEEP).
        run_capture(
            [*compose_command(), "exec", "-T", SERVICE_NAME, "sh", "-lc",
             f"N={NPM_GLOBAL_NODE_MODULES}; {NPM_STAGING_SWEEP}"],
            timeout=30,
        )

        code, output = run_capture(
            [*compose_command(), "exec", "-T", SERVICE_NAME, "npm", "install", "-g",
             "--include=optional", "--foreground-scripts", *CLI_UPDATE_PACKAGES],
            timeout=300,
        )
        if code != 0:
            if worker_was_running:
                resume_ai_worker()
            return {"ok": False, "error": f"npm install failed (exit {code}).", "log": output[-2000:]}

        # Verify the binaries actually run — a 0 exit from npm doesn't guarantee the
        # native binary landed (see CLI_VERIFY_PROBE).
        verify_code, verify_out = run_capture(
            [*compose_command(), "exec", "-T", SERVICE_NAME, "sh", "-lc", CLI_VERIFY_PROBE],
            timeout=30,
        )
        if verify_code != 0:
            if worker_was_running:
                resume_ai_worker()
            return {
                "ok": False,
                "error": "CLI update finished but a binary is broken (native install did not land). "
                         "Cleared the orphaned temp dir — re-run the update.",
                "log": (output + "\n" + verify_out)[-2000:],
            }

        _, versions = run_capture(
            [*compose_command(), "exec", "-T", SERVICE_NAME, "sh", "-lc", CLI_VERSION_PROBE],
            timeout=30,
        )
        # Keep admission closed across the short response-flush delay. The
        # coordinated restart thread re-confirms drain and owns lock release.
        restart_container_async()
        return {"ok": True, "phase": "restarting", "versions": versions.strip()}
    except Exception:
        if worker_was_running:
            resume_ai_worker()
        raise


# ── Background job containers ────────────────────────────────────────────
# Per-job ephemeral containers: the app asks the bridge to run a tracked
# background job in its OWN container, with image/mounts/network/user cloned
# from the live app container, so app redeploys never kill running jobs. The
# job writes its log + exit-code marker to the shared state volume and the
# app's reconcile sweep finalizes it from there. The container dies with the
# job (--rm) — there is deliberately no long-lived runner to keep updated.

JOB_CONTAINER_PREFIX = "orch-bgjob-"
JOB_ID_RE = re.compile(r"^bg_[A-Za-z0-9_]{1,80}$")
ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")


def job_container_name(job_id: str) -> str:
    return JOB_CONTAINER_PREFIX + job_id


def app_container_inspect() -> Optional[dict]:
    docker = docker_command()
    lines = capture_optional(compose_command() + ["ps", "-q", SERVICE_NAME]).splitlines()
    cid = next((line.strip() for line in lines if line.strip()), "")
    if not cid:
        return None
    raw = capture_optional([docker, "inspect", cid])
    try:
        parsed = json.loads(raw)
        return parsed[0] if isinstance(parsed, list) and parsed else None
    except Exception:
        return None


def run_background_job_container(payload: dict) -> dict:
    job_id = str(payload.get("jobId") or "")
    command = payload.get("command")
    cwd = str(payload.get("cwd") or "")
    env = payload.get("env") or {}
    if not JOB_ID_RE.match(job_id):
        return {"ok": False, "error": "Invalid jobId."}
    if not isinstance(command, str) or not command.strip():
        return {"ok": False, "error": "command is required."}
    if not cwd.startswith("/"):
        return {"ok": False, "error": "cwd must be an absolute container path."}
    if not isinstance(env, dict):
        return {"ok": False, "error": "env must be an object."}

    inspect = app_container_inspect()
    if not inspect:
        return {"ok": False, "error": "The app container is not running; cannot clone its runtime."}
    # Pin the job to the image DIGEST the app runs right now: rebuilds retag
    # orchestrator:local but the digest stays valid (and prune-safe) while
    # this container uses it.
    image = inspect.get("Image") or ""
    if not image:
        return {"ok": False, "error": "Could not resolve the app container image."}
    config = inspect.get("Config") or {}
    user = config.get("User") or ""
    docker = docker_command()

    args = [
        docker, "run", "-d", "--rm",
        "--name", job_container_name(job_id),
        "--label", "orchestrator.background-job=1",
    ]
    if user:
        args += ["--user", user]
    for mount in inspect.get("Mounts") or []:
        src = mount.get("Source")
        dst = mount.get("Destination")
        if not src or not dst:
            continue
        suffix = "" if mount.get("RW", True) else ":ro"
        args += ["-v", f"{src}:{dst}{suffix}"]
    networks = list(((inspect.get("NetworkSettings") or {}).get("Networks") or {}).keys())
    if networks:
        args += ["--network", networks[0]]
    for key, value in env.items():
        if not isinstance(key, str) or not ENV_KEY_RE.match(key) or not isinstance(value, str):
            return {"ok": False, "error": f"Invalid env entry: {key!r}"}
        args += ["-e", f"{key}={value}"]
    args += ["-w", cwd, image, "/bin/bash", "-lc", command]

    code, output = run_capture(args, timeout=60)
    if code != 0:
        return {"ok": False, "error": (output or "docker run failed").strip()[-500:]}
    container_id = output.strip().splitlines()[-1][:64] if output.strip() else ""
    return {"ok": True, "containerName": job_container_name(job_id), "containerId": container_id}


def kill_background_job_container(payload: dict) -> dict:
    job_id = str(payload.get("jobId") or "")
    if not JOB_ID_RE.match(job_id):
        return {"ok": False, "error": "Invalid jobId."}
    docker = docker_command()
    code, output = run_capture([docker, "stop", "-t", "5", job_container_name(job_id)], timeout=30)
    if code != 0:
        if "no such container" in (output or "").lower():
            return {"ok": True, "alreadyGone": True}
        return {"ok": False, "error": (output or "docker stop failed").strip()[-300:]}
    return {"ok": True}


def background_job_container_status(job_id: str) -> dict:
    if not JOB_ID_RE.match(job_id):
        return {"ok": False, "error": "Invalid jobId."}
    docker = docker_command()
    out = capture_optional([docker, "inspect", "--format", "{{.State.Running}}", job_container_name(job_id)])
    if not out:
        return {"ok": True, "exists": False, "running": False}
    return {"ok": True, "exists": True, "running": out.strip().lower() == "true"}


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
        if path not in {"/status", "/claude-usage", "/update-log", "/remote-access", "/background-job/status"}:
            self.send_json(404, {"error": "Not found."})
            return
        if not self.authenticated():
            self.send_json(401, {"error": "Unauthorized."})
            return
        if path == "/background-job/status":
            query = parse_qs(urlsplit(self.path).query)
            job_id = (query.get("jobId") or [""])[0]
            result = background_job_container_status(job_id)
            self.send_json(200 if result.get("ok") else 400, result)
            return
        if path == "/remote-access":
            self.send_json(200, detect_remote_access())
            return
        if path == "/status":
            with state_lock:
                payload = dict(state)
            payload["rollback"] = rollback_status()
            self.send_json(200, payload)
            return
        if path == "/update-log":
            stream_update_log(self)
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
        path = self.path.split("?", 1)[0]
        if path not in {
            "/update",
            "/update-clis",
            "/restart",
            "/rollback",
            "/remote-access/funnel",
            "/remote-access/app-funnel",
            "/remote-access/published-app-funnel",
            "/remote-access/install-tailscale",
            "/remote-access/https",
            "/background-job/run",
            "/background-job/kill",
        }:
            self.send_json(404, {"error": "Not found."})
            return
        if not self.authenticated():
            self.send_json(401, {"error": "Unauthorized."})
            return

        # Background-job containers are independent of the update pipeline —
        # quick docker commands, no update lock.
        if path in {"/background-job/run", "/background-job/kill"}:
            try:
                length = min(int(self.headers.get("Content-Length", "0") or "0"), 1024 * 1024)
                raw = self.rfile.read(length) if length else b"{}"
                body = json.loads(raw.decode("utf-8") or "{}")
            except Exception:
                self.send_json(400, {"error": "Invalid JSON payload."})
                return
            result = (
                run_background_job_container(body)
                if path == "/background-job/run"
                else kill_background_job_container(body)
            )
            self.send_json(200 if result.get("ok") else 502, result)
            return

        # Remote-access actions are independent of the update pipeline, so handle
        # them before (and without) the update lock — they're quick commands.
        if path == "/remote-access/funnel":
            try:
                length = min(int(self.headers.get("Content-Length", "0") or "0"), 65536)
                raw = self.rfile.read(length) if length else b"{}"
                body = json.loads(raw.decode("utf-8") or "{}")
            except Exception:
                self.send_json(400, {"error": "Invalid JSON payload."})
                return
            result = set_webhook_funnel(bool(body.get("enable")))
            self.send_json(200 if result.get("ok") else 502, result)
            return

        if path == "/remote-access/app-funnel":
            try:
                length = min(int(self.headers.get("Content-Length", "0") or "0"), 65536)
                raw = self.rfile.read(length) if length else b"{}"
                body = json.loads(raw.decode("utf-8") or "{}")
            except Exception:
                self.send_json(400, {"error": "Invalid JSON payload."})
                return
            result = set_app_funnel(bool(body.get("enable")))
            self.send_json(200 if result.get("ok") else 502, result)
            return

        if path == "/remote-access/published-app-funnel":
            try:
                length = min(int(self.headers.get("Content-Length", "0") or "0"), 65536)
                raw = self.rfile.read(length) if length else b"{}"
                body = json.loads(raw.decode("utf-8") or "{}")
            except Exception:
                self.send_json(400, {"error": "Invalid JSON payload."})
                return
            slug = str(body.get("slug") or "").strip()
            result = set_published_app_funnel(slug, bool(body.get("enable")))
            self.send_json(200 if result.get("ok") else 502, result)
            return

        if path == "/remote-access/install-tailscale":
            result = install_tailscale()
            self.send_json(200 if result.get("ok") else 502, result)
            return

        if path == "/remote-access/https":
            try:
                length = min(int(self.headers.get("Content-Length", "0") or "0"), 65536)
                raw = self.rfile.read(length) if length else b"{}"
                body = json.loads(raw.decode("utf-8") or "{}")
            except Exception:
                self.send_json(400, {"error": "Invalid JSON payload."})
                return
            domain = str(body.get("domain") or "").strip()
            token = str(body.get("token") or "").strip()
            email = str(body.get("email") or "").strip()
            if not domain or not token:
                self.send_json(400, {"error": "domain and token are required."})
                return
            result = setup_https_duckdns(domain, token, email)
            self.send_json(200 if result.get("ok") else 502, result)
            return

        if not update_lock.acquire(blocking=False):
            self.send_json(409, {"error": "Docker update already running."})
            return

        if path == "/restart":
            # Lock is released by the background restart thread.
            self.send_json(202, {"ok": True, "phase": "restarting"})
            restart_container_async()
            return

        if path == "/rollback":
            if not docker_image_id(ROLLBACK_IMAGE_NAME):
                update_lock.release()
                self.send_json(409, {"ok": False, "error": "No cached rollback image is available."})
                return
            self.send_json(202, {"ok": True, "phase": "rolling_back", "rollback": rollback_status()})
            rollback_container_async()
            return

        if path == "/update-clis":
            try:
                result = update_clis()
            except Exception as exc:  # noqa: BLE001
                update_lock.release()
                self.send_json(500, {"ok": False, "error": str(exc)})
                return
            if not result.get("ok"):
                # No restart was scheduled — release the lock ourselves.
                update_lock.release()
                self.send_json(502, result)
                return
            # Success: restart_container_async() owns the lock release now.
            self.send_json(200, result)
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
    set_state(rollback=rollback_status())
    write_log(f"Listening on {BIND_HOST}:{PORT} for app dir {APP_DIR}")
    server = ThreadingHTTPServer((BIND_HOST, PORT), Handler)

    def _recover_handoff() -> None:
        if not update_lock.acquire(blocking=False):
            return
        try:
            if running_service_supports_ai_worker_handoff():
                recovered = recover_incomplete_worker_handoff()
                if recovered:
                    set_state(
                        phase="idle",
                        error=None,
                        waitReason=None,
                        activeRunCount=0,
                        responseBoundRunCount=0,
                    )
        except Exception as exc:  # noqa: BLE001 — keep serving; next update retries recovery
            set_state(phase="failed", error=str(exc))
            write_log(f"Automatic AI worker handoff recovery failed: {exc}")
        finally:
            update_lock.release()

    threading.Thread(target=_recover_handoff, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    if len(sys.argv) > 1:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        if sys.argv[1] == "--save-rollback":
            save_current_image_for_rollback("manual", sys.argv[2] if len(sys.argv) > 2 else BRANCH)
        elif sys.argv[1] == "--deploy-current":
            if not TOKEN_FILE.exists():
                raise SystemExit(f"Missing token file: {TOKEN_FILE}")
            update_stack({
                "jobId": f"manual-{int(time.time())}",
                "targetBranch": current_git_ref() or BRANCH,
                "skipGit": True,
            })
            with state_lock:
                final_state = dict(state)
            if final_state.get("phase") != "completed":
                raise SystemExit(final_state.get("error") or "Manual deploy failed.")
        else:
            raise SystemExit(f"Unknown argument: {sys.argv[1]}")
    else:
        main()
