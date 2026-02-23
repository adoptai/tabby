#!/usr/bin/env python3
"""
CDP vs VNC Proof-of-Life — Screenshot at Each Stage + Resource Comparison

Creates TWO apps (one VNC, one CDP), scales each to 1 session, captures
screenshots at each stage, and compares pod resource consumption.

Usage:
  python3 e2e_smoke_test/cdp_proof_of_life.py [--api-url URL]

Outputs:
  e2e_smoke_test/proof_of_life/
    vnc_*.png / cdp_*.png  — screenshots from each session
    resource_comparison.json
    summary.json
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).parent))
from helpers.http_client import http_json, write_json


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="CDP vs VNC Proof of Life")
    p.add_argument("--api-url", default=os.getenv("API_URL", "http://localhost:8080"))
    p.add_argument("--admin-email", default=os.getenv("ADMIN_EMAIL", "admin@browser-hitl.local"))
    p.add_argument("--admin-password", default=os.getenv("ADMIN_PASSWORD", "e2e-admin-password"))
    p.add_argument("--credential-ref", default=os.getenv("CREDENTIAL_REF", "k8s:secret/e2e-smoke-creds"))
    p.add_argument("--timeout", type=int, default=300, help="Session wait timeout seconds")
    return p.parse_args()


def take_cdp_screenshot(session_id: str, output_path: Path, ns: str = "browser-hitl") -> bool:
    """Take a screenshot via CDP Page.captureScreenshot.

    Uses Node.js built-in http module to make a WebSocket-less CDP call.
    Chromium exposes /json for target listing. We then use a raw HTTP
    upgrade + single-shot message exchange — no `ws` package needed.
    """
    pod_name = f"worker-{session_id.lower()}"
    try:
        # Single Node.js script that uses ONLY built-in modules (http, net, crypto)
        # to perform a WebSocket handshake and send CDP Page.captureScreenshot
        screenshot_script = r"""
const http = require('http');
const net = require('net');
const crypto = require('crypto');

async function main() {
  // 1. Get page target
  const targets = await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });

  const page = targets.find(t => t.type === 'page');
  if (!page || !page.webSocketDebuggerUrl) { process.exit(1); }

  // 2. Parse WS URL
  const url = new URL(page.webSocketDebuggerUrl);
  const host = url.hostname;
  const port = parseInt(url.port) || 9222;
  const path = url.pathname;

  // 3. WebSocket handshake (RFC 6455) using raw TCP
  const key = crypto.randomBytes(16).toString('base64');
  const socket = net.createConnection(port, host);

  await new Promise((resolve, reject) => {
    socket.on('connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n\r\n`
      );
    });

    let headersDone = false;
    let buf = Buffer.alloc(0);
    let resultData = '';

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);

      if (!headersDone) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        headersDone = true;
        buf = buf.slice(idx + 4);

        // Send Page.captureScreenshot
        const cmd = JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } });
        const payload = Buffer.from(cmd, 'utf8');
        const frame = Buffer.alloc(payload.length < 126 ? 6 + payload.length : 8 + payload.length);
        frame[0] = 0x81; // FIN + text
        const mask = crypto.randomBytes(4);
        if (payload.length < 126) {
          frame[1] = 0x80 | payload.length;
          mask.copy(frame, 2);
          for (let i = 0; i < payload.length; i++) frame[6 + i] = payload[i] ^ mask[i % 4];
        } else {
          frame[1] = 0x80 | 126;
          frame.writeUInt16BE(payload.length, 2);
          mask.copy(frame, 4);
          for (let i = 0; i < payload.length; i++) frame[8 + i] = payload[i] ^ mask[i % 4];
        }
        socket.write(frame);
      }

      // Parse WebSocket frames for the response (unmasked from server)
      while (buf.length > 2) {
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let payloadLen = buf[1] & 0x7f;
        let offset = 2;
        if (payloadLen === 126) {
          if (buf.length < 4) return;
          payloadLen = buf.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buf.length < 10) return;
          payloadLen = Number(buf.readBigUInt64BE(2));
          offset = 10;
        }
        if (masked) offset += 4;
        if (buf.length < offset + payloadLen) return;

        const payload2 = buf.slice(offset, offset + payloadLen);
        buf = buf.slice(offset + payloadLen);

        if (opcode === 1) { // text frame
          const text = payload2.toString('utf8');
          resultData += text;
          try {
            const msg = JSON.parse(resultData);
            if (msg.id === 1 && msg.result && msg.result.data) {
              process.stdout.write(msg.result.data);
              socket.destroy();
              resolve();
              return;
            }
          } catch(e) {
            // Incomplete JSON, continue accumulating
          }
        }
      }
    });

    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 15000);
  });
}

main().catch(() => process.exit(1));
"""
        result = subprocess.run(
            ["kubectl", "exec", pod_name, "-n", ns, "-c", "worker", "--",
             "node", "-e", screenshot_script],
            capture_output=True, timeout=25,
        )

        if result.returncode == 0 and result.stdout:
            img_data = base64.b64decode(result.stdout)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(img_data)
            print(f"  Screenshot saved: {output_path.name} ({len(img_data):,} bytes)")
            return True
        else:
            stderr = result.stderr.decode()[:300] if result.stderr else "no output"
            print(f"  Screenshot failed (exit={result.returncode}): {stderr}")
            return False
    except Exception as e:
        print(f"  Screenshot error: {e}")
        return False


def get_pod_resources(session_id: str, ns: str = "browser-hitl") -> Dict[str, Any]:
    """Get pod resource details."""
    pod_name = f"worker-{session_id.lower()}"
    resources: Dict[str, Any] = {"pod_name": pod_name}
    try:
        result = subprocess.run(
            ["kubectl", "get", "pod", pod_name, "-n", ns, "-o", "json"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            pod_json = json.loads(result.stdout)
            containers = pod_json.get("spec", {}).get("containers", [])
            resources["container_count"] = len(containers)
            resources["container_names"] = [c.get("name", "?") for c in containers]
            resources["containers"] = []
            for c in containers:
                resources["containers"].append({
                    "name": c.get("name"),
                    "requests": c.get("resources", {}).get("requests", {}),
                    "limits": c.get("resources", {}).get("limits", {}),
                })
            labels = pod_json.get("metadata", {}).get("labels", {})
            resources["streaming_mode_label"] = labels.get("streaming-mode", "unknown")
            # Calculate total requested
            total_cpu_milli = 0
            total_mem_mib = 0
            for c in containers:
                req = c.get("resources", {}).get("requests", {})
                cpu_str = str(req.get("cpu", "0"))
                mem_str = str(req.get("memory", "0"))
                if cpu_str.endswith("m"):
                    total_cpu_milli += int(cpu_str[:-1])
                else:
                    total_cpu_milli += int(float(cpu_str) * 1000)
                if mem_str.endswith("Gi"):
                    total_mem_mib += int(float(mem_str[:-2]) * 1024)
                elif mem_str.endswith("Mi"):
                    total_mem_mib += int(mem_str[:-2])
            resources["total_requested_cpu_milli"] = total_cpu_milli
            resources["total_requested_memory_mib"] = total_mem_mib
    except Exception as e:
        resources["error"] = str(e)

    # Try kubectl top
    try:
        result = subprocess.run(
            ["kubectl", "top", "pod", pod_name, "-n", ns, "--containers"],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode == 0:
            resources["actual_usage"] = result.stdout.strip()
    except Exception:
        resources["actual_usage"] = "metrics-server not available"

    return resources


def poll_session(api_url: str, token: str, app_id: str, target_states: List[str],
                 timeout: int) -> Optional[Dict]:
    deadline = time.time() + timeout
    poll = 0
    while time.time() < deadline:
        poll += 1
        res = http_json("GET", f"{api_url}/sessions?limit=200&offset=0", token=token)
        if res.get("status") == 200 and isinstance(res.get("body"), dict):
            for r in (res["body"].get("data") or []):
                if isinstance(r, dict) and r.get("app_id") == app_id:
                    state = str(r.get("state", ""))
                    if state in target_states:
                        return r
                    if poll % 6 == 0:
                        print(f"    ... state: {state} (want {target_states})")
        time.sleep(5)
    return None


def run_mode(mode: str, api_url: str, token: str, credential_ref: str,
             timeout: int, out: Path) -> Dict[str, Any]:
    P = mode.upper()
    res: Dict[str, Any] = {"mode": mode, "checks": {}, "screenshots": []}

    print(f"\n{'='*60}")
    print(f"  {P} MODE TEST")
    print(f"{'='*60}")

    # 1. Create app
    ts = dt.datetime.now(dt.timezone.utc).strftime('%H%M%S')
    app_body = {
        "name": f"pol-{mode}-{ts}",
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
            "health_checks": [{"type": "network_check", "url": "http://test-harness:8000/api/me",
                               "expect_status": 200, "body_contains": '"authenticated":true'}],
            "policy": "all",
        },
        "export_policy": {
            "artifact_types": ["cookies", "headers", "csrf_token"],
            "header_allowlist": ["authorization", "x-csrf-token"],
            "encryption": {"algo": "AES-256-GCM", "key_version": "v1"},
            "ttl_seconds": 3600,
        },
        "notification_config": {"channels": ["slack:#e2e-smoke-test"]},
        "desired_session_count": 0,
        "browser_policy": {"downloads": False, "clipboard": False, "file_chooser": False,
                           "streaming_mode": mode},
    }
    print(f"  [{P}] Creating app (streaming_mode={mode})...")
    cr = http_json("POST", f"{api_url}/apps", token=token, body=app_body)
    app_id = ((cr.get("body") or {}) if isinstance(cr.get("body"), dict) else {}).get("app_id")
    res["checks"]["app_created"] = bool(app_id)
    res["app_id"] = app_id
    if not app_id:
        print(f"  [{P}] FAIL: app creation failed ({cr.get('status')})")
        return res
    print(f"  [{P}] App {app_id} created")

    # 2. Scale
    print(f"  [{P}] Scaling to 1...")
    sc = http_json("POST", f"{api_url}/apps/{app_id}/sessions/scale",
                    token=token, body={"desired_sessions": 1})
    res["checks"]["scaled"] = sc.get("status") == 200

    # 3. Wait for session to appear
    print(f"  [{P}] Waiting for session (timeout {timeout}s)...")
    sess = poll_session(api_url, token, app_id,
                        ["HEALTHY", "LOGIN_IN_PROGRESS", "LOGIN_NEEDED",
                         "UNHEALTHY", "FAILED", "STARTING"], timeout)
    if not sess:
        res["checks"]["session_started"] = False
        print(f"  [{P}] TIMEOUT: no session appeared")
        return res

    sid = str(sess.get("id", ""))
    state = sess.get("state", "")
    res["session_id"] = sid
    res["checks"]["session_started"] = True
    print(f"  [{P}] Session {sid[:12]}... state={state}")

    # 3a. Screenshot: whatever state we're in
    time.sleep(5)  # Let the page render
    print(f"  [{P}] Screenshot 1: initial state ({state})...")
    s1 = out / f"{mode}_01_{state.lower()}.png"
    if take_cdp_screenshot(sid, s1):
        res["screenshots"].append(str(s1))

    # 3b. If needs OTP, inject it
    if state in ("LOGIN_IN_PROGRESS", "LOGIN_NEEDED"):
        print(f"  [{P}] Injecting OTP...")
        otp = http_json("POST", f"{api_url}/hitl/{sid}/otp",
                         token=token, body={"otp_value": "123456"})
        res["checks"]["otp_injected"] = otp.get("status") in (200, 409)
        print(f"  [{P}] OTP: HTTP {otp.get('status')}")

        time.sleep(3)
        # Screenshot after OTP
        print(f"  [{P}] Screenshot 2: post-OTP...")
        s2 = out / f"{mode}_02_post_otp.png"
        if take_cdp_screenshot(sid, s2):
            res["screenshots"].append(str(s2))

    # 3c. Wait for HEALTHY
    print(f"  [{P}] Waiting for HEALTHY...")
    healthy = poll_session(api_url, token, app_id, ["HEALTHY"], timeout)
    res["checks"]["session_healthy"] = healthy is not None

    if healthy:
        sid = str(healthy.get("id", ""))
        res["session_id"] = sid
        print(f"  [{P}] Session HEALTHY!")

        time.sleep(3)
        # Screenshot: authenticated
        print(f"  [{P}] Screenshot 3: authenticated page...")
        s3 = out / f"{mode}_03_authenticated.png"
        if take_cdp_screenshot(sid, s3):
            res["screenshots"].append(str(s3))
    else:
        final = poll_session(api_url, token, app_id,
                              ["FAILED", "TERMINATED", "UNHEALTHY"], 10)
        final_state = final.get("state", "UNKNOWN") if final else "TIMEOUT"
        print(f"  [{P}] Session did not reach HEALTHY (final={final_state})")
        res["checks"]["session_healthy"] = False

    # 4. Pod shape
    if res.get("session_id"):
        print(f"  [{P}] Pod shape validation...")
        resources = get_pod_resources(res["session_id"])
        res["resources"] = resources
        cc = resources.get("container_count", 0)
        names = resources.get("container_names", [])
        label = resources.get("streaming_mode_label", "?")

        if mode == "cdp":
            res["checks"]["single_container"] = cc == 1
            res["checks"]["no_sidecar"] = "novnc" not in names
        else:
            res["checks"]["two_containers"] = cc == 2
            res["checks"]["has_sidecar"] = "novnc" in names
        res["checks"]["mode_label"] = label == mode

        print(f"  [{P}] Containers: {names} | label={label}")

        # Service check
        pod_name = f"worker-{res['session_id'].lower()}"
        svc_name = f"{pod_name}-cdp" if mode == "cdp" else f"{pod_name}-novnc"
        svc = subprocess.run(
            ["kubectl", "get", "svc", svc_name, "-n", "browser-hitl",
             "-o", "jsonpath={.spec.ports[0].port}"],
            capture_output=True, text=True, timeout=10,
        )
        expected_port = "9223" if mode == "cdp" else "6080"
        res["checks"]["correct_service"] = svc.returncode == 0 and svc.stdout.strip() == expected_port
        print(f"  [{P}] Service {svc_name}: port={svc.stdout.strip()}")

    return res


def main() -> int:
    args = parse_args()
    api_url = args.api_url.rstrip("/")
    out = Path(__file__).parent / "proof_of_life"
    out.mkdir(parents=True, exist_ok=True)

    summary: Dict[str, Any] = {"started_at": utc_now()}

    print("\n" + "="*60)
    print("  CDP vs VNC PROOF OF LIFE")
    print("="*60)

    # Login
    print("\nAdmin login...")
    login = http_json("POST", f"{api_url}/login",
                       body={"email": args.admin_email, "password": args.admin_password})
    token = ((login.get("body") or {}) if isinstance(login.get("body"), dict) else {}).get("token")
    if not token:
        print(f"Login failed: {login}")
        return 1
    print(f"Logged in")

    # Start mock HITL
    mock_proc = None
    mock_script = Path(__file__).parent / "mock-hitl" / "auto-responder.js"
    if mock_script.exists():
        print("Starting mock HITL...")
        mock_proc = subprocess.Popen(
            ["node", str(mock_script)],
            env={**os.environ,
                 "NATS_URL": os.getenv("NATS_URL", "nats://localhost:4222"),
                 "REDIS_URL": os.getenv("REDIS_URL", "redis://localhost:16379"),
                 "OTP_VALUE": "123456",
                 "LOG_FILE": str(out / "mock_hitl.log"),
                 "FAILURE_MODE": "none"},
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        time.sleep(2)
        if mock_proc.poll() is None:
            print(f"Mock HITL running (PID {mock_proc.pid})")
        else:
            print("Mock HITL failed to start — will try API OTP injection")

    # Run both modes
    vnc_res = run_mode("vnc", api_url, str(token), args.credential_ref, args.timeout, out)
    cdp_res = run_mode("cdp", api_url, str(token), args.credential_ref, args.timeout, out)

    # Resource comparison
    print(f"\n{'='*60}")
    print("  RESOURCE COMPARISON: VNC vs CDP")
    print(f"{'='*60}")

    vnc_r = vnc_res.get("resources", {})
    cdp_r = cdp_res.get("resources", {})

    print(f"\n  {'Metric':<35} {'VNC':>12} {'CDP':>12} {'Savings':>12}")
    print(f"  {'-'*35} {'-'*12} {'-'*12} {'-'*12}")

    vnc_cc = vnc_r.get("container_count", "?")
    cdp_cc = cdp_r.get("container_count", "?")
    print(f"  {'Containers per pod':<35} {str(vnc_cc):>12} {str(cdp_cc):>12} {'1 fewer':>12}")

    vnc_cpu = vnc_r.get("total_requested_cpu_milli", 0)
    cdp_cpu = cdp_r.get("total_requested_cpu_milli", 0)
    savings_cpu = vnc_cpu - cdp_cpu if vnc_cpu and cdp_cpu else 0
    print(f"  {'Total CPU request (milli)':<35} {str(vnc_cpu) + 'm':>12} {str(cdp_cpu) + 'm':>12} {str(savings_cpu) + 'm':>12}")

    vnc_mem = vnc_r.get("total_requested_memory_mib", 0)
    cdp_mem = cdp_r.get("total_requested_memory_mib", 0)
    savings_mem = vnc_mem - cdp_mem if vnc_mem and cdp_mem else 0
    print(f"  {'Total Memory request (MiB)':<35} {str(vnc_mem) + 'Mi':>12} {str(cdp_mem) + 'Mi':>12} {str(savings_mem) + 'Mi':>12}")

    vnc_names = vnc_r.get("container_names", [])
    cdp_names = cdp_r.get("container_names", [])
    print(f"  {'Container names':<35} {str(vnc_names):>12} {str(cdp_names):>12}")

    # Also: VNC needs Xvfb + x11vnc + websockify processes, CDP does not
    print(f"\n  {'Extra processes (VNC mode)':<35} {'Xvfb, x11vnc, websockify':>38}")
    print(f"  {'Extra processes (CDP mode)':<35} {'none':>38}")

    comparison = {
        "vnc": vnc_r,
        "cdp": cdp_r,
        "savings": {
            "cpu_milli": savings_cpu,
            "memory_mib": savings_mem,
            "containers": (vnc_cc - cdp_cc) if isinstance(vnc_cc, int) and isinstance(cdp_cc, int) else "N/A",
            "processes_eliminated": ["Xvfb", "x11vnc", "websockify"],
        },
    }
    write_json(out / "resource_comparison.json", comparison)

    # Cleanup
    print(f"\n{'='*60}")
    print("  CLEANUP")
    print(f"{'='*60}")
    for r in [vnc_res, cdp_res]:
        aid = r.get("app_id")
        if aid:
            sc = http_json("POST", f"{api_url}/apps/{aid}/sessions/scale",
                            token=str(token), body={"desired_sessions": 0})
            print(f"  Scaled {r['mode']} app to 0: HTTP {sc.get('status')}")

    if mock_proc and mock_proc.poll() is None:
        mock_proc.terminate()
        try: mock_proc.wait(5)
        except: mock_proc.kill()

    # Summary
    all_checks = {**{f"vnc.{k}": v for k, v in vnc_res.get("checks", {}).items()},
                  **{f"cdp.{k}": v for k, v in cdp_res.get("checks", {}).items()}}
    failures = [k for k, v in all_checks.items() if not v]

    summary.update({
        "vnc": vnc_res, "cdp": cdp_res,
        "resource_comparison": comparison,
        "all_checks": all_checks,
        "total_checks": len(all_checks),
        "failures": failures,
        "result": "FAIL" if failures else "PASS",
        "completed_at": utc_now(),
    })
    write_json(out / "summary.json", summary)

    print(f"\n{'='*60}")
    result_line = f"PASS ({len(all_checks) - len(failures)}/{len(all_checks)} checks)" if not failures else f"FAIL ({len(failures)} failures)"
    print(f"  RESULT: {result_line}")
    if failures:
        for f in failures:
            print(f"    FAIL: {f}")
    print(f"\n  Screenshots:")
    for ss in vnc_res.get("screenshots", []) + cdp_res.get("screenshots", []):
        print(f"    {ss}")
    print(f"\n  Evidence: {out}")
    print(f"{'='*60}")

    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
