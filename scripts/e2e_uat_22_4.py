#!/usr/bin/env python3
"""
Section 22.4 UAT validator.

Covers expected flows:
1. Register app + scale + verify HEALTHY.
2. Force logout (test-harness), verify HITL escalation and stream access.
3. Takeover + OTP submit + release, verify return to HEALTHY.
4. Verify artifact bundle export record and MinIO object presence.
5. Verify audit events include HITL/export events and hash chain integrity.
6. Verify session recycle behavior by temporarily setting MAX_SESSION_AGE_HOURS=0.
7. Verify non-allowlisted domain is blocked under proxy/network policy.
8. Verify stream URL replay is rejected (single-use token).

Evidence is written under implementation_tracker/phase_3/evidence.
"""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import json
import os
import shlex
import socket
import ssl
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib import error, parse, request


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


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


def run_cmd(cmd: List[str], timeout: int = 60) -> Dict[str, Any]:
    proc = subprocess.run(
        cmd,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return {
        "cmd": cmd,
        "exit_code": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }


def parse_json_stdout(result: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if result.get("exit_code") != 0:
        return None
    raw = str(result.get("stdout", "")).strip()
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if isinstance(parsed, dict):
        return parsed
    return None


def deployment_effectively_ready(deployment: Dict[str, Any]) -> bool:
    metadata = deployment.get("metadata") if isinstance(deployment.get("metadata"), dict) else {}
    spec = deployment.get("spec") if isinstance(deployment.get("spec"), dict) else {}
    status = deployment.get("status") if isinstance(deployment.get("status"), dict) else {}

    generation = int(metadata.get("generation", 0) or 0)
    observed_generation = int(status.get("observedGeneration", 0) or 0)
    desired_replicas = int(spec.get("replicas", 1) or 1)
    updated_replicas = int(status.get("updatedReplicas", 0) or 0)
    available_replicas = int(status.get("availableReplicas", 0) or 0)

    return (
        observed_generation >= generation
        and updated_replicas >= desired_replicas
        and available_replicas >= min(desired_replicas, 1)
    )


def env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def detect_kind_cluster(preferred: str) -> Optional[str]:
    if preferred:
        return preferred
    result = run_cmd(["kind", "get", "clusters"], timeout=20)
    if result["exit_code"] != 0:
        return None
    clusters = [line.strip() for line in result["stdout"].splitlines() if line.strip()]
    if not clusters:
        return None
    if "browser-hitl-phase3" in clusters:
        return "browser-hitl-phase3"
    return clusters[0]


def ensure_test_harness(
    repo_root: Path,
    namespace: str,
    image: str,
    build_image: bool,
    load_into_kind: bool,
    kind_cluster: str,
) -> Dict[str, Any]:
    report: Dict[str, Any] = {"namespace": namespace, "image": image}

    precheck_service = run_cmd(
        ["kubectl", "-n", namespace, "get", "service", "test-harness", "-o", "name"],
        timeout=20,
    )
    precheck_deploy = run_cmd(
        ["kubectl", "-n", namespace, "get", "deployment", "test-harness", "-o", "name"],
        timeout=20,
    )
    report["precheck_service"] = precheck_service
    report["precheck_deployment"] = precheck_deploy

    if build_image:
        build = run_cmd(
            [
                "docker",
                "build",
                "-f",
                str(repo_root / "test-harness/Dockerfile"),
                "-t",
                image,
                str(repo_root / "test-harness"),
            ],
            timeout=900,
        )
        report["docker_build"] = build
        if build["exit_code"] != 0:
            report["ready"] = False
            report["error"] = "docker_build_failed"
            return report

    if load_into_kind:
        cluster_name = detect_kind_cluster(kind_cluster)
        report["kind_cluster"] = cluster_name
        if cluster_name:
            kind_load = run_cmd(
                ["kind", "load", "docker-image", image, "--name", cluster_name],
                timeout=300,
            )
            report["kind_load"] = kind_load
            if kind_load["exit_code"] != 0:
                report["ready"] = False
                report["error"] = "kind_load_failed"
                return report
        else:
            report["kind_load_skipped"] = "kind cluster not detected"

    manifest = f"""apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-harness
  labels:
    app: test-harness
spec:
  replicas: 1
  selector:
    matchLabels:
      app: test-harness
  template:
    metadata:
      labels:
        app: test-harness
    spec:
      containers:
      - name: test-harness
        image: {image}
        imagePullPolicy: IfNotPresent
        env:
        - name: SECRET_KEY
          value: uat-test-harness-secret
        ports:
        - name: http
          containerPort: 8000
        readinessProbe:
          httpGet:
            path: /health
            port: http
          initialDelaySeconds: 2
          periodSeconds: 5
        livenessProbe:
          httpGet:
            path: /health
            port: http
          initialDelaySeconds: 10
          periodSeconds: 10
        resources:
          requests:
            cpu: 50m
            memory: 64Mi
          limits:
            cpu: 250m
            memory: 256Mi
---
apiVersion: v1
kind: Service
metadata:
  name: test-harness
  labels:
    app: test-harness
spec:
  selector:
    app: test-harness
  ports:
  - name: http
    port: 8000
    targetPort: http
"""
    apply_cmd = (
        f"cat <<'EOF' | kubectl -n {shlex.quote(namespace)} apply -f -\n"
        f"{manifest}\n"
        "EOF"
    )
    apply_res = run_cmd(["bash", "-lc", apply_cmd], timeout=120)
    report["kubectl_apply"] = apply_res
    if apply_res["exit_code"] != 0:
        report["ready"] = False
        report["error"] = "kubectl_apply_failed"
        return report

    rollout = run_cmd(
        [
            "kubectl",
            "-n",
            namespace,
            "rollout",
            "status",
            "deployment/test-harness",
            "--timeout=240s",
        ],
        timeout=260,
    )
    report["rollout_status"] = rollout
    report["ready"] = rollout["exit_code"] == 0
    if not report["ready"]:
        report["error"] = "deployment_not_ready"
    return report


def decode_jwt_payload(token: str) -> Dict[str, Any]:
    parts = token.split(".")
    if len(parts) < 2:
        raise ValueError("Invalid JWT format")
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
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


def normalize_stream_url(stream_url: str, api_url: str) -> str:
    stream_parsed = parse.urlparse(stream_url)
    api_parsed = parse.urlparse(api_url)

    if not stream_parsed.scheme or not stream_parsed.netloc:
        return stream_url

    localhost_hosts = {"localhost", "127.0.0.1", "::1"}
    if (
        stream_parsed.hostname in localhost_hosts
        and stream_parsed.port is None
        and api_parsed.hostname in localhost_hosts
        and api_parsed.port is not None
    ):
        return parse.urlunparse(
            (
                api_parsed.scheme or stream_parsed.scheme,
                api_parsed.netloc,
                stream_parsed.path,
                stream_parsed.params,
                stream_parsed.query,
                stream_parsed.fragment,
            )
        )

    return stream_url


def pick_session_for_app(
    api_url: str,
    token: str,
    app_id: str,
    timeout_seconds: int,
    run_dir: Path,
    prefix: str,
) -> Dict[str, Any]:
    deadline = time.time() + timeout_seconds
    poll = 0
    while time.time() < deadline:
        poll += 1
        sessions = http_json("GET", f"{api_url}/sessions?limit=200&offset=0", token=token)
        write_json(run_dir / f"{prefix}_sessions_poll_{poll:02d}.json", sessions)
        if sessions.get("status") == 200 and isinstance(sessions.get("body"), dict):
            rows = sessions["body"].get("data") or []
            candidates = [
                r for r in rows
                if isinstance(r, dict)
                and r.get("app_id") == app_id
                and r.get("state") != "TERMINATED"
                and r.get("pod_name")
            ]
            if candidates:
                candidates.sort(key=lambda r: str(r.get("started_at", "")), reverse=True)
                return candidates[0]
        time.sleep(5)
    raise RuntimeError("Timed out waiting for active session with pod")


def wait_session_state(
    api_url: str,
    token: str,
    session_id: str,
    desired_states: set[str],
    timeout_seconds: int,
    run_dir: Path,
    prefix: str,
) -> Dict[str, Any]:
    deadline = time.time() + timeout_seconds
    poll = 0
    while time.time() < deadline:
        poll += 1
        result = http_json("GET", f"{api_url}/sessions/{session_id}", token=token)
        write_json(run_dir / f"{prefix}_state_poll_{poll:02d}.json", result)
        if result.get("status") == 200 and isinstance(result.get("body"), dict):
            state = str(result["body"].get("state", ""))
            if state in desired_states:
                return result["body"]
        time.sleep(5)
    raise RuntimeError(
        f"Timed out waiting for session {session_id} state in {sorted(desired_states)}"
    )


def wait_for_interventions(
    api_url: str,
    token: str,
    session_id: str,
    timeout_seconds: int,
    run_dir: Path,
    prefix: str,
) -> Dict[str, Any]:
    deadline = time.time() + timeout_seconds
    poll = 0
    while time.time() < deadline:
        poll += 1
        result = http_json(
            "GET",
            f"{api_url}/sessions/{session_id}/interventions?limit=20&offset=0",
            token=token,
        )
        write_json(run_dir / f"{prefix}_interventions_poll_{poll:02d}.json", result)
        if result.get("status") == 200 and isinstance(result.get("body"), dict):
            rows = result["body"].get("data") or []
            if isinstance(rows, list) and len(rows) > 0:
                return result
        time.sleep(5)
    raise RuntimeError("No interventions found after forced logout escalation")


def preflight_scale_down_apps_by_prefix(
    api_url: str,
    token: str,
    app_name_prefix: str,
    run_dir: Path,
    timeout_seconds: int = 300,
) -> Dict[str, Any]:
    report: Dict[str, Any] = {
        "app_name_prefix": app_name_prefix,
        "matched_apps": [],
        "scale_results": [],
        "active_sessions_remaining": [],
        "drain_ok": True,
    }

    apps_res = http_json("GET", f"{api_url}/apps?limit=200&offset=0", token=token)
    report["apps_response"] = apps_res
    if apps_res.get("status") != 200 or not isinstance(apps_res.get("body"), dict):
        report["drain_ok"] = False
        report["error"] = "failed_to_list_apps"
        return report

    apps = apps_res["body"].get("data") or []
    app_ids: List[str] = []
    for app in apps:
        if not isinstance(app, dict):
            continue
        app_id = app.get("id")
        app_name = str(app.get("name", ""))
        if app_id and app_name.startswith(app_name_prefix):
            app_ids.append(str(app_id))
            report["matched_apps"].append({"id": str(app_id), "name": app_name})

    if not app_ids:
        return report

    for app_id in app_ids:
        scale_res = http_json(
            "POST",
            f"{api_url}/apps/{app_id}/sessions/scale",
            token=token,
            body={"desired_sessions": 0},
        )
        report["scale_results"].append({"app_id": app_id, "response": scale_res})

    deadline = time.time() + timeout_seconds
    poll = 0
    remaining: List[Dict[str, Any]] = []
    while time.time() < deadline:
        poll += 1
        sessions_res = http_json("GET", f"{api_url}/sessions?limit=200&offset=0", token=token)
        write_json(run_dir / f"preflight_cleanup_sessions_poll_{poll:02d}.json", sessions_res)
        remaining = []
        if sessions_res.get("status") == 200 and isinstance(sessions_res.get("body"), dict):
            for row in sessions_res["body"].get("data") or []:
                if not isinstance(row, dict):
                    continue
                if str(row.get("app_id", "")) in app_ids and row.get("state") != "TERMINATED":
                    remaining.append(
                        {
                            "id": str(row.get("id", "")),
                            "app_id": str(row.get("app_id", "")),
                            "state": str(row.get("state", "")),
                            "pod_name": str(row.get("pod_name", "") or ""),
                        }
                    )
        if not remaining:
            report["drain_ok"] = True
            report["active_sessions_remaining"] = []
            return report
        time.sleep(5)

    report["drain_ok"] = False
    report["active_sessions_remaining"] = remaining
    report["error"] = "timed_out_waiting_for_app_scale_down"
    return report


def psql_query_tsv(namespace: str, postgres_pod: str, sql: str) -> Dict[str, Any]:
    return run_cmd(
        [
            "kubectl",
            "-n",
            namespace,
            "exec",
            postgres_pod,
            "--",
            "psql",
            "-U",
            "browser_hitl",
            "-d",
            "browser_hitl",
            "-At",
            "-F",
            "\t",
            "-c",
            sql,
        ],
        timeout=60,
    )


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

    proc = run_cmd(
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
        timeout=90,
    )

    parsed_json: Optional[Dict[str, Any]] = None
    for line in reversed(proc["stdout"].splitlines()):
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

    proc["probe"] = parsed_json
    return proc


def verify_hash_chain(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    def canonicalize_with_top_level_replacer(payload: Dict[str, Any]) -> str:
        top_level_keys = sorted(payload.keys())

        def apply_replacer(value: Any) -> Any:
            if isinstance(value, dict):
                transformed: Dict[str, Any] = {}
                for key in top_level_keys:
                    if key in value:
                        transformed[key] = apply_replacer(value[key])
                return transformed
            if isinstance(value, list):
                return [apply_replacer(item) for item in value]
            return value

        transformed_payload = apply_replacer(payload)
        return json.dumps(transformed_payload, separators=(",", ":"), ensure_ascii=False)

    broken: List[Dict[str, Any]] = []
    prev_hash = ""

    for idx, row in enumerate(rows):
        current_prev = row.get("prev_hash") or ""
        if idx > 0 and current_prev != prev_hash:
            broken.append(
                {
                    "sequence_num": row.get("sequence_num"),
                    "reason": "prev_hash_mismatch",
                    "expected_prev_hash": prev_hash,
                    "actual_prev_hash": current_prev,
                }
            )
            prev_hash = row.get("hash") or ""
            continue

        payload = row.get("payload")
        if not isinstance(payload, dict):
            broken.append(
                {
                    "sequence_num": row.get("sequence_num"),
                    "reason": "payload_not_object",
                }
            )
            prev_hash = row.get("hash") or ""
            continue

        canonical = canonicalize_with_top_level_replacer(payload)
        computed = hashlib.sha256(((current_prev or "") + canonical).encode("utf-8")).hexdigest()
        if computed != (row.get("hash") or ""):
            broken.append(
                {
                    "sequence_num": row.get("sequence_num"),
                    "reason": "hash_mismatch",
                    "expected_hash": computed,
                    "actual_hash": row.get("hash"),
                }
            )
        prev_hash = row.get("hash") or ""

    return {
        "ok": len(broken) == 0,
        "broken_links": broken,
        "verified_events": len(rows) - len(broken),
        "total_events": len(rows),
    }


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent

    api_url = os.getenv("API_URL", "http://localhost:18080").rstrip("/")
    admin_email = os.getenv("ADMIN_EMAIL", "admin@browser-hitl.local")
    admin_password = os.getenv("ADMIN_PASSWORD", "e2e-admin-password")
    app_name = os.getenv(
        "UAT_APP_NAME",
        f"uat-22-4-{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d%H%M%S')}",
    )
    cleanup_app_prefix = os.getenv("UAT_CLEANUP_APP_PREFIX", "uat-22-4-")
    namespace = os.getenv("UAT_NAMESPACE", "browser-hitl")
    postgres_pod = os.getenv("UAT_POSTGRES_POD", "browser-hitl-postgres-0")
    minio_pod = os.getenv("UAT_MINIO_POD", "browser-hitl-minio-0")
    controller_deployment = os.getenv("UAT_CONTROLLER_DEPLOYMENT", "browser-hitl-controller")
    worker_container = os.getenv("UAT_WORKER_CONTAINER", "worker")
    proxy_url = os.getenv("UAT_PROXY_URL", "http://browser-hitl-egress-proxy:3128")
    blocked_url = os.getenv("UAT_BLOCKED_URL", "https://httpbin.org/get")
    bootstrap_test_harness = env_bool("UAT_BOOTSTRAP_TEST_HARNESS", True)
    test_harness_image = os.getenv("UAT_TEST_HARNESS_IMAGE", "browser-hitl/test-harness:phase3")
    test_harness_build = env_bool("UAT_TEST_HARNESS_BUILD_IMAGE", True)
    test_harness_kind_load = env_bool("UAT_TEST_HARNESS_KIND_LOAD", True)
    test_harness_kind_cluster = os.getenv("UAT_KIND_CLUSTER", "")
    evidence_root = Path(
        os.getenv("EVIDENCE_ROOT", str(repo_root / "implementation_tracker/phase_3/evidence"))
    )

    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = evidence_root / f"uat_22_4_{timestamp}"
    ensure_dir(run_dir)
    run_log = run_dir / "run.log"

    summary: Dict[str, Any] = {
        "started_at": utc_now(),
        "api_url": api_url,
        "app_name": app_name,
        "namespace": namespace,
        "checks": {},
    }

    log(f"UAT 22.4 run directory: {run_dir}", run_log)

    original_max_session_age = "24"

    try:
        if bootstrap_test_harness:
            log("Ensuring in-cluster test-harness deployment/service", run_log)
            harness_report = ensure_test_harness(
                repo_root=repo_root,
                namespace=namespace,
                image=test_harness_image,
                build_image=test_harness_build,
                load_into_kind=test_harness_kind_load,
                kind_cluster=test_harness_kind_cluster,
            )
            write_json(run_dir / "test_harness_bootstrap.json", harness_report)
            if not harness_report.get("ready"):
                raise RuntimeError("Failed to bootstrap test-harness in cluster")
            summary["checks"]["test_harness_ready"] = True

        # Ensure UAT credential secret exists with known test-harness creds.
        secret_cmd = (
            f"kubectl -n {shlex.quote(namespace)} create secret generic uat-22-4-creds "
            "--from-literal=username=admin@example.com "
            "--from-literal=password=P@ssw0rd12345 "
            "--dry-run=client -o yaml | kubectl apply -f -"
        )
        secret_apply = run_cmd(["bash", "-lc", secret_cmd], timeout=60)
        write_json(run_dir / "secret_apply.json", secret_apply)
        if secret_apply["exit_code"] != 0:
            raise RuntimeError("Failed to create/apply UAT credential secret")
        summary["checks"]["uat_secret_ready"] = True

        # Login
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
        jwt_payload = decode_jwt_payload(token)
        tenant_id = str(jwt_payload.get("tenant_id", ""))
        user_id = str(jwt_payload.get("sub", ""))
        summary["tenant_id"] = tenant_id
        summary["user_id"] = user_id
        summary["checks"]["login"] = True

        # Preflight cleanup for repeated local runs: scale prior UAT apps to zero
        # to avoid stale worker pods consuming all cluster CPU.
        cleanup_report = preflight_scale_down_apps_by_prefix(
            api_url=api_url,
            token=token,
            app_name_prefix=cleanup_app_prefix,
            run_dir=run_dir,
            timeout_seconds=300,
        )
        write_json(run_dir / "preflight_uat_cleanup.json", cleanup_report)
        if not cleanup_report.get("drain_ok"):
            raise RuntimeError("Preflight cleanup failed to drain prior UAT app sessions")
        summary["checks"]["preflight_cleanup_ok"] = True

        # Create app for UAT flow.
        create_payload = {
            "name": app_name,
            "target_urls": ["https://example.com"],
            "login_config": {
                "login_url": "http://test-harness:8000/login",
                "credential_ref": "k8s:secret/uat-22-4-creds",
                "steps": [
                    {"action": "goto", "url": "http://test-harness:8000/login"},
                    {"action": "fill", "selector": "#email", "value": "${USERNAME}"},
                    {"action": "fill", "selector": "#password", "value": "${PASSWORD}", "sensitive": True},
                    {"action": "click", "selector": "#login-button"},
                    {"action": "fill", "selector": "#otp", "value": "123456", "sensitive": True},
                    {"action": "click", "selector": "#otp-submit"},
                    {"action": "wait_for", "selector": "#user-menu", "timeout_ms": 20000},
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
                    }
                ],
                "policy": "all",
            },
            "export_policy": {
                "artifact_types": ["cookies", "headers", "csrf_token", "local_storage", "session_storage"],
                "encryption": {"algo": "AES-256-GCM", "key_ref": "k8s:secret/batch-a-key"},
                "ttl_seconds": 600,
                "refresh_interval_seconds": 60,
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

        session = pick_session_for_app(api_url, token, app_id, 360, run_dir, "flow1")
        session_id = str(session.get("id"))
        pod_name = str(session.get("pod_name"))
        summary["session_id"] = session_id
        summary["pod_name"] = pod_name

        # Flow 1: verify HEALTHY.
        state = wait_session_state(
            api_url,
            token,
            session_id,
            {"HEALTHY"},
            300,
            run_dir,
            "flow1",
        )
        summary["flow1_state"] = state.get("state")
        summary["checks"]["flow1_app_scaled_and_healthy"] = True

        # Flow 2: force logout via keepalive config and verify HITL escalation + stream access.
        flow2_keepalive = {
            "interval_seconds": 60,
            "actions": [{"action": "goto", "url": "http://test-harness:8000/logout"}],
            "health_checks": [
                {
                    "type": "network_check",
                    "url": "http://test-harness:8000/api/me",
                    "expect_status": 200,
                    "body_contains": "\"authenticated\":true",
                }
            ],
            "policy": "all",
        }
        flow2_update = http_json(
            "PUT",
            f"{api_url}/apps/{app_id}",
            token=token,
            body={"keepalive_config": flow2_keepalive},
        )
        write_json(run_dir / "flow2_app_update_response.json", flow2_update)
        if flow2_update.get("status") != 200:
            raise RuntimeError("Failed to switch keepalive config for flow2")

        flow2_state = wait_session_state(
            api_url,
            token,
            session_id,
            {"LOGIN_NEEDED", "LOGIN_IN_PROGRESS"},
            480,
            run_dir,
            "flow2",
        )
        summary["flow2_state"] = flow2_state.get("state")

        interventions = wait_for_interventions(
            api_url,
            token,
            session_id,
            120,
            run_dir,
            "flow2",
        )
        write_json(run_dir / "flow2_interventions.json", interventions)

        stream_res = http_json("POST", f"{api_url}/sessions/{session_id}/stream", token=token, body={})
        write_json(run_dir / "flow2_stream_response.json", stream_res)
        if stream_res.get("status") != 200 or not isinstance(stream_res.get("body"), dict):
            raise RuntimeError("Flow2 stream URL request failed")
        raw_stream_url = str((stream_res.get("body") or {}).get("url", ""))
        if not raw_stream_url:
            raise RuntimeError("Flow2 stream URL missing")
        stream_url = normalize_stream_url(raw_stream_url, api_url)
        write_json(run_dir / "flow2_stream_url_normalized.json", {
            "raw_url": raw_stream_url,
            "normalized_url": stream_url,
        })
        viewer_res = http_json("GET", stream_url)
        write_json(run_dir / "flow2_viewer_response.json", viewer_res)
        if viewer_res.get("status") != 200:
            raise RuntimeError("Flow2 viewer endpoint failed")
        summary["checks"]["flow2_logout_hitl_escalation_and_stream"] = True

        # Flow 3: move to OTP-driven keepalive, takeover + OTP + release, then HEALTHY.
        flow3_keepalive = {
            "interval_seconds": 60,
            "actions": [
                {"action": "goto", "url": "http://test-harness:8000/login"},
                {"action": "fill", "selector": "#email", "value": "${USERNAME}"},
                {"action": "fill", "selector": "#password", "value": "${PASSWORD}", "sensitive": True},
                {"action": "click", "selector": "#login-button"},
                {"action": "wait_for", "selector": "#otp", "sensitive": True, "timeout_ms": 45000},
                {"action": "click", "selector": "#otp-submit"},
                {"action": "wait_for", "selector": "#user-menu", "timeout_ms": 20000},
            ],
            "health_checks": [
                {
                    "type": "network_check",
                    "url": "http://test-harness:8000/api/me",
                    "expect_status": 200,
                    "body_contains": "\"authenticated\":true",
                }
            ],
            "policy": "all",
        }
        flow3_update = http_json(
            "PUT",
            f"{api_url}/apps/{app_id}",
            token=token,
            body={"keepalive_config": flow3_keepalive},
        )
        write_json(run_dir / "flow3_app_update_response.json", flow3_update)
        if flow3_update.get("status") != 200:
            raise RuntimeError("Failed to switch keepalive config for flow3")

        wait_session_state(
            api_url,
            token,
            session_id,
            {"LOGIN_IN_PROGRESS"},
            360,
            run_dir,
            "flow3",
        )

        takeover = http_json("POST", f"{api_url}/sessions/{session_id}/takeover", token=token, body={})
        write_json(run_dir / "flow3_takeover_response.json", takeover)
        if takeover.get("status") != 200:
            raise RuntimeError(f"Takeover failed: HTTP {takeover.get('status')}")

        otp_attempts: List[Dict[str, Any]] = []
        recovered = False
        for i in range(1, 7):
            otp_res = http_json(
                "POST",
                f"{api_url}/sessions/{session_id}/otp",
                token=token,
                body={"otp_value": "123456"},
            )
            otp_attempts.append({"attempt": i, "response": otp_res})
            if otp_res.get("status") in (200, 409):
                pass
            try:
                healthy = wait_session_state(
                    api_url,
                    token,
                    session_id,
                    {"HEALTHY"},
                    45,
                    run_dir,
                    f"flow3_recovery_attempt_{i}",
                )
                recovered = bool(healthy)
                if recovered:
                    break
            except RuntimeError:
                time.sleep(5)
                continue
        write_json(run_dir / "flow3_otp_attempts.json", otp_attempts)

        release = http_json("POST", f"{api_url}/sessions/{session_id}/release", token=token, body={})
        write_json(run_dir / "flow3_release_response.json", release)
        if release.get("status") != 200:
            raise RuntimeError(f"Release failed: HTTP {release.get('status')}")

        if not recovered:
            wait_session_state(
                api_url,
                token,
                session_id,
                {"HEALTHY"},
                240,
                run_dir,
                "flow3_final",
            )
        summary["checks"]["flow3_takeover_otp_release_back_to_healthy"] = True

        # Flow 4: artifact bundle exported and present in MinIO.
        # Wait until session indicates export timestamp.
        wait_session_state(
            api_url,
            token,
            session_id,
            {"HEALTHY"},
            120,
            run_dir,
            "flow4",
        )

        artifact_sql = (
            "SELECT id, encrypted_payload_ref, expires_at "
            "FROM artifact_bundles "
            f"WHERE session_id = '{session_id}' "
            "ORDER BY exported_at DESC LIMIT 1"
        )
        artifact_row_res = psql_query_tsv(namespace, postgres_pod, artifact_sql)
        write_json(run_dir / "flow4_artifact_row_query.json", artifact_row_res)
        if artifact_row_res["exit_code"] != 0 or not artifact_row_res["stdout"].strip():
            raise RuntimeError("No artifact bundle row found for session")

        parts = artifact_row_res["stdout"].strip().split("\t")
        if len(parts) < 3:
            raise RuntimeError("Malformed artifact bundle row")
        artifact_id, object_ref, expires_at = parts[0], parts[1], parts[2]
        summary["artifact_id"] = artifact_id
        summary["artifact_ref"] = object_ref

        bucket = f"artifact-bundles-{tenant_id}"
        minio_stat_cmd = (
            "mc alias set local http://127.0.0.1:9000 \"$MINIO_ROOT_USER\" \"$MINIO_ROOT_PASSWORD\" >/dev/null "
            f"&& mc stat local/{bucket}/{object_ref}"
        )
        minio_stat = run_cmd(
            [
                "kubectl",
                "-n",
                namespace,
                "exec",
                minio_pod,
                "--",
                "sh",
                "-lc",
                minio_stat_cmd,
            ],
            timeout=60,
        )
        write_json(run_dir / "flow4_minio_stat.json", minio_stat)
        if minio_stat["exit_code"] != 0:
            raise RuntimeError("Artifact object not found in MinIO")

        artifact_url_res = http_json("GET", f"{api_url}/artifacts/{artifact_id}", token=token)
        write_json(run_dir / "flow4_artifact_url_response.json", artifact_url_res)
        if artifact_url_res.get("status") != 200:
            raise RuntimeError("Artifact URL issuance failed")
        summary["checks"]["flow4_artifact_exported_and_minio_present"] = True

        # Flow 5: audit includes HITL/export events and hash chain validates.
        audit_sql = (
            "SELECT sequence_num, COALESCE(prev_hash,''), hash, event_type, payload::text "
            "FROM audit_events ORDER BY sequence_num"
        )
        audit_rows_res = psql_query_tsv(namespace, postgres_pod, audit_sql)
        write_json(run_dir / "flow5_audit_rows_query.json", audit_rows_res)
        if audit_rows_res["exit_code"] != 0:
            raise RuntimeError("Failed to query audit events")

        rows: List[Dict[str, Any]] = []
        for line in audit_rows_res["stdout"].splitlines():
            cols = line.split("\t")
            if len(cols) < 5:
                continue
            payload_obj: Any
            try:
                payload_obj = json.loads(cols[4])
            except json.JSONDecodeError:
                payload_obj = {"raw": cols[4]}
            rows.append(
                {
                    "sequence_num": int(cols[0]),
                    "prev_hash": cols[1],
                    "hash": cols[2],
                    "event_type": cols[3],
                    "payload": payload_obj,
                }
            )

        chain_report = verify_hash_chain(rows)
        write_json(run_dir / "flow5_hash_chain_report.json", chain_report)
        if not chain_report["ok"]:
            raise RuntimeError("Audit hash chain verification failed")

        event_types = {r["event_type"] for r in rows}
        required_events = {"hitl.takeover", "hitl.release", "hitl.otp_submitted", "artifact.exported"}
        missing_events = sorted(list(required_events - event_types))
        write_json(run_dir / "flow5_event_type_summary.json", {
            "required_events": sorted(required_events),
            "present_events": sorted(event_types),
            "missing_events": missing_events,
        })
        if missing_events:
            raise RuntimeError(f"Missing required audit events: {missing_events}")
        summary["checks"]["flow5_audit_events_and_hash_chain"] = True

        # Flow 6: session recycling by max_session_age_hours.
        cfg_res = run_cmd(
            [
                "kubectl",
                "-n",
                namespace,
                "get",
                "configmap",
                "browser-hitl-config",
                "-o",
                "jsonpath={.data.MAX_SESSION_AGE_HOURS}",
            ]
        )
        write_json(run_dir / "flow6_configmap_max_session_age_query.json", cfg_res)
        if cfg_res["exit_code"] == 0 and cfg_res["stdout"].strip():
            original_max_session_age = cfg_res["stdout"].strip()

        set_zero = run_cmd(
            [
                "kubectl",
                "-n",
                namespace,
                "set",
                "env",
                f"deployment/{controller_deployment}",
                "MAX_SESSION_AGE_HOURS=0",
            ],
            timeout=60,
        )
        write_json(run_dir / "flow6_set_env_zero.json", set_zero)
        if set_zero["exit_code"] != 0:
            raise RuntimeError("Failed to set controller MAX_SESSION_AGE_HOURS=0")

        rollout_zero = run_cmd(
            [
                "kubectl",
                "-n",
                namespace,
                "rollout",
                "status",
                f"deployment/{controller_deployment}",
                "--timeout=360s",
            ],
            timeout=380,
        )
        write_json(run_dir / "flow6_rollout_zero.json", rollout_zero)
        if rollout_zero["exit_code"] != 0:
            deploy_after_zero = run_cmd(
                [
                    "kubectl",
                    "-n",
                    namespace,
                    "get",
                    "deployment",
                    controller_deployment,
                    "-o",
                    "json",
                ],
                timeout=60,
            )
            write_json(run_dir / "flow6_rollout_zero_deploy_status.json", deploy_after_zero)
            deploy_after_zero_json = parse_json_stdout(deploy_after_zero)
            if not deploy_after_zero_json or not deployment_effectively_ready(deploy_after_zero_json):
                raise RuntimeError("Controller rollout failed after MAX_SESSION_AGE_HOURS=0")

        # Wait for old session to terminate and a new session to appear.
        deadline = time.time() + 300
        recycled_ok = False
        replacement_session_id = None
        poll = 0
        while time.time() < deadline:
            poll += 1
            sessions = http_json("GET", f"{api_url}/sessions?limit=200&offset=0", token=token)
            write_json(run_dir / f"flow6_recycle_poll_{poll:02d}.json", sessions)
            if sessions.get("status") == 200 and isinstance(sessions.get("body"), dict):
                rows2 = [
                    r for r in (sessions["body"].get("data") or [])
                    if isinstance(r, dict) and r.get("app_id") == app_id
                ]
                old_row = next((r for r in rows2 if str(r.get("id")) == session_id), None)
                new_row = next(
                    (
                        r for r in rows2
                        if str(r.get("id")) != session_id
                        and r.get("state") != "TERMINATED"
                        and r.get("pod_name")
                    ),
                    None,
                )
                old_terminated = old_row is not None and old_row.get("state") == "TERMINATED"
                if old_terminated and new_row is not None:
                    recycled_ok = True
                    replacement_session_id = str(new_row.get("id"))
                    break
            time.sleep(5)
        if not recycled_ok:
            raise RuntimeError("Session recycling validation failed")
        summary["replacement_session_id"] = replacement_session_id
        summary["checks"]["flow6_session_recycle"] = True

        # Restore controller setting.
        restore = run_cmd(
            [
                "kubectl",
                "-n",
                namespace,
                "set",
                "env",
                f"deployment/{controller_deployment}",
                f"MAX_SESSION_AGE_HOURS={original_max_session_age}",
            ],
            timeout=60,
        )
        write_json(run_dir / "flow6_restore_env.json", restore)

        rollout_restore = run_cmd(
            [
                "kubectl",
                "-n",
                namespace,
                "rollout",
                "status",
                f"deployment/{controller_deployment}",
                "--timeout=360s",
            ],
            timeout=380,
        )
        write_json(run_dir / "flow6_rollout_restore.json", rollout_restore)

        restore_ok = restore["exit_code"] == 0
        rollout_restore_ok = rollout_restore["exit_code"] == 0
        if not rollout_restore_ok:
            deploy_after_restore = run_cmd(
                [
                    "kubectl",
                    "-n",
                    namespace,
                    "get",
                    "deployment",
                    controller_deployment,
                    "-o",
                    "json",
                ],
                timeout=60,
            )
            write_json(run_dir / "flow6_rollout_restore_deploy_status.json", deploy_after_restore)
            deploy_after_restore_json = parse_json_stdout(deploy_after_restore)
            rollout_restore_ok = bool(
                deploy_after_restore_json and deployment_effectively_ready(deploy_after_restore_json)
            )

        if not restore_ok or not rollout_restore_ok:
            raise RuntimeError("Failed to restore controller MAX_SESSION_AGE_HOURS")

        # Flow 7/8 should use the currently active app session after recycle.
        # A specific replacement session can terminate quickly under reconcile churn,
        # so repick the active non-terminated session here.
        current_session = pick_session_for_app(
            api_url,
            token,
            app_id,
            240,
            run_dir,
            "flow7_post_recycle",
        )
        current_session_id = str(current_session.get("id"))
        summary["post_recycle_session_id"] = current_session_id
        current_state = wait_session_state(
            api_url,
            token,
            current_session_id,
            {"HEALTHY", "LOGIN_IN_PROGRESS", "LOGIN_NEEDED", "UNHEALTHY"},
            180,
            run_dir,
            "flow7",
        )
        current_pod = str(current_state.get("pod_name") or "")
        if not current_pod:
            raise RuntimeError("Current session has no pod_name")

        # Flow 7: verify blocked domain denied by proxy allowlist.
        blocked_probe = run_worker_playwright_probe(
            namespace,
            current_pod,
            worker_container,
            blocked_url,
            proxy_url,
        )
        write_json(run_dir / "flow7_blocked_probe.json", blocked_probe)
        if (blocked_probe.get("probe") or {}).get("ok"):
            raise RuntimeError("Blocked URL unexpectedly succeeded in flow7")
        summary["checks"]["flow7_non_allowlisted_domain_blocked"] = True

        # Flow 8: stream URL single-use replay rejection.
        # Retry stream issuance if noVNC upstream is still warming up (HTTP 5xx on first upgrade).
        ws_first: Optional[Dict[str, Any]] = None
        ws_replay: Optional[Dict[str, Any]] = None
        attempt_history: List[Dict[str, Any]] = []

        for attempt in range(1, 9):
            flow8_stream = http_json("POST", f"{api_url}/sessions/{current_session_id}/stream", token=token, body={})
            write_json(run_dir / f"flow8_stream_response_attempt_{attempt:02d}.json", flow8_stream)
            if flow8_stream.get("status") != 200 or not isinstance(flow8_stream.get("body"), dict):
                raise RuntimeError("Flow8 stream issuance failed")

            raw_flow8_url = str((flow8_stream.get("body") or {}).get("url", ""))
            if not raw_flow8_url:
                raise RuntimeError("Flow8 stream URL missing")
            flow8_url = normalize_stream_url(raw_flow8_url, api_url)
            write_json(run_dir / f"flow8_stream_url_normalized_attempt_{attempt:02d}.json", {
                "raw_url": raw_flow8_url,
                "normalized_url": flow8_url,
            })

            parsed_stream = parse.urlparse(flow8_url)
            stream_token = parse.parse_qs(parsed_stream.query).get("token", [""])[0]
            if not stream_token:
                raise RuntimeError("Flow8 stream token missing")

            ws_scheme = "wss" if parsed_stream.scheme == "https" else "ws"
            ws_url = (
                f"{ws_scheme}://{parsed_stream.netloc}/vnc-ws"
                f"?session_id={parse.quote(current_session_id)}"
                f"&token={parse.quote(stream_token)}"
            )

            ws_first_candidate = ws_upgrade_probe(ws_url)
            write_json(run_dir / f"flow8_ws_first_attempt_{attempt:02d}.json", ws_first_candidate)
            attempt_entry: Dict[str, Any] = {
                "attempt": attempt,
                "ws_url": ws_url,
                "first_status": ws_first_candidate.get("status_code"),
            }

            if ws_first_candidate.get("status_code") == 101:
                ws_replay_candidate = ws_upgrade_probe(ws_url)
                write_json(run_dir / f"flow8_ws_replay_attempt_{attempt:02d}.json", ws_replay_candidate)
                attempt_entry["replay_status"] = ws_replay_candidate.get("status_code")
                attempt_history.append(attempt_entry)
                ws_first = ws_first_candidate
                ws_replay = ws_replay_candidate
                break

            attempt_history.append(attempt_entry)

            # noVNC upstream may still be warming up right after recycle.
            if ws_first_candidate.get("status_code") in {500, 502, 503, 504}:
                time.sleep(3)
                continue

            time.sleep(2)

        write_json(run_dir / "flow8_ws_attempts.json", attempt_history)
        if not ws_first or not ws_replay:
            raise RuntimeError("Flow8 could not establish initial websocket upgrade")

        write_json(run_dir / "flow8_ws_first.json", ws_first)
        write_json(run_dir / "flow8_ws_replay.json", ws_replay)
        if ws_first.get("status_code") != 101 or ws_replay.get("status_code") != 401:
            raise RuntimeError(
                f"Flow8 replay check failed: first={ws_first.get('status_code')} replay={ws_replay.get('status_code')}"
            )
        summary["checks"]["flow8_stream_single_use_replay_rejected"] = True

        summary["result"] = "PASS"
        summary["completed_at"] = utc_now()
        write_json(run_dir / "summary.json", summary)
        log("UAT 22.4 PASS", run_log)
        return 0

    except Exception as exc:  # noqa: BLE001
        # Best-effort restore controller max session age if we changed it.
        restore_attempt = run_cmd(
            [
                "kubectl",
                "-n",
                namespace,
                "set",
                "env",
                f"deployment/{controller_deployment}",
                f"MAX_SESSION_AGE_HOURS={original_max_session_age}",
            ],
            timeout=60,
        )
        write_json(run_dir / "restore_on_failure.json", restore_attempt)

        summary["result"] = "FAIL"
        summary["error"] = str(exc)
        summary["completed_at"] = utc_now()
        write_json(run_dir / "summary.json", summary)
        log(f"UAT 22.4 FAIL: {exc}", run_log)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
