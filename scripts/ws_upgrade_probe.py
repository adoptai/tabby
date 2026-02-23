#!/usr/bin/env python3
"""
Open a raw WebSocket upgrade request against ws:// or wss:// URL and print a JSON response.

Output schema:
{
  "url": "...",
  "status_code": 101,
  "status_line": "HTTP/1.1 101 Switching Protocols",
  "headers": {...}
}
"""

from __future__ import annotations

import base64
import json
import os
import socket
import ssl
import sys
from urllib.parse import urlparse


def read_response(sock: socket.socket) -> bytes:
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = sock.recv(4096)
        if not chunk:
            break
        data += chunk
    return data


def parse_headers(raw: bytes) -> tuple[int, str, dict[str, str]]:
    text = raw.decode("latin-1", errors="replace")
    lines = text.split("\r\n")
    if not lines or not lines[0].startswith("HTTP/"):
        return (0, "INVALID_RESPONSE", {})

    status_line = lines[0]
    parts = status_line.split(" ", 2)
    status_code = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else 0

    headers: dict[str, str] = {}
    for line in lines[1:]:
        if not line:
            break
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        headers[k.strip().lower()] = v.strip()

    return (status_code, status_line, headers)


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: ws_upgrade_probe.py <ws://...|wss://...>", file=sys.stderr)
        return 2

    url = sys.argv[1]
    parsed = urlparse(url)
    if parsed.scheme not in ("ws", "wss"):
        print("URL scheme must be ws or wss", file=sys.stderr)
        return 2

    host = parsed.hostname
    if not host:
        print("URL missing host", file=sys.stderr)
        return 2

    port = parsed.port or (443 if parsed.scheme == "wss" else 80)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"

    key = base64.b64encode(os.urandom(16)).decode("ascii")
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Connection: Upgrade\r\n"
        "Upgrade: websocket\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "\r\n"
    ).encode("ascii")

    raw_socket = socket.create_connection((host, port), timeout=10.0)
    try:
        if parsed.scheme == "wss":
            context = ssl.create_default_context()
            sock: socket.socket = context.wrap_socket(raw_socket, server_hostname=host)
        else:
            sock = raw_socket

        with sock:
            sock.sendall(request)
            raw = read_response(sock)
    finally:
        try:
            raw_socket.close()
        except OSError:
            pass

    status_code, status_line, headers = parse_headers(raw)
    print(
        json.dumps(
            {
                "url": url,
                "status_code": status_code,
                "status_line": status_line,
                "headers": headers,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
