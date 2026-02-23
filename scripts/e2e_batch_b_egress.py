#!/usr/bin/env python3
"""
Batch B E2E validator:
1) verify egress proxy default allow/deny
2) verify runtime allowlist update endpoint
3) verify allowlist cleanup endpoint
4) verify CONNECT handling follows allowlist state

Writes evidence artifacts under implementation_tracker/phase_3/evidence.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import signal
import socket
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from typing import Any, Dict, Tuple
from urllib import request


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def log(message: str, log_path: Path) -> None:
    line = f"[{utc_now()}] {message}"
    print(line, flush=True)
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write(line + "\n")


class NamedHandler(BaseHTTPRequestHandler):
    server_label = "backend"

    def do_GET(self) -> None:  # noqa: N802
        body = json.dumps(
            {
                "ok": True,
                "label": self.server_label,
                "path": self.path,
            }
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def start_backend(port: int, label: str) -> Tuple[ThreadingHTTPServer, Thread]:
    handler = type(f"{label.title()}Handler", (NamedHandler,), {"server_label": label})
    server = ThreadingHTTPServer(("127.0.0.1", port), handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread


def wait_for_port(host: str, port: int, timeout: float = 10.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.1)
    raise TimeoutError(f"Timed out waiting for {host}:{port}")


def curl_via_proxy(proxy_url: str, target_url: str) -> Dict[str, Any]:
    cmd = [
        "curl",
        "-sS",
        "--noproxy",
        "",
        "-x",
        proxy_url,
        "-w",
        "\n%{http_code}",
        target_url,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    body_text = proc.stdout
    status_code = 0
    response_body = ""
    if "\n" in body_text:
        response_body, status_raw = body_text.rsplit("\n", 1)
        if status_raw.isdigit():
            status_code = int(status_raw)

    return {
        "cmd": cmd,
        "exit_code": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
        "status_code": status_code,
        "response_body": response_body,
    }


def http_json(method: str, url: str, body: Dict[str, Any] | None = None) -> Dict[str, Any]:
    data = None
    headers = {"content-type": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")

    req = request.Request(url=url, method=method, headers=headers, data=data)
    try:
        with request.urlopen(req, timeout=10) as resp:
            payload = resp.read().decode("utf-8", errors="replace")
            parsed = json.loads(payload) if payload else None
            return {"status": resp.status, "raw": payload, "body": parsed}
    except Exception as exc:  # noqa: BLE001
        return {"status": 0, "error": str(exc)}


def connect_probe(proxy_host: str, proxy_port: int, target_host: str, target_port: int) -> Dict[str, Any]:
    with socket.create_connection((proxy_host, proxy_port), timeout=5.0) as sock:
        req = (
            f"CONNECT {target_host}:{target_port} HTTP/1.1\r\n"
            f"Host: {target_host}:{target_port}\r\n"
            "Connection: close\r\n"
            "\r\n"
        ).encode("ascii")
        sock.sendall(req)
        raw = sock.recv(4096).decode("latin-1", errors="replace")
    status_line = raw.split("\r\n", 1)[0]
    parts = status_line.split(" ")
    status_code = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
    return {"status_line": status_line, "status_code": status_code, "raw": raw}


def stop_process(proc: subprocess.Popen[Any]) -> None:
    if proc.poll() is not None:
        return
    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def main() -> int:
    repo_root = Path(__file__).resolve().parent.parent
    evidence_root = Path(
        os.getenv("EVIDENCE_ROOT", str(repo_root / "implementation_tracker/phase_3/evidence"))
    )
    ensure_dir(evidence_root)

    timestamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = evidence_root / f"batch_b_egress_{timestamp}"
    ensure_dir(run_dir)
    run_log = run_dir / "run.log"
    proxy_log = run_dir / "egress_proxy.log"

    summary: Dict[str, Any] = {
        "started_at": utc_now(),
        "checks": {},
    }

    log(f"Batch B egress run directory: {run_dir}", run_log)

    allowed_server = None
    blocked_server = None
    proxy_proc = None
    proxy_handle = None

    proxy_port = int(os.getenv("BATCH_B_PROXY_PORT", "13128"))
    admin_port = int(os.getenv("BATCH_B_ADMIN_PORT", "18095"))
    allowed_port = int(os.getenv("BATCH_B_ALLOWED_PORT", "18081"))
    blocked_port = int(os.getenv("BATCH_B_BLOCKED_PORT", "18082"))
    session_id = os.getenv("BATCH_B_SESSION_ID", "batch-b-session")

    try:
        allowed_server, _ = start_backend(allowed_port, "allowed")
        blocked_server, _ = start_backend(blocked_port, "blocked")
        log(f"Started local backends on {allowed_port}/{blocked_port}", run_log)

        proxy_script = repo_root / "charts/browser-hitl/files/egress-proxy/server.js"
        proxy_env = dict(os.environ)
        proxy_env.update(
            {
                "EGRESS_PROXY_PORT": str(proxy_port),
                "EGRESS_PROXY_ADMIN_PORT": str(admin_port),
                "EGRESS_PROXY_DEFAULT_ALLOWLIST": "allowed.localhost",
            }
        )
        proxy_handle = proxy_log.open("w", encoding="utf-8")
        proxy_proc = subprocess.Popen(
            ["node", str(proxy_script)],
            cwd=str(repo_root),
            env=proxy_env,
            stdout=proxy_handle,
            stderr=subprocess.STDOUT,
        )
        wait_for_port("127.0.0.1", proxy_port, timeout=15)
        wait_for_port("127.0.0.1", admin_port, timeout=15)
        log("Started egress proxy process", run_log)

        proxy_url = f"http://127.0.0.1:{proxy_port}"
        admin_url = f"http://127.0.0.1:{admin_port}/allowlist"

        allowed_pre = curl_via_proxy(proxy_url, f"http://allowed.localhost:{allowed_port}/ping")
        blocked_pre = curl_via_proxy(proxy_url, f"http://blocked.localhost:{blocked_port}/ping")
        connect_blocked_pre = connect_probe("127.0.0.1", proxy_port, "blocked.localhost", blocked_port)
        write_json(run_dir / "allowed_pre.json", allowed_pre)
        write_json(run_dir / "blocked_pre.json", blocked_pre)
        write_json(run_dir / "connect_blocked_pre.json", connect_blocked_pre)

        allow_update = http_json(
            "PUT",
            admin_url,
            body={
                "session_id": session_id,
                "target_urls": [f"http://blocked.localhost:{blocked_port}/login"],
            },
        )
        write_json(run_dir / "allowlist_update.json", allow_update)

        blocked_post = curl_via_proxy(proxy_url, f"http://blocked.localhost:{blocked_port}/ping")
        connect_blocked_post = connect_probe("127.0.0.1", proxy_port, "blocked.localhost", blocked_port)
        write_json(run_dir / "blocked_post.json", blocked_post)
        write_json(run_dir / "connect_blocked_post.json", connect_blocked_post)

        allow_delete = http_json("DELETE", f"{admin_url}/{session_id}")
        write_json(run_dir / "allowlist_delete.json", allow_delete)

        blocked_after_delete = curl_via_proxy(proxy_url, f"http://blocked.localhost:{blocked_port}/ping")
        connect_blocked_after_delete = connect_probe(
            "127.0.0.1", proxy_port, "blocked.localhost", blocked_port
        )
        write_json(run_dir / "blocked_after_delete.json", blocked_after_delete)
        write_json(run_dir / "connect_blocked_after_delete.json", connect_blocked_after_delete)

        checks = {
            "default_allow_http_ok": allowed_pre.get("status_code") == 200,
            "default_deny_http_ok": blocked_pre.get("status_code") == 403,
            "default_deny_connect_ok": connect_blocked_pre.get("status_code") == 403,
            "allowlist_update_http_200": allow_update.get("status") == 200,
            "post_update_http_ok": blocked_post.get("status_code") == 200,
            "post_update_connect_ok": connect_blocked_post.get("status_code") == 200,
            "allowlist_delete_http_200": allow_delete.get("status") == 200,
            "post_delete_http_denied": blocked_after_delete.get("status_code") == 403,
            "post_delete_connect_denied": connect_blocked_after_delete.get("status_code") == 403,
        }
        summary["checks"] = checks
        summary["result"] = "PASS" if all(checks.values()) else "FAIL"
        summary["completed_at"] = utc_now()
        write_json(run_dir / "summary.json", summary)

        if summary["result"] != "PASS":
            raise RuntimeError("One or more Batch B egress checks failed")

        log("Batch B egress PASS", run_log)
        return 0
    except Exception as exc:  # noqa: BLE001
        summary["result"] = "FAIL"
        summary["error"] = str(exc)
        summary["completed_at"] = utc_now()
        write_json(run_dir / "summary.json", summary)
        log(f"Batch B egress FAIL: {exc}", run_log)
        return 1
    finally:
        if proxy_proc is not None:
            stop_process(proxy_proc)
        if proxy_handle is not None:
            proxy_handle.close()
        if allowed_server is not None:
            allowed_server.shutdown()
            allowed_server.server_close()
        if blocked_server is not None:
            blocked_server.shutdown()
            blocked_server.server_close()


if __name__ == "__main__":
    raise SystemExit(main())
