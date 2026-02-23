#!/usr/bin/env python3
"""
Minimal mock noVNC/websockify upstream for local Batch A validation.

Accepts websocket upgrade requests on /websockify and returns HTTP 101.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import socket
import threading
import time


GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def parse_headers(raw: bytes) -> dict[str, str]:
    text = raw.decode("latin-1", errors="replace")
    lines = text.split("\r\n")
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if not line or ":" not in line:
            continue
        key, value = line.split(":", 1)
        headers[key.strip().lower()] = value.strip()
    return headers


def websocket_accept(key: str) -> str:
    digest = hashlib.sha1((key + GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


def handle_client(conn: socket.socket, addr: tuple[str, int]) -> None:
    with conn:
        conn.settimeout(3.0)
        raw = b""
        try:
            while b"\r\n\r\n" not in raw and len(raw) < 32768:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                raw += chunk
        except OSError:
            return

        if not raw:
            return

        headers = parse_headers(raw)
        key = headers.get("sec-websocket-key", "")
        if not key:
            conn.sendall(
                b"HTTP/1.1 400 Bad Request\r\n"
                b"Connection: close\r\n"
                b"Content-Length: 0\r\n\r\n"
            )
            return

        accept = websocket_accept(key)
        response = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n"
            "\r\n"
        ).encode("ascii")
        conn.sendall(response)
        time.sleep(0.1)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=16080)
    args = parser.parse_args()

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((args.host, args.port))
    server.listen(100)
    print(f"mock-novnc-upstream listening on {args.host}:{args.port}", flush=True)

    try:
        while True:
            conn, addr = server.accept()
            thread = threading.Thread(target=handle_client, args=(conn, addr), daemon=True)
            thread.start()
    except KeyboardInterrupt:
        return 0
    finally:
        server.close()


if __name__ == "__main__":
    raise SystemExit(main())
