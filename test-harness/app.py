"""
Test Harness App - Enhanced Salesforce-like web application for E2E smoke testing.

Provides:
- Username/password login page with CSRF protection
- OTP prompt page (fixed code: 123456)
- Protected dashboard with localStorage/sessionStorage data
- Configurable session TTL, rate limiting, account lockout
- Keepalive and session-info endpoints
- Response headers for worker header capture (Authorization, X-Instance-Url, etc.)
- /api/me JSON endpoint for credential verification
"""

from fastapi import FastAPI, Query, Request, Response, Form, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired
import os
import secrets
import time
import uuid
from collections import defaultdict

app = FastAPI(title="Browser HITL Test Harness (Enhanced)")
templates = Jinja2Templates(directory=os.path.join(os.path.dirname(__file__), "templates"))

SECRET_KEY = os.environ.get("SECRET_KEY", "test-harness-secret-key-not-for-production")
SESSION_COOKIE = "test_session"
CSRF_COOKIE = "csrf_session"
OTP_CODE = "123456"
SESSION_TTL_SECONDS = int(os.environ.get("SESSION_TTL_SECONDS", "3600"))
KEEPALIVE_EXTENDS_SESSION = os.environ.get("KEEPALIVE_EXTENDS_SESSION", "true").lower() == "true"

# Rate limiting config
RATE_LIMIT_MAX = int(os.environ.get("RATE_LIMIT_MAX", "5"))
RATE_LIMIT_WINDOW = int(os.environ.get("RATE_LIMIT_WINDOW_SECONDS", "60"))

# Account lockout config
LOCKOUT_THRESHOLD = int(os.environ.get("LOCKOUT_THRESHOLD", "5"))
LOCKOUT_DURATION = int(os.environ.get("LOCKOUT_DURATION_SECONDS", "900"))

# Valid test credentials
TEST_USERS = {
    "admin@example.com": "P@ssw0rd12345",
    "operator@example.com": "P@ssw0rd12345",
}

serializer = URLSafeTimedSerializer(SECRET_KEY)

# In-memory state for rate limiting and lockout
_login_attempts: dict[str, list[float]] = defaultdict(list)
_failed_logins: dict[str, int] = defaultdict(int)
_lockout_until: dict[str, float] = {}

# Per-session bearer tokens (generated on login, stable within session)
_session_tokens: dict[str, str] = {}


def _generate_csrf() -> str:
    return secrets.token_hex(32)


def _get_or_create_session_token(email: str) -> str:
    if email not in _session_tokens:
        _session_tokens[email] = f"Bearer e2e-test-token-{uuid.uuid4().hex[:16]}"
    return _session_tokens[email]


def get_session_user(request: Request) -> dict | None:
    """Extract user from signed session cookie."""
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    try:
        data = serializer.loads(token, max_age=SESSION_TTL_SECONDS)
        return data
    except (BadSignature, SignatureExpired):
        return None


def _check_rate_limit(client_ip: str) -> tuple[bool, int]:
    """Returns (is_limited, retry_after_seconds)."""
    now = time.time()
    attempts = _login_attempts[client_ip]
    # Prune old entries
    _login_attempts[client_ip] = [t for t in attempts if now - t < RATE_LIMIT_WINDOW]
    if len(_login_attempts[client_ip]) >= RATE_LIMIT_MAX:
        oldest = min(_login_attempts[client_ip])
        retry_after = int(RATE_LIMIT_WINDOW - (now - oldest)) + 1
        return True, max(retry_after, 1)
    return False, 0


def _check_lockout(email: str) -> tuple[bool, float]:
    """Returns (is_locked, locked_until_timestamp)."""
    if email in _lockout_until:
        if time.time() < _lockout_until[email]:
            return True, _lockout_until[email]
        # Lockout expired — clear it
        del _lockout_until[email]
        _failed_logins[email] = 0
    return False, 0


def _record_failed_login(email: str) -> None:
    _failed_logins[email] += 1
    if _failed_logins[email] >= LOCKOUT_THRESHOLD:
        _lockout_until[email] = time.time() + LOCKOUT_DURATION


def _record_successful_login(email: str) -> None:
    _failed_logins[email] = 0
    if email in _lockout_until:
        del _lockout_until[email]


# Middleware to add auth headers on authenticated responses
@app.middleware("http")
async def add_auth_headers(request: Request, call_next):
    response = await call_next(request)
    user = get_session_user(request)
    if user and user.get("authenticated"):
        email = user.get("email", "")
        bearer = _get_or_create_session_token(email)
        response.headers["Authorization"] = bearer
        response.headers["X-Instance-Url"] = "https://testharness.example.com"
        response.headers["X-API-Session-Id"] = f"api-sid-{uuid.uuid5(uuid.NAMESPACE_DNS, email).hex[:12]}"
        # CSRF header rotates per request
        csrf = request.cookies.get(CSRF_COOKIE)
        if csrf:
            try:
                csrf_val = serializer.loads(csrf, max_age=300)
                response.headers["X-CSRF-Token"] = csrf_val.get("token", "")
            except (BadSignature, SignatureExpired):
                pass
    return response


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    user = get_session_user(request)
    if user:
        return RedirectResponse(url="/dashboard", status_code=302)
    return RedirectResponse(url="/login", status_code=302)


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    user = get_session_user(request)
    if user:
        return RedirectResponse(url="/dashboard", status_code=302)
    csrf = _generate_csrf()
    response = templates.TemplateResponse("login.html", {
        "request": request,
        "error": None,
        "csrf_token": csrf,
    })
    csrf_cookie = serializer.dumps({"token": csrf})
    response.set_cookie(CSRF_COOKIE, csrf_cookie, httponly=True, max_age=300)
    return response


@app.post("/login", response_class=HTMLResponse)
async def login_submit(
    request: Request,
    email: str = Form(...),
    password: str = Form(...),
):
    client_ip = request.client.host if request.client else "unknown"

    # Rate limit check
    is_limited, retry_after = _check_rate_limit(client_ip)
    if is_limited:
        return JSONResponse(
            status_code=429,
            content={"error": "Too many login attempts", "retry_after_seconds": retry_after},
            headers={"Retry-After": str(retry_after)},
        )

    # Record this attempt for rate limiting
    _login_attempts[client_ip].append(time.time())

    # Account lockout check
    is_locked, locked_until = _check_lockout(email)
    if is_locked:
        retry_after_lock = int(locked_until - time.time()) + 1
        return JSONResponse(
            status_code=423,
            content={
                "error": "Account locked",
                "locked_until": locked_until,
                "retry_after_seconds": retry_after_lock,
            },
        )

    if email in TEST_USERS and TEST_USERS[email] == password:
        _record_successful_login(email)
        # Password OK, redirect to OTP page
        otp_token = serializer.dumps({"email": email, "stage": "otp_pending"})
        response = RedirectResponse(url="/otp", status_code=302)
        response.set_cookie("otp_pending", otp_token, httponly=True, max_age=300)
        return response

    _record_failed_login(email)
    csrf = _generate_csrf()
    response = templates.TemplateResponse(
        "login.html", {"request": request, "error": "Invalid credentials", "csrf_token": csrf}
    )
    csrf_cookie = serializer.dumps({"token": csrf})
    response.set_cookie(CSRF_COOKIE, csrf_cookie, httponly=True, max_age=300)
    return response


@app.get("/otp", response_class=HTMLResponse)
async def otp_page(request: Request):
    otp_token = request.cookies.get("otp_pending")
    if not otp_token:
        return RedirectResponse(url="/login", status_code=302)
    try:
        data = serializer.loads(otp_token, max_age=300)
        if data.get("stage") != "otp_pending":
            return RedirectResponse(url="/login", status_code=302)
    except (BadSignature, SignatureExpired):
        return RedirectResponse(url="/login", status_code=302)

    csrf = _generate_csrf()
    response = templates.TemplateResponse("otp.html", {
        "request": request,
        "error": None,
        "csrf_token": csrf,
    })
    csrf_cookie = serializer.dumps({"token": csrf})
    response.set_cookie(CSRF_COOKIE, csrf_cookie, httponly=True, max_age=300)
    return response


@app.post("/otp", response_class=HTMLResponse)
async def otp_submit(
    request: Request,
    otp: str = Form(...),
):
    otp_token = request.cookies.get("otp_pending")
    if not otp_token:
        return RedirectResponse(url="/login", status_code=302)

    try:
        data = serializer.loads(otp_token, max_age=300)
    except (BadSignature, SignatureExpired):
        return RedirectResponse(url="/login", status_code=302)

    if otp != OTP_CODE:
        csrf = _generate_csrf()
        response = templates.TemplateResponse(
            "otp.html", {"request": request, "error": "Invalid OTP code", "csrf_token": csrf}
        )
        csrf_cookie = serializer.dumps({"token": csrf})
        response.set_cookie(CSRF_COOKIE, csrf_cookie, httponly=True, max_age=300)
        return response

    # OTP valid — create full session
    email = data["email"]
    session_id = uuid.uuid4().hex[:16]
    session_data = {"email": email, "authenticated": True, "created_at": time.time(), "session_id": session_id}
    session_token = serializer.dumps(session_data)

    # Generate a stable bearer token for this session
    _get_or_create_session_token(email)

    csrf = _generate_csrf()
    response = RedirectResponse(url="/dashboard", status_code=302)
    response.set_cookie(SESSION_COOKIE, session_token, httponly=True, max_age=SESSION_TTL_SECONDS)
    response.delete_cookie("otp_pending")
    csrf_cookie = serializer.dumps({"token": csrf})
    response.set_cookie(CSRF_COOKIE, csrf_cookie, httponly=True, max_age=300)
    return response


@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard(request: Request):
    user = get_session_user(request)
    if not user or not user.get("authenticated"):
        return RedirectResponse(url="/login", status_code=302)

    csrf = _generate_csrf()
    session_id = user.get("session_id", uuid.uuid4().hex[:16])
    access_token = uuid.uuid5(uuid.NAMESPACE_DNS, user["email"]).hex[:24]
    created_at = user.get("created_at", time.time())
    ttl_remaining = max(0, int(SESSION_TTL_SECONDS - (time.time() - created_at)))

    response = templates.TemplateResponse("dashboard.html", {
        "request": request,
        "user": user,
        "csrf_token": csrf,
        "session_id": session_id,
        "access_token": access_token,
        "ttl_remaining": ttl_remaining,
    })
    csrf_cookie = serializer.dumps({"token": csrf})
    response.set_cookie(CSRF_COOKIE, csrf_cookie, httponly=True, max_age=300)
    return response


@app.get("/logout")
async def logout():
    response = RedirectResponse(url="/login", status_code=302)
    response.delete_cookie(SESSION_COOKIE)
    response.delete_cookie("otp_pending")
    response.delete_cookie(CSRF_COOKIE)
    return response


@app.post("/logout")
async def logout_post():
    response = RedirectResponse(url="/login", status_code=302)
    response.delete_cookie(SESSION_COOKIE)
    response.delete_cookie("otp_pending")
    response.delete_cookie(CSRF_COOKIE)
    return response


@app.get("/api/me")
async def api_me(request: Request):
    user = get_session_user(request)
    if not user or not user.get("authenticated"):
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})
    return {
        "user_id": user["email"],
        "email": user["email"],
        "authenticated": True,
        "session_id": user.get("session_id", ""),
    }


@app.post("/api/keepalive")
async def api_keepalive(request: Request):
    user = get_session_user(request)
    if not user or not user.get("authenticated"):
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})

    created_at = user.get("created_at", time.time())
    ttl_remaining = max(0, int(SESSION_TTL_SECONDS - (time.time() - created_at)))

    result = {
        "status": "ok",
        "session_refreshed": KEEPALIVE_EXTENDS_SESSION,
        "ttl_remaining_seconds": ttl_remaining,
    }

    if KEEPALIVE_EXTENDS_SESSION:
        # Refresh the session cookie with a new created_at
        user["created_at"] = time.time()
        session_token = serializer.dumps(user)
        response = JSONResponse(content=result)
        response.set_cookie(SESSION_COOKIE, session_token, httponly=True, max_age=SESSION_TTL_SECONDS)
        result["ttl_remaining_seconds"] = SESSION_TTL_SECONDS
        return response

    return result


@app.get("/api/session-info")
async def api_session_info(request: Request):
    user = get_session_user(request)
    if not user or not user.get("authenticated"):
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})

    created_at = user.get("created_at", time.time())
    age = int(time.time() - created_at)
    ttl_remaining = max(0, SESSION_TTL_SECONDS - age)
    csrf_val = ""
    csrf_cookie = request.cookies.get(CSRF_COOKIE)
    if csrf_cookie:
        try:
            csrf_data = serializer.loads(csrf_cookie, max_age=300)
            csrf_val = csrf_data.get("token", "")
        except (BadSignature, SignatureExpired):
            pass

    return {
        "email": user["email"],
        "authenticated": True,
        "session_age_seconds": age,
        "ttl_remaining_seconds": ttl_remaining,
        "session_id": user.get("session_id", ""),
        "csrf_token": csrf_val,
    }


@app.get("/api/rate-limit-status")
async def api_rate_limit_status(request: Request):
    client_ip = request.client.host if request.client else "unknown"
    now = time.time()
    recent = [t for t in _login_attempts.get(client_ip, []) if now - t < RATE_LIMIT_WINDOW]
    return {
        "client_ip": client_ip,
        "attempts_in_window": len(recent),
        "max_allowed": RATE_LIMIT_MAX,
        "window_seconds": RATE_LIMIT_WINDOW,
    }


@app.post("/api/admin/unlock/{email}")
async def api_admin_unlock(email: str):
    _failed_logins[email] = 0
    if email in _lockout_until:
        del _lockout_until[email]
    return {"status": "ok", "email": email, "unlocked": True}


@app.get("/health")
async def health():
    return {"status": "ok"}
