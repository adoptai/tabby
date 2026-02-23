"""Shared HTTP client utility for E2E smoke tests."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Optional
from urllib import error, request


def http_json(
    method: str,
    url: str,
    token: Optional[str] = None,
    body: Optional[Dict[str, Any]] = None,
    timeout: int = 30,
    extra_headers: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Make an HTTP request and return {status, body, raw}."""
    data = None
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    if extra_headers:
        headers.update(extra_headers)
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
    """Write a JSON file (creating parent dirs as needed)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
