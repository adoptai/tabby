#!/usr/bin/env python3
"""
E2E Smoke Test Orchestrator — Full Credential Delivery Chain

Tests the complete flow:
  Enhanced Test Harness → Worker Login/OTP → HITL (mock) → Artifact Extraction
  → MinIO Encrypt/Upload → API Decrypt → Agent Credential Request → Verification

Usage:
  python3 e2e_smoke_test/orchestrator.py [--api-url URL] [--hitl-mode mock|manual|api]
                                          [--scenarios A,B,C,D,E,F,G] [--timeout SECS]

Environment:
  API_URL          - API base URL (default: http://localhost:8080)
  ADMIN_EMAIL      - Admin login email (default: admin@browser-hitl.local)
  ADMIN_PASSWORD   - Admin login password (default: e2e-admin-password)
  CREDENTIAL_REF   - Worker credential reference (default: k8s:secret/e2e-smoke-creds)
  HITL_MODE        - mock, manual, or api (default: mock)
  DATABASE_URL     - Postgres connection for canary bypass
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

# Add helpers to path
sys.path.insert(0, str(Path(__file__).parent))
from helpers.http_client import http_json, write_json


# ============================================================
# Configuration
# ============================================================

def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="E2E Smoke Test Orchestrator")
    p.add_argument("--api-url", default=os.getenv("API_URL", "http://localhost:8080"))
    p.add_argument("--admin-email", default=os.getenv("ADMIN_EMAIL", "admin@browser-hitl.local"))
    p.add_argument("--admin-password", default=os.getenv("ADMIN_PASSWORD", "e2e-admin-password"))
    p.add_argument("--credential-ref", default=os.getenv("CREDENTIAL_REF", "k8s:secret/e2e-smoke-creds"))
    p.add_argument("--hitl-mode", default=os.getenv("HITL_MODE", "mock"),
                    choices=["mock", "manual", "api"])
    p.add_argument("--scenarios", default="A", help="Comma-separated scenario categories")
    p.add_argument("--timeout", type=int, default=300, help="Session wait timeout seconds")
    p.add_argument("--evidence-dir", default=None, help="Override evidence output directory")
    p.add_argument("--streaming-mode", default=os.getenv("STREAMING_MODE", "vnc"),
                    choices=["vnc", "cdp"], help="Streaming mode for browser observation")
    return p.parse_args()


# ============================================================
# Helpers
# ============================================================

def check(label: str, condition: bool, summary: Dict, detail: str = "") -> None:
    """Record a check result and print status."""
    summary.setdefault("checks", {})
    summary["checks"][label] = condition
    status = "PASS" if condition else "FAIL"
    msg = f"  [{status}] {label}"
    if detail:
        msg += f" — {detail}"
    print(msg)
    if not condition:
        summary.setdefault("failures", [])
        summary["failures"].append({"check": label, "detail": detail})


def poll_session_state(
    api_url: str,
    token: str,
    app_id: str,
    target_states: List[str],
    timeout: int,
    run_dir: Path,
) -> Optional[Dict[str, Any]]:
    """Poll sessions until one matches target_states or timeout."""
    deadline = time.time() + timeout
    poll = 0
    while time.time() < deadline:
        poll += 1
        res = http_json("GET", f"{api_url}/sessions?limit=200&offset=0", token=token)
        if poll <= 5 or poll % 10 == 0:
            write_json(run_dir / f"sessions_poll_{poll:03d}.json", res)
        if res.get("status") == 200 and isinstance(res.get("body"), dict):
            rows = res["body"].get("data") or []
            for r in rows:
                if isinstance(r, dict) and r.get("app_id") == app_id:
                    state = str(r.get("state", ""))
                    if state in target_states:
                        write_json(run_dir / f"session_found_{poll:03d}.json", r)
                        return r
                    if poll % 6 == 0:
                        print(f"    ... session state: {state} (waiting for {target_states})")
        time.sleep(5)
    return None


# ============================================================
# Phase 0: Preflight
# ============================================================

def phase_preflight(api_url: str, summary: Dict, run_dir: Path) -> None:
    print("\n=== PHASE 0: PREFLIGHT ===")
    health = http_json("GET", f"{api_url}/health/live")
    write_json(run_dir / "preflight_health.json", health)
    check("api_healthy", health.get("status") == 200, summary,
          f"HTTP {health.get('status')}")


# ============================================================
# Phase 1: Setup
# ============================================================

def phase_setup(
    api_url: str,
    admin_email: str,
    admin_password: str,
    credential_ref: str,
    summary: Dict,
    run_dir: Path,
    streaming_mode: str = "vnc",
) -> Dict[str, Any]:
    """Returns dict with token, app_id, profile_db_id, tenant_id, client_id, client_secret."""
    print("\n=== PHASE 1: SETUP ===")
    ctx: Dict[str, Any] = {}

    # Step 2: Admin login
    login = http_json("POST", f"{api_url}/login",
                       body={"email": admin_email, "password": admin_password})
    write_json(run_dir / "01_login.json", login)
    token = ((login.get("body") or {}) if isinstance(login.get("body"), dict) else {}).get("token")
    check("admin_login", login.get("status") == 200 and bool(token), summary,
          f"HTTP {login.get('status')}")
    if not token:
        raise RuntimeError(f"Admin login failed: {login}")
    ctx["token"] = str(token)
    # Decode JWT payload to extract tenant_id (it's not in the response body)
    try:
        jwt_parts = str(token).split(".")
        payload_b64 = jwt_parts[1] + "=" * (4 - len(jwt_parts[1]) % 4)
        jwt_payload = json.loads(base64.b64decode(payload_b64))
        ctx["tenant_id"] = str(jwt_payload.get("tenant_id", ""))
    except Exception:
        ctx["tenant_id"] = ""
    print(f"  Tenant ID: {ctx['tenant_id']}")

    # Step 3: Create application with enhanced test-harness config
    app_payload = {
        "name": f"e2e-smoke-{dt.datetime.now(dt.timezone.utc).strftime('%H%M%S')}",
        "target_urls": ["https://test-harness.internal:8000"],
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
                    "body_contains": '"authenticated":true',
                },
            ],
            "policy": "all",
        },
        "export_policy": {
            "artifact_types": ["cookies", "headers", "csrf_token", "local_storage", "session_storage"],
            "header_allowlist": ["authorization", "x-csrf-token", "x-instance-url", "x-api-session-id"],
            "encryption": {"algo": "AES-256-GCM", "key_version": "v1"},
            "ttl_seconds": 3600,
        },
        "notification_config": {"channels": ["slack:#e2e-smoke-test"]},
        "desired_session_count": 0,
        "browser_policy": {"downloads": False, "clipboard": False, "file_chooser": False, "streaming_mode": streaming_mode},
    }
    write_json(run_dir / "02_create_app_payload.json", app_payload)
    create_app = http_json("POST", f"{api_url}/apps", token=ctx["token"], body=app_payload)
    write_json(run_dir / "02_create_app_response.json", create_app)
    app_id = ((create_app.get("body") or {}) if isinstance(create_app.get("body"), dict) else {}).get("app_id")
    check("app_created", create_app.get("status") in (200, 201) and bool(app_id), summary,
          f"HTTP {create_app.get('status')}")
    if not app_id:
        raise RuntimeError(f"App creation failed: {create_app}")
    ctx["app_id"] = str(app_id)

    # Step 4: Create service profile (unique version per run to avoid duplicate key)
    run_version = dt.datetime.now(dt.timezone.utc).strftime("%H.%M.%S")
    profile_payload = {
        "profile_id": "e2e-smoke-test",
        "app_id": ctx["app_id"],
        "version": run_version,
        "login_config": app_payload["login_config"],
        "credential_types": {
            "cookies": [
                {"name": "test_session", "volatility": "STABLE"},
                {"name": "csrf_session", "volatility": "VOLATILE"},
            ],
            "headers": [
                {"name": "Authorization", "volatility": "SEMI_STABLE"},
                {"name": "X-CSRF-Token", "volatility": "VOLATILE"},
                {"name": "X-Instance-Url", "volatility": "STABLE"},
            ],
            "csrf": {"header_name": "X-CSRF-Token", "volatility": "VOLATILE"},
        },
        "target_domains": ["test-harness"],
    }
    write_json(run_dir / "03_create_profile_payload.json", profile_payload)
    create_profile = http_json("POST", f"{api_url}/admin/profiles", token=ctx["token"],
                                body=profile_payload)
    write_json(run_dir / "03_create_profile_response.json", create_profile)
    profile_body = create_profile.get("body") or {}
    profile_db_id = profile_body.get("id") if isinstance(profile_body, dict) else None
    check("profile_created", create_profile.get("status") in (200, 201) and bool(profile_db_id),
          summary, f"HTTP {create_profile.get('status')}")
    if not profile_db_id:
        raise RuntimeError(f"Profile creation failed: {create_profile}")
    ctx["profile_db_id"] = str(profile_db_id)

    # Step 5: Promote STAGING → CANARY
    promote1 = http_json("POST", f"{api_url}/admin/profiles/{ctx['profile_db_id']}/promote",
                          token=ctx["token"])
    write_json(run_dir / "04_promote_canary.json", promote1)
    check("promote_canary", promote1.get("status") == 200, summary,
          f"HTTP {promote1.get('status')}")

    # Step 6: Bypass canary gate via kubectl exec into postgres pod
    print("  Bypassing canary gate (direct DB update via kubectl exec)...")
    pg_pod = os.getenv("PG_POD", "browser-hitl-postgres-0")
    pg_ns = os.getenv("PG_NAMESPACE", "browser-hitl")
    sql = f"UPDATE service_profiles SET canary_request_count = 5, canary_error_count = 0 WHERE id = '{ctx['profile_db_id']}' RETURNING id, version_state, canary_request_count;"
    try:
        result = subprocess.run(
            ["kubectl", "exec", pg_pod, "-n", pg_ns, "--",
             "psql", "-U", "browser_hitl", "-d", "browser_hitl", "-c", sql],
            capture_output=True, text=True, timeout=15,
        )
        check("canary_bypass", result.returncode == 0 and "UPDATE" in result.stdout, summary,
              result.stdout.strip()[:200] or result.stderr.strip()[:200])
    except Exception as e:
        check("canary_bypass", False, summary, str(e))

    # Step 7: Promote CANARY → ACTIVE
    promote2 = http_json("POST", f"{api_url}/admin/profiles/{ctx['profile_db_id']}/promote",
                          token=ctx["token"])
    write_json(run_dir / "05_promote_active.json", promote2)
    check("promote_active", promote2.get("status") == 200, summary,
          f"HTTP {promote2.get('status')}")

    # Step 8: Register agent client
    agent_payload = {
        "name": "e2e-smoke-agent",
        "tenant_id": ctx["tenant_id"],
        "allowed_profiles": ["e2e-smoke-test"],
        "token_ttl_seconds": 3600,
        "rate_limit_per_minute": 60,
    }
    write_json(run_dir / "06_register_agent_payload.json", agent_payload)
    reg = http_json("POST", f"{api_url}/admin/agent-clients", token=ctx["token"],
                     body=agent_payload)
    write_json(run_dir / "06_register_agent_response.json", reg)
    reg_body = reg.get("body") or {}
    client_id = reg_body.get("client_id") if isinstance(reg_body, dict) else None
    client_secret = reg_body.get("client_secret") if isinstance(reg_body, dict) else None
    check("agent_registered", reg.get("status") in (200, 201) and bool(client_id), summary,
          f"HTTP {reg.get('status')}")
    if not client_id or not client_secret:
        raise RuntimeError(f"Agent registration failed: {reg}")
    ctx["client_id"] = str(client_id)
    ctx["client_secret"] = str(client_secret)

    summary["app_id"] = ctx["app_id"]
    summary["profile_db_id"] = ctx["profile_db_id"]
    summary["tenant_id"] = ctx["tenant_id"]
    return ctx


# ============================================================
# Phase 2: Session Bootstrap
# ============================================================

def phase_session_bootstrap(
    api_url: str,
    ctx: Dict[str, Any],
    hitl_mode: str,
    timeout: int,
    summary: Dict,
    run_dir: Path,
) -> Optional[subprocess.Popen]:
    """Scale session, start mock HITL, wait for HEALTHY. Returns mock HITL process."""
    print("\n=== PHASE 2: SESSION BOOTSTRAP ===")
    mock_proc = None

    # Step 9: Launch mock HITL if needed
    if hitl_mode == "mock":
        print("  Starting mock HITL auto-responder...")
        mock_script = Path(__file__).parent / "mock-hitl" / "auto-responder.js"
        log_file = str(run_dir / "mock_hitl.log")
        mock_proc = subprocess.Popen(
            ["node", str(mock_script)],
            env={
                **os.environ,
                "NATS_URL": os.getenv("NATS_URL", "nats://localhost:4222"),
                "REDIS_URL": os.getenv("REDIS_URL", "redis://localhost:16379"),
                "OTP_VALUE": "123456",
                "LOG_FILE": log_file,
                "FAILURE_MODE": "none",
            },
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        time.sleep(2)  # Let it connect
        check("mock_hitl_started", mock_proc.poll() is None, summary,
              f"PID {mock_proc.pid}")
    elif hitl_mode == "api":
        print("  Using API-based OTP injection (polling)...")
    else:
        print("  Manual HITL mode — waiting for human OTP via Slack...")

    # Step 10: Scale to 1 session
    scale = http_json("POST", f"{api_url}/apps/{ctx['app_id']}/sessions/scale",
                       token=ctx["token"], body={"desired_sessions": 1})
    write_json(run_dir / "07_scale.json", scale)
    check("scaled_to_1", scale.get("status") == 200, summary,
          f"HTTP {scale.get('status')}")

    # API-based HITL: poll for LOGIN_IN_PROGRESS and inject OTP
    if hitl_mode == "api":
        print("  Polling for OTP-needed sessions...")
        _api_hitl_inject(api_url, ctx, timeout, run_dir, summary)

    if hitl_mode == "manual":
        print("\n  === MANUAL HITL MODE ===")
        print(f"  App ID: {ctx['app_id']}")
        print(f"  In Slack channel, send:  OTP <session_id> 123456")
        print(f"  Waiting up to {timeout}s for session HEALTHY...\n")

    # Step 11: Wait for HEALTHY
    print(f"  Waiting for session HEALTHY (timeout {timeout}s)...")
    session = poll_session_state(api_url, ctx["token"], ctx["app_id"],
                                  ["HEALTHY"], timeout, run_dir)
    check("session_healthy", session is not None, summary,
          f"state={session.get('state') if session else 'TIMEOUT'}")
    if session:
        ctx["session_id"] = str(session.get("id", ""))
        summary["session_id"] = ctx["session_id"]
    else:
        # Check if session exists but in different state
        failed = poll_session_state(api_url, ctx["token"], ctx["app_id"],
                                     ["FAILED", "TERMINATED", "LOGIN_NEEDED",
                                      "LOGIN_IN_PROGRESS", "STARTING"], 5, run_dir)
        if failed:
            summary["session_final_state"] = failed.get("state")
            print(f"  Session stuck in: {failed.get('state')}")
        raise RuntimeError("Session did not reach HEALTHY state")

    return mock_proc


def _api_hitl_inject(
    api_url: str, ctx: Dict, timeout: int, run_dir: Path, summary: Dict,
) -> None:
    """Background polling to inject OTP via API when session needs it."""
    import threading

    def _poll():
        deadline = time.time() + timeout
        injected = set()
        while time.time() < deadline:
            try:
                res = http_json("GET", f"{api_url}/sessions?limit=200&offset=0",
                                token=ctx["token"])
                if res.get("status") == 200 and isinstance(res.get("body"), dict):
                    for s in (res["body"].get("data") or []):
                        sid = s.get("id", "")
                        state = s.get("state", "")
                        if (s.get("app_id") == ctx["app_id"]
                            and state in ("LOGIN_IN_PROGRESS", "LOGIN_NEEDED")
                            and sid not in injected):
                            otp_res = http_json(
                                "POST", f"{api_url}/hitl/{sid}/otp",
                                token=ctx["token"],
                                body={"otp_value": "123456"},
                            )
                            write_json(run_dir / f"api_otp_inject_{sid[:8]}.json", otp_res)
                            print(f"    [API HITL] Injected OTP for {sid[:8]} → HTTP {otp_res.get('status')}")
                            injected.add(sid)
            except Exception:
                pass
            time.sleep(3)

    t = threading.Thread(target=_poll, daemon=True)
    t.start()


# ============================================================
# Phase 3: Agent Credential Delivery
# ============================================================

def phase_credential_delivery(
    api_url: str,
    ctx: Dict[str, Any],
    summary: Dict,
    run_dir: Path,
) -> Dict[str, Any]:
    """Request credentials as agent, return envelope."""
    print("\n=== PHASE 3: AGENT CREDENTIAL DELIVERY ===")

    # Step 12: Get agent JWT
    agent_token_res = http_json("POST", f"{api_url}/auth/agent-token", body={
        "client_id": ctx["client_id"],
        "client_secret": ctx["client_secret"],
        "grant_type": "client_credentials",
    })
    write_json(run_dir / "08_agent_token.json", agent_token_res)
    agent_body = agent_token_res.get("body") or {}
    agent_token = (agent_body.get("access_token") or agent_body.get("token")) if isinstance(agent_body, dict) else None
    check("agent_token", agent_token_res.get("status") == 200 and bool(agent_token),
          summary, f"HTTP {agent_token_res.get('status')}")
    if not agent_token:
        raise RuntimeError(f"Agent token failed: {agent_token_res}")
    ctx["agent_token"] = str(agent_token)

    # Step 13: Request credentials
    cred_res = http_json("POST", f"{api_url}/credentials/request",
                          token=ctx["agent_token"],
                          body={"profile_id": "e2e-smoke-test"})
    write_json(run_dir / "09_credential_request.json", cred_res)
    envelope = cred_res.get("body") or {}
    check("credential_request", cred_res.get("status") == 200, summary,
          f"HTTP {cred_res.get('status')}")

    # Step 14: Validate envelope structure
    if isinstance(envelope, dict):
        creds = envelope.get("credentials") or {}
        cookies = creds.get("cookies") or []
        headers_list = creds.get("headers") or []
        csrf = creds.get("csrf") or {}
        freshness = envelope.get("freshness", "")
        usage = envelope.get("usage") or {}
        metadata = envelope.get("metadata") or {}

        check("envelope_has_freshness", freshness in ("CACHED", "EXTRACTED", "ON_DEMAND", "DEGRADED"),
              summary, f"freshness={freshness}")
        check("envelope_has_cookies", len(cookies) > 0, summary,
              f"count={len(cookies)}")

        # Find test_session cookie
        test_session = next((c for c in cookies if c.get("name") == "test_session"), None)
        check("test_session_cookie_present", test_session is not None, summary)
        if test_session:
            check("test_session_has_value", bool(test_session.get("value")), summary,
                  f"len={len(str(test_session.get('value', '')))}")

        check("envelope_has_metadata", bool(metadata.get("extracted_at")), summary,
              f"extracted_at={metadata.get('extracted_at', 'MISSING')}")

        # Store for verification phase
        ctx["envelope"] = envelope
    else:
        check("envelope_valid", False, summary, "body is not a dict")
        ctx["envelope"] = {}

    return envelope


# ============================================================
# Phase 4: Credential Verification
# ============================================================

def phase_credential_verification(
    api_url: str,
    ctx: Dict[str, Any],
    summary: Dict,
    run_dir: Path,
) -> None:
    """Use returned credentials against the test harness."""
    print("\n=== PHASE 4: CREDENTIAL VERIFICATION ===")

    envelope = ctx.get("envelope", {})
    creds = envelope.get("credentials", {})
    cookies = creds.get("cookies", [])

    # Step 15-16: Extract test_session cookie and use it
    test_session = next((c for c in cookies if c.get("name") == "test_session"), None)
    if test_session and test_session.get("value"):
        cookie_value = test_session["value"]
        harness_url = os.getenv("HARNESS_URL", "http://localhost:18000")

        # Call test harness /api/me with the credential-sourced cookie
        me_res = http_json("GET", f"{harness_url}/api/me",
                            extra_headers={"cookie": f"test_session={cookie_value}"})
        write_json(run_dir / "10_credential_verify_me.json", me_res)
        me_body = me_res.get("body") or {}
        is_auth = isinstance(me_body, dict) and me_body.get("authenticated") is True
        check("credential_works_at_harness", is_auth, summary,
              f"HTTP {me_res.get('status')} authenticated={me_body.get('authenticated') if isinstance(me_body, dict) else 'N/A'}")
    else:
        check("credential_works_at_harness", False, summary, "No test_session cookie in envelope")

    # Step 17: Force-refresh
    if ctx.get("agent_token"):
        force_res = http_json("POST", f"{api_url}/credentials/request",
                               token=ctx["agent_token"],
                               body={"profile_id": "e2e-smoke-test", "force_refresh": True})
        write_json(run_dir / "11_force_refresh.json", force_res)
        force_body = force_res.get("body") or {}
        force_freshness = force_body.get("freshness", "") if isinstance(force_body, dict) else ""
        check("force_refresh", force_res.get("status") == 200, summary,
              f"freshness={force_freshness}")


# ============================================================
# Scenario Categories
# ============================================================

def scenario_b_hitl_variations(api_url: str, ctx: Dict, summary: Dict, run_dir: Path) -> None:
    """Category B: HITL failure modes (wrong OTP, timeout, delayed)."""
    print("\n=== SCENARIO B: HITL VARIATIONS ===")
    print("  [SKIP] B1-B3 require separate session lifecycle; run with --scenarios B")
    summary.setdefault("skipped", [])
    summary["skipped"].extend(["B1_delayed_otp", "B2_wrong_otp", "B3_otp_timeout"])


def scenario_c_freshness(api_url: str, ctx: Dict, summary: Dict, run_dir: Path) -> None:
    """Category C: Credential freshness (cached vs extracted)."""
    print("\n=== SCENARIO C: CREDENTIAL FRESHNESS ===")

    if not ctx.get("agent_token"):
        print("  [SKIP] No agent token available")
        return

    # C1: Repeat request should be CACHED
    res1 = http_json("POST", f"{api_url}/credentials/request",
                      token=ctx["agent_token"],
                      body={"profile_id": "e2e-smoke-test"})
    write_json(run_dir / "C1_cached_request.json", res1)
    body1 = res1.get("body") or {}
    freshness1 = body1.get("freshness", "") if isinstance(body1, dict) else ""
    check("C1_cached_freshness", freshness1 == "CACHED", summary,
          f"freshness={freshness1}")

    # C2: Force-refresh should be EXTRACTED
    res2 = http_json("POST", f"{api_url}/credentials/request",
                      token=ctx["agent_token"],
                      body={"profile_id": "e2e-smoke-test", "force_refresh": True})
    write_json(run_dir / "C2_force_refresh.json", res2)
    body2 = res2.get("body") or {}
    freshness2 = body2.get("freshness", "") if isinstance(body2, dict) else ""
    check("C2_force_extracted", freshness2 in ("EXTRACTED", "ON_DEMAND"), summary,
          f"freshness={freshness2}")

    # C3: include_volatile=false
    res3 = http_json("POST", f"{api_url}/credentials/request",
                      token=ctx["agent_token"],
                      body={"profile_id": "e2e-smoke-test", "include_volatile": False})
    write_json(run_dir / "C3_no_volatile.json", res3)
    body3 = res3.get("body") or {}
    if isinstance(body3, dict):
        creds3 = body3.get("credentials", {})
        cookies3 = creds3.get("cookies", [])
        volatile_cookies = [c for c in cookies3 if c.get("volatility") == "VOLATILE"]
        check("C3_no_volatile_cookies", len(volatile_cookies) == 0, summary,
              f"volatile_cookie_count={len(volatile_cookies)}")


def scenario_f_cdp_mode(api_url: str, ctx: Dict, summary: Dict, run_dir: Path) -> None:
    """Category F: CDP streaming mode assertions."""
    print("\n=== SCENARIO F: CDP MODE ===")

    session_id = ctx.get("session_id")
    token = ctx.get("token")
    if not session_id or not token:
        print("  [SKIP] No session available")
        return

    # F1: Worker pod has 1 container (no noVNC sidecar) in CDP mode
    try:
        result = subprocess.run(
            ["kubectl", "get", "pod", f"worker-{session_id.lower()}", "-n",
             os.getenv("PG_NAMESPACE", "browser-hitl"),
             "-o", "jsonpath={.spec.containers[*].name}"],
            capture_output=True, text=True, timeout=10,
        )
        containers = result.stdout.strip().split()
        check("F1_cdp_no_sidecar", "novnc" not in containers and len(containers) == 1,
              summary, f"containers={containers}")
    except Exception as e:
        check("F1_cdp_no_sidecar", False, summary, str(e))

    # F2: CDP relay service exists
    try:
        result = subprocess.run(
            ["kubectl", "get", "svc", f"worker-{session_id.lower()}-cdp", "-n",
             os.getenv("PG_NAMESPACE", "browser-hitl"),
             "-o", "jsonpath={.spec.ports[0].port}"],
            capture_output=True, text=True, timeout=10,
        )
        cdp_port = result.stdout.strip()
        check("F2_cdp_service_exists", cdp_port == "9223", summary,
              f"port={cdp_port}")
    except Exception as e:
        check("F2_cdp_service_exists", False, summary, str(e))

    # F3: GET /cdp/{sessionId} returns HTML viewer
    stream_res = http_json("GET", f"{api_url}/hitl/{session_id}/stream-url", token=token)
    write_json(run_dir / "F3_cdp_stream_url.json", stream_res)
    stream_body = stream_res.get("body") or {}
    stream_url = stream_body.get("url", "") if isinstance(stream_body, dict) else ""
    check("F3_cdp_viewer_url", "/cdp/" in stream_url, summary,
          f"url={'...' + stream_url[-40:] if len(stream_url) > 40 else stream_url}")

    # F4: Check streaming_mode label on pod
    try:
        result = subprocess.run(
            ["kubectl", "get", "pod", f"worker-{session_id.lower()}", "-n",
             os.getenv("PG_NAMESPACE", "browser-hitl"),
             "-o", "jsonpath={.metadata.labels.streaming-mode}"],
            capture_output=True, text=True, timeout=10,
        )
        mode_label = result.stdout.strip()
        check("F4_streaming_mode_label", mode_label == "cdp", summary,
              f"label={mode_label}")
    except Exception as e:
        check("F4_streaming_mode_label", False, summary, str(e))


def scenario_e_security(api_url: str, ctx: Dict, summary: Dict, run_dir: Path) -> None:
    """Category E: Security tests."""
    print("\n=== SCENARIO E: SECURITY ===")

    # E1: Invalid profile for this agent
    if ctx.get("agent_token"):
        res = http_json("POST", f"{api_url}/credentials/request",
                          token=ctx["agent_token"],
                          body={"profile_id": "nonexistent-profile-xyz"})
        write_json(run_dir / "E1_wrong_profile.json", res)
        check("E1_wrong_profile_rejected", res.get("status") in (403, 404), summary,
              f"HTTP {res.get('status')}")

    # E2: Invalid JWT
    res2 = http_json("POST", f"{api_url}/credentials/request",
                      token="invalid-jwt-token-abc123",
                      body={"profile_id": "e2e-smoke-test"})
    write_json(run_dir / "E2_invalid_jwt.json", res2)
    check("E2_invalid_jwt_rejected", res2.get("status") == 401, summary,
          f"HTTP {res2.get('status')}")

    # E3: No session (scale to 0, request, scale back)
    # Skip if we don't want to disrupt the running session
    print("  [SKIP] E3 (no healthy session) — would disrupt active session")
    summary.setdefault("skipped", [])
    summary["skipped"].append("E3_no_healthy_session")


# ============================================================
# Phase 5: Cleanup
# ============================================================

def phase_cleanup(
    api_url: str,
    ctx: Dict[str, Any],
    mock_proc: Optional[subprocess.Popen],
    summary: Dict,
    run_dir: Path,
) -> None:
    """Scale down, stop mock HITL, write summary."""
    print("\n=== PHASE 5: CLEANUP ===")

    # Scale to 0
    if ctx.get("app_id") and ctx.get("token"):
        try:
            scale = http_json("POST", f"{api_url}/apps/{ctx['app_id']}/sessions/scale",
                               token=ctx["token"], body={"desired_sessions": 0})
            print(f"  Scaled to 0: HTTP {scale.get('status')}")
        except Exception as e:
            print(f"  Scale-down failed: {e}")

    # Stop mock HITL
    if mock_proc and mock_proc.poll() is None:
        mock_proc.terminate()
        try:
            mock_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            mock_proc.kill()
        print(f"  Mock HITL stopped (PID {mock_proc.pid})")


# ============================================================
# Main
# ============================================================

def main() -> int:
    args = parse_args()
    api_url = args.api_url.rstrip("/")
    scenarios = set(args.scenarios.upper().split(","))

    run_id = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    if args.evidence_dir:
        run_dir = Path(args.evidence_dir)
    else:
        run_dir = Path(__file__).parent / "results" / f"run_{run_id}"
    run_dir.mkdir(parents=True, exist_ok=True)

    streaming_mode = args.streaming_mode
    summary: Dict[str, Any] = {
        "started_at": utc_now(),
        "api_url": api_url,
        "hitl_mode": args.hitl_mode,
        "streaming_mode": streaming_mode,
        "scenarios": sorted(scenarios),
    }

    ctx: Dict[str, Any] = {}
    mock_proc = None

    try:
        # Phase 0: Preflight
        phase_preflight(api_url, summary, run_dir)

        # Phase 1: Setup
        ctx = phase_setup(api_url, args.admin_email, args.admin_password,
                          args.credential_ref, summary, run_dir,
                          streaming_mode=streaming_mode)

        # Phase 2: Session Bootstrap
        mock_proc = phase_session_bootstrap(api_url, ctx, args.hitl_mode,
                                             args.timeout, summary, run_dir)

        # Phase 3: Agent Credential Delivery
        phase_credential_delivery(api_url, ctx, summary, run_dir)

        # Phase 4: Credential Verification
        phase_credential_verification(api_url, ctx, summary, run_dir)

        # Additional scenario categories
        if "C" in scenarios:
            scenario_c_freshness(api_url, ctx, summary, run_dir)
        if "E" in scenarios:
            scenario_e_security(api_url, ctx, summary, run_dir)
        if "B" in scenarios:
            scenario_b_hitl_variations(api_url, ctx, summary, run_dir)
        if "F" in scenarios or streaming_mode == "cdp":
            scenario_f_cdp_mode(api_url, ctx, summary, run_dir)

        # Determine overall result
        checks = summary.get("checks", {})
        failures = [k for k, v in checks.items() if not v]
        if failures:
            summary["result"] = "FAIL"
            summary["failure_count"] = len(failures)
            print(f"\n{'='*60}")
            print(f"RESULT: FAIL ({len(failures)} failures)")
            for f in failures:
                print(f"  - {f}")
        else:
            summary["result"] = "PASS"
            print(f"\n{'='*60}")
            print(f"RESULT: PASS ({len(checks)} checks passed)")

    except Exception as exc:
        summary["result"] = "ERROR"
        summary["error"] = str(exc)
        print(f"\n{'='*60}")
        print(f"RESULT: ERROR — {exc}")
        import traceback
        traceback.print_exc()

    finally:
        summary["completed_at"] = utc_now()
        phase_cleanup(api_url, ctx, mock_proc, summary, run_dir)
        write_json(run_dir / "summary.json", summary)
        print(f"\nEvidence written to: {run_dir}")
        print(f"Summary: {run_dir / 'summary.json'}")

    return 0 if summary.get("result") == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
