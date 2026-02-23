#!/usr/bin/env python3
"""
Manual Slack HITL scenario runner.

Creates a test-harness app/session that pauses on OTP and waits for human OTP
delivery via Slack soft bridge command:
  OTP <session_id> 123456
"""

from __future__ import annotations

import datetime as dt
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional
from urllib import error, request


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def http_json(
    method: str,
    url: str,
    token: Optional[str] = None,
    body: Optional[Dict[str, Any]] = None,
    timeout: int = 30,
) -> Dict[str, Any]:
    data = None
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    if body is not None:
        data = json.dumps(body).encode("utf-8")

    req = request.Request(url=url, method=method, headers=headers, data=data)
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            parsed: Any = None
            if raw:
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError:
                    parsed = raw
            return {"status": resp.status, "body": parsed, "raw": raw}
    except error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        parsed: Any = None
        if raw:
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                parsed = raw
        return {"status": exc.code, "body": parsed, "raw": raw}


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def pick_active_session(api_url: str, token: str, app_id: str, timeout_seconds: int, run_dir: Path) -> Dict[str, Any]:
    deadline = time.time() + timeout_seconds
    poll = 0
    while time.time() < deadline:
        poll += 1
        sessions = http_json("GET", f"{api_url}/sessions?limit=200&offset=0", token=token)
        write_json(run_dir / f"sessions_poll_{poll:02d}.json", sessions)
        if sessions.get("status") == 200 and isinstance(sessions.get("body"), dict):
            rows = sessions["body"].get("data") or []
            matches = [
                r for r in rows
                if isinstance(r, dict)
                and r.get("app_id") == app_id
                and r.get("state") != "TERMINATED"
            ]
            if matches:
                matches.sort(key=lambda r: str(r.get("started_at", "")), reverse=True)
                return matches[0]
        time.sleep(5)
    raise RuntimeError("Timed out waiting for session creation")


def wait_terminal_state(
    api_url: str,
    token: str,
    session_id: str,
    timeout_seconds: int,
    run_dir: Path,
) -> Dict[str, Any]:
    deadline = time.time() + timeout_seconds
    poll = 0
    while time.time() < deadline:
        poll += 1
        state_res = http_json("GET", f"{api_url}/sessions/{session_id}", token=token)
        write_json(run_dir / f"state_poll_{poll:03d}.json", state_res)
        if state_res.get("status") == 200 and isinstance(state_res.get("body"), dict):
            state = str(state_res["body"].get("state", ""))
            if state in {"HEALTHY", "FAILED", "TERMINATED"}:
                return state_res["body"]
        time.sleep(5)
    raise RuntimeError(f"Timed out waiting for terminal state on session {session_id}")


def main() -> int:
    api_url = os.getenv("API_URL", "http://localhost:18080").rstrip("/")
    admin_email = os.getenv("ADMIN_EMAIL", "admin@browser-hitl.local")
    admin_password = os.getenv("ADMIN_PASSWORD", "e2e-admin-password")
    credential_ref = os.getenv("HITL_CREDENTIAL_REF", "k8s:secret/uat-22-4-creds")
    scenario_timeout = int(os.getenv("HITL_SCENARIO_TIMEOUT_SECONDS", "900"))
    evidence_root = Path(
        os.getenv("EVIDENCE_ROOT", "implementation_tracker/phase_4/evidence"),
    )

    run_id = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = evidence_root / f"manual_slack_hitl_{run_id}"
    run_dir.mkdir(parents=True, exist_ok=True)

    summary: Dict[str, Any] = {"started_at": utc_now(), "api_url": api_url}

    login = http_json(
        "POST",
        f"{api_url}/login",
        body={"email": admin_email, "password": admin_password},
    )
    write_json(run_dir / "login_response.json", login)
    token = ((login.get("body") or {}) if isinstance(login.get("body"), dict) else {}).get("token")
    if login.get("status") != 200 or not token:
        raise RuntimeError(f"Login failed: HTTP {login.get('status')}")
    token = str(token)
    summary["checks"] = {"login": True}

    app_name = f"manual-slack-hitl-{run_id.lower()}"
    create_payload = {
        "name": app_name,
        "target_urls": ["https://example.com"],
        "login_config": {
            "login_url": "http://test-harness:8000/login",
            "credential_ref": credential_ref,
            "steps": [
                {"action": "goto", "url": "http://test-harness:8000/login"},
                {"action": "fill", "selector": "#email", "value": "${USERNAME}"},
                {"action": "fill", "selector": "#password", "value": "${PASSWORD}", "sensitive": True},
                {"action": "click", "selector": "#login-button"},
                {"action": "wait_for", "selector": "#otp", "timeout_ms": 120000, "sensitive": True},
                {"action": "click", "selector": "#otp-submit"},
                {"action": "wait_for", "selector": "#user-menu", "timeout_ms": 30000},
            ],
            "otp_prompt": {"method": "chat", "field_selector": "#otp"},
        },
        "keepalive_config": {
            "interval_seconds": 60,
            "actions": [{"action": "goto", "url": "http://test-harness:8000/dashboard"}],
            "health_checks": [
                {
                    "type": "network_check",
                    "url": "http://test-harness:8000/api/me",
                    "expect_status": 200,
                    "body_contains": "\"authenticated\":true",
                },
            ],
            "policy": "all",
        },
        "export_policy": {
            "artifact_types": ["cookies", "headers", "csrf_token"],
            "encryption": {"algo": "AES-256-GCM", "key_version": "v1"},
            "ttl_seconds": 3600,
        },
        "notification_config": {"channels": ["slack:#tabby-experiments"]},
        "desired_session_count": 1,
        "browser_policy": {"downloads": False, "clipboard": False, "file_chooser": False},
    }
    write_json(run_dir / "create_app_payload.json", create_payload)
    create_app = http_json("POST", f"{api_url}/apps", token=token, body=create_payload)
    write_json(run_dir / "create_app_response.json", create_app)
    app_id = ((create_app.get("body") or {}) if isinstance(create_app.get("body"), dict) else {}).get("app_id")
    if create_app.get("status") not in (200, 201) or not app_id:
        raise RuntimeError(f"Create app failed: HTTP {create_app.get('status')}")
    app_id = str(app_id)
    summary["app_id"] = app_id
    summary["checks"]["app_created"] = True

    scale = http_json(
        "POST",
        f"{api_url}/apps/{app_id}/sessions/scale",
        token=token,
        body={"desired_sessions": 1},
    )
    write_json(run_dir / "scale_response.json", scale)
    if scale.get("status") != 200:
        raise RuntimeError(f"Scale failed: HTTP {scale.get('status')}")
    summary["checks"]["scaled"] = True

    session = pick_active_session(api_url, token, app_id, 300, run_dir)
    session_id = str(session.get("id"))
    summary["session_id"] = session_id

    print("\n=== MANUAL SLACK HITL TEST READY ===")
    print(f"App ID:     {app_id}")
    print(f"Session ID: {session_id}")
    print("In Slack channel, send:")
    print(f"  OTP {session_id} 123456")
    print("Waiting for session to become HEALTHY or FAILED...\n")

    final_state = wait_terminal_state(api_url, token, session_id, scenario_timeout, run_dir)
    state_value = str(final_state.get("state", "UNKNOWN"))
    summary["final_state"] = state_value
    summary["completed_at"] = utc_now()
    summary["result"] = "PASS" if state_value == "HEALTHY" else "FAIL"
    write_json(run_dir / "summary.json", summary)

    print(f"Final state: {state_value}")
    print(f"Evidence dir: {run_dir}")
    return 0 if state_value == "HEALTHY" else 1


if __name__ == "__main__":
    raise SystemExit(main())
