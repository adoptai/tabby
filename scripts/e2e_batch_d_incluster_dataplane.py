#!/usr/bin/env python3
"""
Batch D in-cluster data-plane validator:
1) Create app/session in live cluster
2) Verify worker-side Playwright traffic allows allowlisted host
3) Verify worker-side Playwright traffic denies non-allowlisted host
4) Update target_urls and verify previously denied host is allowed
5) Scale down and verify session allowlist cleanup

Writes evidence artifacts under implementation_tracker/phase_3/evidence.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import shlex
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, Optional
from urllib import error, parse, request


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def log(message: str, run_log: Path) -> None:
    line = f"[{utc_now()}] {message}"
    print(line, flush=True)
    with run_log.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def http_json(
    method: str,
    url: str,
    token: Optional[str] = None,
    body: Optional[Dict[str, Any]] = None,
    timeout: int = 20,
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


def session_allowlist_entry(payload: Dict[str, Any], session_id: str) -> Optional[list[str]]:
    body = payload.get("body")
    if not isinstance(body, dict):
        return None
    sessions = body.get("sessions")
    if not isinstance(sessions, dict):
        return None
    values = sessions.get(session_id)
    if isinstance(values, list):
        return [str(v) for v in values]
    return None


def extract_host(url: str) -> str:
    parsed = parse.urlparse(url)
    return parsed.hostname or ""


def run_worker_playwright_probe(
    namespace: str,
    pod_name: str,
    container: str,
    url: str,
    proxy_url: str,
) -> Dict[str, Any]:
    probe_js = r"""
const { chromium } = require('playwright');
(async () => {
  const target = process.env.PROBE_URL;
  const proxy = process.env.PROBE_PROXY;
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', `--proxy-server=${proxy}`],
  });
  const page = await browser.newPage();
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 25000 });
    console.log(JSON.stringify({ ok: true, title: await page.title(), url: page.url() }));
  } catch (err) {
    console.log(JSON.stringify({ ok: false, error: String(err) }));
    process.exitCode = 2;
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.log(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(3);
});
""".strip()

    shell_cmd = (
        "cd /app/apps/worker && "
        f"PROBE_URL={shlex.quote(url)} "
        f"PROBE_PROXY={shlex.quote(proxy_url)} "
        f"node -e {shlex.quote(probe_js)}"
    )

    proc = subprocess.run(
        [
            "kubectl",
            "-n",
            namespace,
            "exec",
            pod_name,
            "-c",
            container,
            "--",
            "sh",
            "-lc",
            shell_cmd,
        ],
        check=False,
        capture_output=True,
        text=True,
    )

    parsed_json: Optional[Dict[str, Any]] = None
    for line in reversed(proc.stdout.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            loaded = json.loads(line)
            if isinstance(loaded, dict):
                parsed_json = loaded
                break
        except json.JSONDecodeError:
            continue

    return {
        "cmd": shell_cmd,
        "exit_code": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "probe": parsed_json,
    }


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent

    api_url = os.getenv("API_URL", "http://localhost:18080").rstrip("/")
    egress_allowlist_url = os.getenv("EGRESS_ALLOWLIST_URL", "http://localhost:18095/allowlist")
    admin_email = os.getenv("ADMIN_EMAIL", "admin@browser-hitl.local")
    admin_password = os.getenv("ADMIN_PASSWORD", "e2e-admin-password")
    app_name = os.getenv(
        "BATCH_D_APP_NAME",
        f"batch-d-dataplane-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d%H%M%S')}",
    )
    allow_url = os.getenv("BATCH_D_ALLOW_URL", "https://example.com")
    blocked_url = os.getenv("BATCH_D_BLOCKED_URL", "https://httpbin.org/get")
    proxy_url = os.getenv("BATCH_D_PROXY_URL", "http://browser-hitl-egress-proxy:3128")
    namespace = os.getenv("BATCH_D_NAMESPACE", "browser-hitl")
    worker_container = os.getenv("BATCH_D_WORKER_CONTAINER", "worker")
    wait_timeout_seconds = int(os.getenv("BATCH_D_WAIT_TIMEOUT_SECONDS", "360"))
    evidence_root = Path(
        os.getenv("EVIDENCE_ROOT", str(repo_root / "implementation_tracker/phase_3/evidence"))
    )

    allow_host = extract_host(allow_url)
    blocked_host = extract_host(blocked_url)

    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = evidence_root / f"batch_d_dataplane_{timestamp}"
    ensure_dir(run_dir)
    run_log = run_dir / "run.log"

    summary: Dict[str, Any] = {
        "started_at": utc_now(),
        "api_url": api_url,
        "egress_allowlist_url": egress_allowlist_url,
        "app_name": app_name,
        "allow_url": allow_url,
        "blocked_url": blocked_url,
        "proxy_url": proxy_url,
        "checks": {},
    }

    log(f"Batch D run directory: {run_dir}", run_log)

    try:
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
        summary["checks"]["login"] = True

        create_payload = {
            "name": app_name,
            "target_urls": [allow_url],
            "login_config": {
                "login_url": allow_url,
                "credential_ref": "k8s:secret/batch-a-creds",
                "steps": [
                    {"action": "goto", "url": allow_url},
                ],
                "otp_prompt": {"method": "chat", "field_selector": "#otp"},
            },
            "keepalive_config": {
                "interval_seconds": 60,
                "actions": [{"action": "goto", "url": allow_url}],
                "health_checks": [{"type": "url_check", "url": allow_url, "expect_status": 200}],
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
        write_json(run_dir / "create_app_payload.json", create_payload)
        create_app = http_json("POST", f"{api_url}/apps", token=token, body=create_payload)
        write_json(run_dir / "create_app_response.json", create_app)
        app_id = ((create_app.get("body") or {}) if isinstance(create_app.get("body"), dict) else {}).get("app_id")
        if create_app.get("status") not in (200, 201) or not app_id:
            raise RuntimeError(f"Create app failed: HTTP {create_app.get('status')}")
        app_id = str(app_id)
        summary["app_id"] = app_id
        summary["checks"]["app_created"] = True

        scale_up = http_json(
            "POST",
            f"{api_url}/apps/{app_id}/sessions/scale",
            token=token,
            body={"desired_sessions": 1},
        )
        write_json(run_dir / "scale_up_response.json", scale_up)
        if scale_up.get("status") != 200:
            raise RuntimeError(f"Scale up failed: HTTP {scale_up.get('status')}")
        summary["checks"]["scale_up_ok"] = True

        deadline = time.time() + wait_timeout_seconds
        poll_count = 0
        session_id: Optional[str] = None
        pod_name: Optional[str] = None
        while time.time() < deadline:
            poll_count += 1
            sessions = http_json("GET", f"{api_url}/sessions?limit=200&offset=0", token=token)
            write_json(run_dir / f"sessions_poll_{poll_count:02d}.json", sessions)
            if sessions.get("status") == 200 and isinstance(sessions.get("body"), dict):
                data = sessions["body"].get("data") or []
                for row in data:
                    if (
                        isinstance(row, dict)
                        and row.get("app_id") == app_id
                        and row.get("state") != "TERMINATED"
                        and row.get("pod_name")
                    ):
                        session_id = str(row.get("id"))
                        pod_name = str(row.get("pod_name"))
                        summary["session_id"] = session_id
                        summary["pod_name"] = pod_name
                        summary["session_state_on_pick"] = row.get("state")
                        log(f"Picked session {session_id} pod={pod_name} state={row.get('state')}", run_log)
                        break
            if session_id and pod_name:
                break
            time.sleep(5)
        if not session_id or not pod_name:
            raise RuntimeError("Timed out waiting for active session with pod")
        summary["checks"]["session_created"] = True

        poll_count = 0
        initial_allowlist: Optional[list[str]] = None
        while time.time() < deadline:
            poll_count += 1
            allowlist = http_json("GET", egress_allowlist_url, timeout=10)
            write_json(run_dir / f"allowlist_initial_poll_{poll_count:02d}.json", allowlist)
            entry = session_allowlist_entry(allowlist, session_id)
            if entry and allow_host in entry and blocked_host not in entry:
                initial_allowlist = entry
                break
            time.sleep(5)
        if not initial_allowlist:
            raise RuntimeError("Timed out waiting for initial allowlist sync")
        summary["initial_allowlist"] = initial_allowlist
        summary["checks"]["initial_allowlist_synced"] = True

        allow_pre = run_worker_playwright_probe(namespace, pod_name, worker_container, allow_url, proxy_url)
        write_json(run_dir / "allow_pre_probe.json", allow_pre)
        if not (allow_pre.get("probe") or {}).get("ok"):
            raise RuntimeError("Allowlisted host probe failed before update")
        summary["checks"]["allowlisted_host_allows_pre_update"] = True

        blocked_pre = run_worker_playwright_probe(namespace, pod_name, worker_container, blocked_url, proxy_url)
        write_json(run_dir / "blocked_pre_probe.json", blocked_pre)
        if (blocked_pre.get("probe") or {}).get("ok"):
            raise RuntimeError("Non-allowlisted host unexpectedly succeeded before update")
        summary["checks"]["blocked_host_denied_pre_update"] = True

        update_payload = {"target_urls": [allow_url, blocked_url]}
        write_json(run_dir / "app_update_payload.json", update_payload)
        update_app = http_json("PUT", f"{api_url}/apps/{app_id}", token=token, body=update_payload)
        write_json(run_dir / "app_update_response.json", update_app)
        if update_app.get("status") != 200:
            raise RuntimeError(f"Update app failed: HTTP {update_app.get('status')}")
        summary["checks"]["app_update_ok"] = True

        poll_count = 0
        updated_allowlist: Optional[list[str]] = None
        while time.time() < deadline:
            poll_count += 1
            allowlist = http_json("GET", egress_allowlist_url, timeout=10)
            write_json(run_dir / f"allowlist_updated_poll_{poll_count:02d}.json", allowlist)
            entry = session_allowlist_entry(allowlist, session_id)
            if entry and allow_host in entry and blocked_host in entry:
                updated_allowlist = entry
                break
            time.sleep(5)
        if not updated_allowlist:
            raise RuntimeError("Timed out waiting for updated allowlist sync")
        summary["updated_allowlist"] = updated_allowlist
        summary["checks"]["updated_allowlist_synced"] = True

        blocked_post = run_worker_playwright_probe(namespace, pod_name, worker_container, blocked_url, proxy_url)
        write_json(run_dir / "blocked_post_probe.json", blocked_post)
        if not (blocked_post.get("probe") or {}).get("ok"):
            raise RuntimeError("Previously blocked host still failing after allowlist update")
        summary["checks"]["blocked_host_allowed_post_update"] = True

        scale_down = http_json(
            "POST",
            f"{api_url}/apps/{app_id}/sessions/scale",
            token=token,
            body={"desired_sessions": 0},
        )
        write_json(run_dir / "scale_down_response.json", scale_down)
        if scale_down.get("status") != 200:
            raise RuntimeError(f"Scale down failed: HTTP {scale_down.get('status')}")
        summary["checks"]["scale_down_ok"] = True

        poll_count = 0
        removed = False
        while time.time() < deadline:
            poll_count += 1
            allowlist = http_json("GET", egress_allowlist_url, timeout=10)
            write_json(run_dir / f"allowlist_cleanup_poll_{poll_count:02d}.json", allowlist)
            entry = session_allowlist_entry(allowlist, session_id)
            if entry is None:
                removed = True
                break
            time.sleep(5)
        if not removed:
            raise RuntimeError("Timed out waiting for allowlist cleanup after scale down")
        summary["checks"]["allowlist_removed_after_scale_down"] = True

        summary["result"] = "PASS"
        summary["completed_at"] = utc_now()
        write_json(run_dir / "summary.json", summary)
        log("Batch D PASS", run_log)
        return 0
    except Exception as exc:  # noqa: BLE001
        summary["result"] = "FAIL"
        summary["error"] = str(exc)
        summary["completed_at"] = utc_now()
        write_json(run_dir / "summary.json", summary)
        log(f"Batch D FAIL: {exc}", run_log)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
