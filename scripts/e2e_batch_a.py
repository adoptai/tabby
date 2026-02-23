#!/usr/bin/env python3
"""
Batch A E2E validator:
1) request stream URL
2) perform websocket upgrade probe
3) verify token replay rejection
4) execute takeover/release loop

Writes evidence artifacts under implementation_tracker/phase_2/evidence.
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import os
import socket
import ssl
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional, Tuple
from urllib import parse, request, error


@dataclass
class HttpResult:
    status: int
    body_text: str
    json_body: Optional[Dict[str, Any]]


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def write_text(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


def write_json(path: Path, content: Any) -> None:
    write_text(path, json.dumps(content, indent=2, sort_keys=True))


def log(msg: str, run_log: Path) -> None:
    line = f"[{utc_now()}] {msg}"
    print(line)
    with run_log.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def http_json(
    method: str,
    url: str,
    token: Optional[str] = None,
    body: Optional[Dict[str, Any]] = None,
    timeout: int = 20,
) -> HttpResult:
    data = None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        data = json.dumps(body).encode("utf-8")

    req = request.Request(url=url, method=method, headers=headers, data=data)
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            parsed = None
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                parsed = None
            return HttpResult(status=resp.status, body_text=raw, json_body=parsed)
    except error.HTTPError as http_err:
        raw = http_err.read().decode("utf-8", errors="replace")
        parsed = None
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            parsed = None
        return HttpResult(status=http_err.code, body_text=raw, json_body=parsed)


def decode_jwt_payload(token: str) -> Dict[str, Any]:
    parts = token.split(".")
    if len(parts) < 2:
        raise ValueError("Invalid JWT format")
    payload = parts[1]
    payload += "=" * (-len(payload) % 4)
    decoded = base64.urlsafe_b64decode(payload.encode("ascii"))
    return json.loads(decoded.decode("utf-8"))


def ws_upgrade_probe(url: str) -> Dict[str, Any]:
    parsed = parse.urlparse(url)
    if parsed.scheme not in ("ws", "wss"):
        raise ValueError("WebSocket URL must use ws:// or wss://")

    host = parsed.hostname
    if not host:
        raise ValueError("WebSocket URL missing host")
    port = parsed.port or (443 if parsed.scheme == "wss" else 80)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"

    key = base64.b64encode(os.urandom(16)).decode("ascii")
    req = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Connection: Upgrade\r\n"
        "Upgrade: websocket\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "\r\n"
    ).encode("ascii")

    raw_sock = socket.create_connection((host, port), timeout=10.0)
    try:
        if parsed.scheme == "wss":
            context = ssl.create_default_context()
            sock: socket.socket = context.wrap_socket(raw_sock, server_hostname=host)
        else:
            sock = raw_sock

        with sock:
            sock.sendall(req)
            raw = b""
            while b"\r\n\r\n" not in raw:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                raw += chunk
    finally:
        try:
            raw_sock.close()
        except OSError:
            pass

    text = raw.decode("latin-1", errors="replace")
    lines = text.split("\r\n")
    status_line = lines[0] if lines else "INVALID_RESPONSE"
    status_code = 0
    parts = status_line.split(" ", 2)
    if len(parts) >= 2 and parts[1].isdigit():
        status_code = int(parts[1])

    headers: Dict[str, str] = {}
    for line in lines[1:]:
        if not line:
            break
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        headers[k.strip().lower()] = v.strip()

    return {
        "url": url,
        "status_code": status_code,
        "status_line": status_line,
        "headers": headers,
    }


def force_hitl_preconditions(repo_root: Path, session_id: str, run_log: Path) -> Dict[str, Any]:
    cmd = [
        "pnpm",
        "--filter",
        "@browser-hitl/api",
        "exec",
        "node",
        "../../scripts/batch-a-force-hitl-state.js",
        session_id,
    ]
    log("Forcing HITL preconditions via DB helper", run_log)
    proc = subprocess.run(
        cmd,
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        check=False,
    )
    return {
        "cmd": cmd,
        "exit_code": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }


def seed_synthetic_session(
    repo_root: Path,
    app_id: str,
    tenant_id: str,
    run_log: Path,
    pod_name: str,
) -> Dict[str, Any]:
    cmd = [
        "pnpm",
        "--filter",
        "@browser-hitl/api",
        "exec",
        "node",
        "../../scripts/batch-a-seed-session.js",
        app_id,
        tenant_id,
        pod_name,
    ]
    log("Seeding synthetic session via DB helper", run_log)
    proc = subprocess.run(
        cmd,
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        check=False,
    )

    parsed_stdout: Optional[Dict[str, Any]] = None
    if proc.stdout.strip():
        try:
            loaded = json.loads(proc.stdout)
            if isinstance(loaded, dict):
                parsed_stdout = loaded
        except json.JSONDecodeError:
            parsed_stdout = None

    return {
        "cmd": cmd,
        "exit_code": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "parsed_stdout": parsed_stdout,
    }


def pick_or_create_app(
    api_url: str,
    token: str,
    app_name: str,
    create_if_missing: bool,
    login_url: str,
    run_dir: Path,
    run_log: Path,
) -> str:
    apps_res = http_json("GET", f"{api_url}/apps?limit=200&offset=0", token=token)
    write_json(
        run_dir / "apps_list.json",
        {"status": apps_res.status, "body": apps_res.json_body, "raw": apps_res.body_text},
    )
    if apps_res.status != 200 or not apps_res.json_body:
        raise RuntimeError(f"Failed to list apps: HTTP {apps_res.status}")

    apps = apps_res.json_body.get("data") or []
    for app in apps:
        if app.get("name") == app_name:
            app_id = app.get("id")
            if app_id:
                log(f"Using existing app: {app_name} ({app_id})", run_log)
                return str(app_id)

    if not create_if_missing:
        if apps:
            app_id = apps[0].get("id")
            if app_id:
                log(f"Using first available app: {app_id}", run_log)
                return str(app_id)
        raise RuntimeError("No app found and app auto-create disabled")

    payload = {
        "name": app_name,
        "target_urls": ["https://example.com"],
        "login_config": {
            "login_url": login_url,
            "credential_ref": "k8s:secret/batch-a-creds",
            "steps": [
                {"action": "goto", "url": login_url},
                {"action": "fill", "selector": "#email", "value": "${USERNAME}"},
                {"action": "fill", "selector": "#password", "value": "${PASSWORD}", "sensitive": True},
                {"action": "click", "selector": "#login-button"},
            ],
            "otp_prompt": {"method": "chat", "field_selector": "#otp"},
        },
        "keepalive_config": {
            "interval_seconds": 60,
            "actions": [{"action": "goto", "url": login_url}],
            "health_checks": [{"type": "url_check", "url": "https://example.com", "expect_status": 200}],
            "policy": "all",
        },
        "export_policy": {
            "artifact_types": ["cookies", "headers", "csrf_token", "local_storage", "session_storage"],
            "encryption": {"algo": "AES-256-GCM", "key_ref": "k8s:secret/batch-a-key"},
            "ttl_seconds": 600,
            "refresh_interval_seconds": 3600,
            "header_allowlist": ["x-csrf-token", "authorization"],
        },
        "notification_config": {"channels": ["slack:#general"]},
        "desired_session_count": 1,
        "browser_policy": {"downloads": False, "clipboard": False, "file_chooser": False},
    }
    write_json(run_dir / "create_app_payload.json", payload)
    create_res = http_json("POST", f"{api_url}/apps", token=token, body=payload)
    write_json(
        run_dir / "create_app_response.json",
        {"status": create_res.status, "body": create_res.json_body, "raw": create_res.body_text},
    )
    if create_res.status not in (200, 201) or not create_res.json_body:
        raise RuntimeError(f"Failed to create app: HTTP {create_res.status}")
    app_id = create_res.json_body.get("app_id")
    if not app_id:
        raise RuntimeError("Create app response missing app_id")
    log(f"Created app: {app_name} ({app_id})", run_log)
    return str(app_id)


def wait_for_session(
    api_url: str,
    token: str,
    app_id: str,
    timeout_seconds: int,
    ready_states: set[str],
    run_dir: Path,
    run_log: Path,
) -> Dict[str, Any]:
    deadline = time.time() + timeout_seconds
    attempt = 0

    while time.time() < deadline:
        attempt += 1
        sessions_res = http_json("GET", f"{api_url}/sessions?limit=200&offset=0", token=token)
        write_json(
            run_dir / f"sessions_poll_{attempt:02d}.json",
            {"status": sessions_res.status, "body": sessions_res.json_body, "raw": sessions_res.body_text},
        )
        if sessions_res.status == 200 and sessions_res.json_body:
            sessions = sessions_res.json_body.get("data") or []
            candidates = [
                s
                for s in sessions
                if s.get("app_id") == app_id
                and s.get("state") != "TERMINATED"
                and str(s.get("state", "")) in ready_states
                and s.get("pod_name")
            ]
            if candidates:
                # Most recent first
                candidates.sort(key=lambda s: str(s.get("started_at", "")), reverse=True)
                picked = candidates[0]
                log(
                    f"Selected session {picked.get('id')} state={picked.get('state')} pod={picked.get('pod_name')}",
                    run_log,
                )
                return picked
        time.sleep(5)

    raise RuntimeError(
        f"Timed out waiting for active session with pod_name for app {app_id} ({timeout_seconds}s)"
    )


def wait_for_session_state(
    api_url: str,
    token: str,
    session_id: str,
    expected_state: str,
    timeout_seconds: int,
    run_dir: Path,
    run_log: Path,
) -> Dict[str, Any]:
    deadline = time.time() + timeout_seconds
    attempt = 0

    while time.time() < deadline:
        attempt += 1
        session_res = http_json("GET", f"{api_url}/sessions/{session_id}", token=token)
        write_json(
            run_dir / f"session_state_poll_{attempt:02d}.json",
            {"status": session_res.status, "body": session_res.json_body, "raw": session_res.body_text},
        )
        if session_res.status == 200 and session_res.json_body:
            current_state = str(session_res.json_body.get("state", ""))
            if current_state == expected_state:
                log(
                    f"Session {session_id} reached state={expected_state} after {attempt} polls",
                    run_log,
                )
                return session_res.json_body
        time.sleep(5)

    raise RuntimeError(
        f"Timed out waiting for session {session_id} to reach state {expected_state} ({timeout_seconds}s)"
    )


def rewrite_stream_url_host(stream_url: str, host_override: str) -> str:
    if not host_override:
        return stream_url
    parsed = parse.urlparse(stream_url)
    if not parsed.scheme:
        return stream_url
    return parse.urlunparse(
        (
            parsed.scheme,
            host_override,
            parsed.path,
            parsed.params,
            parsed.query,
            parsed.fragment,
        )
    )


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent

    api_url = os.getenv("API_URL", "http://localhost:8080").rstrip("/")
    admin_email = os.getenv("ADMIN_EMAIL", "admin@browser-hitl.local")
    admin_password = os.getenv("ADMIN_PASSWORD", "e2e-admin-password")
    app_name = os.getenv("BATCH_A_APP_NAME", "batch-a-e2e")
    create_app = os.getenv("BATCH_A_CREATE_APP", "true").lower() == "true"
    login_url = os.getenv("BATCH_A_LOGIN_URL", "http://test-harness:8000/login")
    force_preconditions = os.getenv("FORCE_HITL_PRECONDITIONS", "true").lower() == "true"
    stream_host_override = os.getenv("BATCH_A_STREAM_HOST_OVERRIDE", "").strip()
    allow_synthetic_session = (
        os.getenv("BATCH_A_ALLOW_SYNTHETIC_SESSION", "false").lower() == "true"
    )
    synthetic_pod_name = os.getenv("BATCH_A_SYNTHETIC_POD_NAME", f"batcha-local-{int(time.time())}")
    hitl_loop_count = int(os.getenv("HITL_LOOP_COUNT", "1"))
    wait_timeout_seconds = int(os.getenv("WAIT_TIMEOUT_SECONDS", "180"))
    takeover_ready_timeout_seconds = int(os.getenv("BATCH_A_TAKEOVER_READY_TIMEOUT_SECONDS", "180"))
    ready_states = {
        state.strip()
        for state in os.getenv(
            "BATCH_A_READY_STATES",
            "LOGIN_NEEDED,LOGIN_IN_PROGRESS,HEALTHY,UNHEALTHY",
        ).split(",")
        if state.strip()
    }
    evidence_root = Path(
        os.getenv("EVIDENCE_ROOT", str(repo_root / "implementation_tracker/phase_2/evidence"))
    )

    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = evidence_root / f"batch_a_{timestamp}"
    ensure_dir(run_dir)
    run_log = run_dir / "run.log"

    summary: Dict[str, Any] = {
        "started_at": utc_now(),
        "api_url": api_url,
        "app_name": app_name,
        "hitl_loop_count": hitl_loop_count,
        "force_hitl_preconditions": force_preconditions,
        "allow_synthetic_session": allow_synthetic_session,
        "ready_states": sorted(ready_states),
        "checks": {},
    }

    log(f"Batch A run directory: {run_dir}", run_log)
    try:
        # 1) Login
        login_res = http_json(
            "POST",
            f"{api_url}/login",
            body={"email": admin_email, "password": admin_password},
        )
        write_json(
            run_dir / "login_response.json",
            {"status": login_res.status, "body": login_res.json_body, "raw": login_res.body_text},
        )
        if login_res.status != 200 or not login_res.json_body or not login_res.json_body.get("token"):
            raise RuntimeError(f"Login failed: HTTP {login_res.status}")
        token = str(login_res.json_body["token"])
        jwt_payload = decode_jwt_payload(token)
        tenant_id = str(jwt_payload.get("tenant_id", ""))
        user_id = str(jwt_payload.get("sub", ""))
        summary["checks"]["login"] = True
        summary["tenant_id"] = tenant_id
        summary["user_id"] = user_id

        # 2) App selection/creation and ensure desired sessions = 1
        app_id = pick_or_create_app(api_url, token, app_name, create_app, login_url, run_dir, run_log)
        summary["app_id"] = app_id
        summary["checks"]["app_ready"] = True

        scale_res = http_json(
            "POST",
            f"{api_url}/apps/{app_id}/sessions/scale",
            token=token,
            body={"desired_sessions": 1},
        )
        write_json(
            run_dir / "scale_response.json",
            {"status": scale_res.status, "body": scale_res.json_body, "raw": scale_res.body_text},
        )
        if scale_res.status != 200:
            raise RuntimeError(f"Scale request failed: HTTP {scale_res.status}")
        summary["checks"]["scale_request"] = True

        # 3) Wait for a session with pod_name
        try:
            session = wait_for_session(
                api_url,
                token,
                app_id,
                wait_timeout_seconds,
                ready_states,
                run_dir,
                run_log,
            )
        except RuntimeError:
            if not allow_synthetic_session:
                raise
            if not os.getenv("DATABASE_URL"):
                raise RuntimeError(
                    "No live session found and DATABASE_URL is not set for BATCH_A_ALLOW_SYNTHETIC_SESSION"
                )

            seeded = seed_synthetic_session(
                repo_root=repo_root,
                app_id=app_id,
                tenant_id=tenant_id,
                run_log=run_log,
                pod_name=synthetic_pod_name,
            )
            write_json(run_dir / "synthetic_seed_result.json", seeded)
            if seeded.get("exit_code") != 0:
                raise RuntimeError(
                    f"Synthetic session seeding failed: exit={seeded.get('exit_code')}"
                )

            summary["synthetic_seeded"] = True
            seeded_session = (seeded.get("parsed_stdout") or {}).get("session") or {}
            if seeded_session.get("id"):
                summary["synthetic_session_id"] = seeded_session.get("id")
            if seeded_session.get("pod_name"):
                summary["synthetic_pod_name"] = seeded_session.get("pod_name")

            # Give the API query path a short window to surface the newly seeded row.
            session = wait_for_session(
                api_url,
                token,
                app_id,
                30,
                ready_states,
                run_dir,
                run_log,
            )

        session_id = str(session.get("id"))
        summary["session_id"] = session_id
        summary["checks"]["session_ready"] = True

        if not force_preconditions:
            wait_for_session_state(
                api_url=api_url,
                token=token,
                session_id=session_id,
                expected_state="LOGIN_IN_PROGRESS",
                timeout_seconds=takeover_ready_timeout_seconds,
                run_dir=run_dir,
                run_log=run_log,
            )
            summary["checks"]["no_force_takeover_ready_state"] = True

        # 4) Request stream URL
        stream_res = http_json("POST", f"{api_url}/sessions/{session_id}/stream", token=token, body={})
        write_json(
            run_dir / "stream_response.json",
            {"status": stream_res.status, "body": stream_res.json_body, "raw": stream_res.body_text},
        )
        if stream_res.status != 200 or not stream_res.json_body:
            raise RuntimeError(f"Stream URL request failed: HTTP {stream_res.status}")
        stream_url = str(stream_res.json_body.get("url", ""))
        if not stream_url:
            raise RuntimeError("Stream URL response missing url")
        effective_stream_url = rewrite_stream_url_host(stream_url, stream_host_override)
        summary["stream_url"] = stream_url
        summary["effective_stream_url"] = effective_stream_url
        summary["checks"]["stream_url_issued"] = True

        viewer_res = http_json("GET", effective_stream_url)
        write_json(
            run_dir / "viewer_response.json",
            {"status": viewer_res.status, "raw": viewer_res.body_text[:4000]},
        )
        if viewer_res.status != 200:
            raise RuntimeError(f"Viewer endpoint failed: HTTP {viewer_res.status}")
        summary["checks"]["viewer_endpoint"] = True

        # 5) WebSocket first connect + replay rejection
        parsed_stream = parse.urlparse(effective_stream_url)
        token_q = parse.parse_qs(parsed_stream.query).get("token", [""])[0]
        if not token_q:
            raise RuntimeError("Stream URL missing token query parameter")
        ws_scheme = "wss" if parsed_stream.scheme == "https" else "ws"
        ws_host = parsed_stream.netloc
        if stream_host_override:
            ws_host = stream_host_override
        ws_url = f"{ws_scheme}://{ws_host}/vnc-ws?session_id={parse.quote(session_id)}&token={parse.quote(token_q)}"
        summary["ws_url"] = ws_url

        ws_first = ws_upgrade_probe(ws_url)
        write_json(run_dir / "ws_probe_first.json", ws_first)
        ws_second = ws_upgrade_probe(ws_url)
        write_json(run_dir / "ws_probe_replay.json", ws_second)

        first_ok = ws_first.get("status_code") == 101
        replay_rejected = ws_second.get("status_code") == 401
        summary["checks"]["ws_first_not_rejected_as_replay"] = bool(first_ok)
        summary["checks"]["ws_replay_rejected"] = bool(replay_rejected)
        if not first_ok or not replay_rejected:
            raise RuntimeError(
                f"Replay check failed: first={ws_first.get('status_code')} second={ws_second.get('status_code')}"
            )

        # 6) Takeover/release loop
        loops_ok = True
        loop_results = []
        for i in range(1, hitl_loop_count + 1):
            attempt = {"loop": i}
            takeover = http_json("POST", f"{api_url}/sessions/{session_id}/takeover", token=token, body={})
            attempt["takeover_initial"] = {
                "status": takeover.status,
                "body": takeover.json_body,
                "raw": takeover.body_text,
            }

            if takeover.status != 200 and force_preconditions:
                if not os.getenv("DATABASE_URL"):
                    raise RuntimeError(
                        "Takeover preconditions unmet and DATABASE_URL is not set for FORCE_HITL_PRECONDITIONS"
                    )
                forced = force_hitl_preconditions(repo_root, session_id, run_log)
                attempt["forced_preconditions"] = forced
                if forced.get("exit_code") != 0:
                    raise RuntimeError(
                        f"Failed to force takeover preconditions: exit={forced.get('exit_code')}"
                    )
                takeover = http_json(
                    "POST",
                    f"{api_url}/sessions/{session_id}/takeover",
                    token=token,
                    body={},
                )
                attempt["takeover_after_force"] = {
                    "status": takeover.status,
                    "body": takeover.json_body,
                    "raw": takeover.body_text,
                }

            if takeover.status != 200:
                loops_ok = False
                attempt["error"] = f"takeover_failed_http_{takeover.status}"
                loop_results.append(attempt)
                break

            release = http_json("POST", f"{api_url}/sessions/{session_id}/release", token=token, body={})
            attempt["release"] = {
                "status": release.status,
                "body": release.json_body,
                "raw": release.body_text,
            }
            if release.status != 200:
                loops_ok = False
                attempt["error"] = f"release_failed_http_{release.status}"
                loop_results.append(attempt)
                break
            loop_results.append(attempt)

        write_json(run_dir / "takeover_release_loops.json", loop_results)
        summary["checks"]["takeover_release_loop"] = loops_ok
        if not loops_ok:
            raise RuntimeError("Takeover/release loop did not complete successfully")

        summary["result"] = "PASS"
        summary["completed_at"] = utc_now()
        write_json(run_dir / "summary.json", summary)
        log("Batch A PASS", run_log)
        return 0

    except Exception as exc:  # noqa: BLE001
        summary["result"] = "FAIL"
        summary["error"] = str(exc)
        summary["completed_at"] = utc_now()
        write_json(run_dir / "summary.json", summary)
        log(f"Batch A FAIL: {exc}", run_log)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
