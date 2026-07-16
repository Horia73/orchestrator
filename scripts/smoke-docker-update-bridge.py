#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
import tempfile
from pathlib import Path


def load_bridge(root: Path):
    app_dir = root / "app"
    app_dir.mkdir(parents=True)
    (app_dir / ".git").mkdir()
    (app_dir / "package.json").write_text(json.dumps({"version": "9.9.9"}), encoding="utf-8")
    token_file = root / "update-token"
    token_file.write_text("smoke-token", encoding="utf-8")
    os.environ["ORCHESTRATOR_UPDATE_APP_DIR"] = str(app_dir)
    os.environ["ORCHESTRATOR_UPDATE_TOKEN_FILE"] = str(token_file)
    os.environ["ORCHESTRATOR_UPDATE_LOG_DIR"] = str(root / "logs")

    script = Path(__file__).with_name("docker-update-bridge.py")
    spec = importlib.util.spec_from_file_location("docker_update_bridge_smoke", script)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="docker-update-bridge-smoke-") as raw:
        bridge = load_bridge(Path(raw))
        commands: list[list[str]] = []
        refresh_calls: list[bool] = []
        response_waits: list[bool] = []
        notifications: list[tuple[str, str]] = []
        lifecycle_events: list[str] = []

        bridge.docker_image_id = lambda image: {
            "orchestrator:local": "sha256:live",
            "orchestrator:rollback": "sha256:rollback",
        }.get(image, "")
        bridge.running_service_metadata = lambda: {
            "version": "1.2.3",
            "commit": "old123commit",
            "ref": "v1.2.3",
        }
        bridge.run = lambda command, env=None: commands.append(list(command))
        bridge.save_current_image_for_rollback("metadata-smoke", "v9.9.9")
        saved = json.loads(bridge.ROLLBACK_STATE_PATH.read_text(encoding="utf-8"))
        assert saved["version"] == "1.2.3", saved
        assert saved["commit"] == "old123commit", saved
        assert saved["ref"] == "v1.2.3", saved
        assert saved["savedBeforeTarget"] == "v9.9.9", saved
        commands.clear()

        bridge.compose_command = lambda: ["docker", "compose"]
        bridge.current_git_ref = lambda: "master"
        bridge.drain_ai_worker_before_update = lambda: lifecycle_events.append("drain") or True
        bridge.wait_for_ai_worker_web_requests = lambda: (
            lifecycle_events.append("wait-response-bound"),
            response_waits.append(True),
        )[-1]
        bridge.save_current_image_for_rollback = lambda *_args: None
        bridge.prune_docker_build_artifacts = lambda *_args: None
        bridge.scrub_stale_build_env = lambda *_args: None
        bridge.capture = lambda command: "abc123def456" if "rev-parse" in command else ""
        bridge.run = lambda command, env=None: (
            lifecycle_events.append(f"command:{' '.join(command)}"),
            commands.append(list(command)),
        )[-1]
        bridge.refresh_ai_worker_after_update = lambda running: refresh_calls.append(running)
        bridge.notify_app = lambda _job, phase, reason, **_kwargs: notifications.append((phase, reason))
        bridge.rollback_status = lambda: None

        bridge.update_stack({
            "jobId": "smoke-deploy",
            "targetBranch": "master",
            "skipGit": True,
        })

        compose_build = next(command for command in commands if command[:3] == ["docker", "compose", "build"])
        assert compose_build == ["docker", "compose", "build", "orchestrator"], compose_build
        compose_up = next(command for command in commands if command[:3] == ["docker", "compose", "up"])
        assert compose_up == [
            "docker", "compose", "up", "-d", "--no-build", "--no-deps",
            "--force-recreate", "orchestrator",
        ], compose_up
        build_event = lifecycle_events.index("command:docker compose build orchestrator")
        drain_event = lifecycle_events.index("drain")
        up_event = lifecycle_events.index(
            "command:docker compose up -d --no-build --no-deps --force-recreate orchestrator"
        )
        assert build_event < drain_event < up_event, lifecycle_events
        assert not any(command and command[0] == "git" for command in commands), commands
        assert refresh_calls == [True], refresh_calls
        assert response_waits == [True], response_waits
        assert bridge.state["phase"] == "completed", bridge.state
        assert notifications[-1][0] == "completed", notifications

        bridge.ai_worker_container_exists = lambda: True
        bridge.ai_worker_control = lambda action=None, timeout=10: {
            "ok": True,
            "activeRunCount": 2,
        }
        assert bridge.drain_ai_worker_before_update() is True

        statuses = iter([
            {
                "ok": True,
                "agentRuns": [
                    {"id": "app-1", "kind": "app"},
                    {"id": "chat-child", "kind": "scheduled"},
                ],
            },
            {
                "ok": True,
                "agentRuns": [{"id": "chat-child", "kind": "scheduled"}],
            },
        ])
        bridge.ai_worker_control = lambda action=None, timeout=10: next(statuses)
        bridge.ai_worker_container_exists = lambda: True
        bridge.time.sleep = lambda _seconds: None
        bridge.wait_for_ai_worker_web_requests()
        assert bridge.state["responseBoundRunCount"] == 0, bridge.state

    print("docker update bridge smoke passed")


if __name__ == "__main__":
    main()
