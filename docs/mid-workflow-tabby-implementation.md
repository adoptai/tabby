# Mid-Workflow Tabby Resolution — Implementation Reference

## Overview

When a Copilot user sends free text (e.g. "create a quote for me"), the platform does not know which action will be selected until a routing LLM runs inside the Temporal workflow. If the selected action requires Tabby credentials, the workflow pauses via a `wait_condition`, notifies adoptwebui to resolve tokens (triggering HITL in Tabby if the browser session needs a human login), and resumes with the real credentials once they are available.

The MCP path is unaffected: python-mcp resolves Tabby tokens at the API layer before dispatching to the workflow, and sets `tabby_pre_resolved=True` in metadata so the workflow skips mid-flight resolution entirely.

---

## Architecture

```
┌──────────┐     ┌───────────┐     ┌──────────────────────┐     ┌───────┐
│   User   │────→│ adoptwebui│────→│ NLWDLExecutionWorkflow│────→│ Tabby │
│ (Copilot)│     │           │     │   (adoptai-workflows) │     │       │
└──────────┘     └───────────┘     └──────────────────────┘     └───────┘
     │                 │                       │                      │
     │  free text msg  │                       │                      │
     │────────────────→│                       │                      │
     │                 │  dispatch (no Tabby)  │                      │
     │                 │──────────────────────→│                      │
     │                 │                       │ routing → selects    │
     │                 │                       │ CPQ action (Tabby)   │
     │                 │                       │ a3_meta.status ==    │
     │                 │                       │ "tabby_credentials_  │
     │                 │                       │  needed"             │
     │                 │  POST /v1/internal/   │                      │
     │                 │  tabby-resolution-    │                      │
     │                 │  needed               │                      │
     │                 │←──────────────────────│                      │
     │                 │                       │ wait_condition(       │
     │                 │                       │   _tabby_resolved)   │
     │                 │ /credentials/request  │                      │
     │                 │─────────────────────────────────────────────→│
     │                 │                       │                      │
     │ [HITL card if   │                       │                      │
     │  login needed]  │                       │                      │
     │←────────────────│                       │                      │
     │  human resolves │                       │                      │
     │────────────────→│                       │                      │
     │                 │ POST /api/v1/tabby-   │                      │
     │                 │ resolution/signal     │                      │
     │                 │──────────────────────→│                      │
     │                 │                       │ _tabby_resolved=True │
     │                 │                       │ re-run action with   │
     │                 │                       │ real headers         │
     │  result         │       result          │                      │
     │←────────────────│←──────────────────────│                      │
```

**`tabby_pre_resolved` path (MCP):** python-mcp resolves tokens before dispatch. `metadata.tabby_pre_resolved=True` causes the workflow to skip the entire mid-workflow block. No pause, no callback, no signal.

---

## Components

### adoptai-workflows

#### `src/workflows/nl_wdl_execution/workflow.py`

**New workflow state variables** (lines 48–49):
- `self._tabby_resolved: bool = False` — flipped to `True` by the signal handler to unblock `wait_condition`
- `TABBY_RESOLUTION_TIMEOUT = timedelta(minutes=10)` — maximum wait before the workflow continues without credentials

**Mid-workflow detection block** (lines 240–300): After `execute_user_query_activity` returns, the workflow reads `a3_metadata` from the response. If `a3_meta["status"] == "tabby_credentials_needed"` and `tabby_pre_resolved` is not set in metadata, it:
1. Calls `notify_tabby_needed_activity` (fire-and-forget with a 30s timeout)
2. Resets `_tabby_resolved = False`
3. Awaits `workflow.wait_condition(lambda: self._tabby_resolved, timeout=TABBY_RESOLUTION_TIMEOUT)`
4. If resolved: re-runs `execute_user_query_activity` with the updated `_last_request_context["security_headers"]`
5. If timed out: logs a warning and proceeds with the original (empty) response

**`tabby_resolution_signal` signal handler** (lines 571–595):
```python
@workflow.signal
def tabby_resolution_signal(self, payload_json: str):
    payload = json.loads(payload_json)
    resolved_headers = payload.get("security_headers")
    if not isinstance(resolved_headers, dict):
        raise ValueError(...)
    if self._last_request_context is not None:
        self._last_request_context["security_headers"] = resolved_headers
    self._tabby_resolved = True
```

The signal mutates `_last_request_context` in place so the re-run of `execute_user_query_activity` uses the real credentials from Tabby. The `request` variable in the workflow loop still points to `_last_request_context`, so the updated headers flow through to `json.dumps(request["security_headers"])` in the retry call.

#### `src/workflows/nl_wdl_execution/activities.py`

**`notify_tabby_needed_activity`** (lines 772–829): A Temporal activity that POSTs to `{ADOPT_API_ENDPOINT}/v1/internal/tabby-resolution-needed`. Raises `ValueError` if `ADOPT_API_ENDPOINT` is not configured (hard fail — misconfiguration should surface early). Accepts 200 or 202 as success (202 = HITL required, workflow stays paused). Non-2xx status codes call `raise_for_status()`, causing Temporal to retry per the workflow's retry policy.

```python
@activity.defn
async def notify_tabby_needed_activity(
    conversation_id: str,
    action_id: str,
    profile_id: str,
    workflow_id: str,
) -> None:
```

### adoptai-workflows API

#### `api/app/routers/tabby_resolution.py`

A dedicated FastAPI router mounted at `/api/v1/tabby-resolution`. Receives the resolved security headers from adoptwebui and forwards them to the paused Temporal workflow using the Temporal Python SDK client.

**`POST /api/v1/tabby-resolution/signal`**: Accepts `{workflow_id, security_headers}`, fetches the workflow handle via `get_client()`, and calls `handle.signal("tabby_resolution_signal", payload_json)`.

### adoptwebui

#### `backend/app/routes/internal_tabby.py`

Internal FastAPI router mounted at `/v1/internal`. Not exposed publicly — callable only from adoptai-workflows (internal network).

**`POST /v1/internal/tabby-resolution-needed`** (lines 92–205): The main resolution endpoint. Steps:
1. Looks up the `PlaygroundProfile` by `profile_id` to get `org_id` and `security_headers` (the raw token names, e.g. `{"X-Cookie": "sfdc_cookie"}`)
2. Calls `resolve_tabby_tokens(force_tabby=True, ...)` which hits Tabby's `/credentials/request` API
3. On success: calls `_signal_workflow()` with the resolved headers and returns 200
4. On `TabbySessionNotHealthyError`: emits a `tabby_hitl_required` event to `stream:request:{conversation_id}` via Redis, and returns 202. The workflow remains paused. The frontend HITL resolve flow later calls `/tabby-resolution-signal`.

**`POST /v1/internal/tabby-resolution-signal`** (lines 208–232): Called after human HITL resolution. Receives `{workflow_id, security_headers}` and calls `_signal_workflow()` directly. This is the endpoint that completes the round-trip after a human resolves the Tabby VNC session.

**`_signal_workflow(workflow_id, security_headers)`** (lines 56–75): Posts to `{ADOPT_WORKFLOW_URL}/api/v1/tabby-resolution/signal` using the `AdoptWorkflowSettings.adopt_workflow_url` config value.

#### `backend/app/services/tabby_resolution_service.py`

**`resolve_tabby_tokens()`** (lines 38–217): Core resolution function. When called with `force_tabby=True` (as the internal endpoint does), it skips the deployment-rules DB check and goes straight to token resolution. The `TabbySessionNotHealthyError` exception (line 445) is raised when the Tabby session is not `HEALTHY` and no credentials can be fetched — this is the signal that HITL is required.

The service supports three Tabby authentication modes (falling through in order):
1. Redis-cached federated token (per-user, 59min TTL)
2. OIDC token exchange: user's Frontegg JWT → Tabby federated token via `/auth/token-exchange`
3. Agent assertion: per-user `UserTabbyConfig` credentials → agent token → token exchange

For mid-workflow resolution, `user_id=None` and `user_jwt=None` are passed (the workflow has no user context), so modes 2 and 3 are unavailable. The service must fall back to the profile-level agent client or raise. Ensure the `PlaygroundProfile` has an agent-capable auth method configured for service-level calls.

**`build_hitl_response(session_status)`** (lines 470–513): Constructs the `tabby_hitl_required` event payload from Tabby's session status. Detects "warming up" (pod not yet scheduled: `vnc_url is None and step_index is None`) and includes `retry_after_seconds=45` in that case.

---

## The `tabby_pre_resolved` Flag

`tabby_pre_resolved` is a boolean field set in `request["metadata"]` before the workflow is dispatched. When `True`, the mid-workflow detection block is skipped entirely:

```python
# workflow.py, lines 240–245
tabby_pre_resolved = request.get("metadata", {}).get("tabby_pre_resolved", False)
a3_meta = getattr(actionbot_response, "a3_metadata", {}) or {}
tabby_credentials_needed = (
    not tabby_pre_resolved
    and a3_meta.get("status") == "tabby_credentials_needed"
)
```

**Who sets it:** python-mcp sets `tabby_pre_resolved=True` in the workflow dispatch payload when it has already resolved Tabby tokens at the API layer (before calling `create_conversation` / dispatching to the workflow). This is the "pre-resolution" path described in the original plan as Option A.

**Why it exists:** Without this guard, if ProjectA3's A3 still returns `status: tabby_credentials_needed` even after pre-resolution (e.g. a bug, or because the token expired during the activity), the workflow would enter the mid-flight pause a second time, resulting in a double-resolution loop. The flag prevents this by making the paths mutually exclusive.

**Default:** `False` (absent from metadata). All Copilot free-text paths go through mid-workflow resolution when A3 signals credentials are needed.

---

## Signal Flow

### Scenario 1: Copilot free text → Tabby action → session HEALTHY

1. User sends "create a quote for me"
2. adoptwebui dispatches `NLWDLExecutionWorkflow` with empty `security_headers` and no `tabby_pre_resolved`
3. Workflow runs `execute_user_query_activity` → A3 routes to CPQ action, detects missing Tabby creds, returns `a3_metadata.status = "tabby_credentials_needed"` with `action_id` and `profile_id`
4. Workflow calls `notify_tabby_needed_activity(conversation_id, action_id, profile_id, workflow_id)`
5. Activity POSTs to `POST /v1/internal/tabby-resolution-needed`
6. adoptwebui looks up the profile, calls `resolve_tabby_tokens(force_tabby=True)`, Tabby session is HEALTHY → returns real cookie values
7. adoptwebui calls `_signal_workflow()` → POSTs to `POST /api/v1/tabby-resolution/signal`
8. adoptai-workflows API signals the Temporal workflow with `tabby_resolution_signal`
9. Signal handler updates `_last_request_context["security_headers"]` with real values and sets `_tabby_resolved = True`
10. `wait_condition` unblocks; workflow re-runs `execute_user_query_activity` with real credentials
11. Action executes successfully; result returned to user

### Scenario 2: Copilot free text → non-Tabby action selected

1–3. Same as Scenario 1 through routing
4. A3 selects a non-Tabby action → `a3_metadata.status` is not `"tabby_credentials_needed"`
5. `tabby_credentials_needed` condition is `False` → no pause, no callback
6. Workflow proceeds directly to `ingest_wdl_result` and returns result

### Scenario 3: Copilot free text → Tabby action → session needs HITL

1–5. Same as Scenario 1 through the `POST /v1/internal/tabby-resolution-needed` call
6. `resolve_tabby_tokens()` calls Tabby `/credentials/request` → Tabby session is `LOGIN_NEEDED` → raises `TabbySessionNotHealthyError`
7. adoptwebui catches the exception, builds HITL payload via `build_hitl_response()`, emits `tabby_hitl_required` event to `stream:request:{conversation_id}` Redis stream
8. adoptwebui returns HTTP 202 to the activity (workflow stays paused on `wait_condition`)
9. Experience SDK receives the stream event, Copilot frontend renders the VNC/HITL card
10. Human opens VNC, logs in, clicks "Mark as Resolved"
11. Tabby marks the session HEALTHY, notifies Slack bot
12. HITL resolve flow calls `POST /v1/internal/tabby-resolution-signal` with `{workflow_id, security_headers}`
13. adoptwebui calls `_signal_workflow()` → workflow resumes as in steps 8–11 of Scenario 1

### Scenario 4: MCP direct action → pre-resolved

1. python-mcp dispatches workflow with `metadata.tabby_pre_resolved=True` and already-resolved `security_headers`
2. Workflow runs `execute_user_query_activity` with real credentials
3. Even if A3 somehow returns `status: tabby_credentials_needed`, `tabby_pre_resolved=True` makes `tabby_credentials_needed = False` → block is skipped
4. Workflow continues normally

### Scenario 5: Tabby offline

1–4. Same as Scenario 1
5. `notify_tabby_needed_activity` POSTs to adoptwebui successfully (returning 500 if Tabby is unreachable, or 404 if the profile is not found)
6. If the activity fails, Temporal retries up to 2 times (per `retry_policy.maximum_attempts=2`)
7. If all retries fail, the activity raises and the exception propagates to the workflow's `except Exception` handler (line 525), setting `self.results = {"status": "failure", ...}`
8. The `wait_condition` is never reached; the workflow terminates with an error result

---

## API Endpoints

### adoptwebui

#### `POST /v1/internal/tabby-resolution-needed`

Called by `notify_tabby_needed_activity` when the workflow detects it needs Tabby credentials.

**Request body:**
```json
{
  "conversation_id": "conv-abc123",
  "action_id": "action-uuid",
  "profile_id": "playground-profile-uuid",
  "workflow_id": "temporal-workflow-id"
}
```

**Responses:**
- `200 {"status": "resolved"}` — tokens resolved, `tabby_resolution_signal` already sent to workflow
- `202 {"status": "hitl_required", "hitl": {...}}` — session not healthy, HITL card emitted to Redis stream, workflow remains paused
- `404` — `profile_id` not found in DB
- `500` — unexpected error

**Who calls it:** `notify_tabby_needed_activity` in adoptai-workflows. Internal network only.

#### `POST /v1/internal/tabby-resolution-signal`

Called after human HITL resolution to unblock a paused workflow.

**Request body:**
```json
{
  "workflow_id": "temporal-workflow-id",
  "security_headers": {"X-Cookie": "real-cookie-value=abc123"}
}
```

**Responses:**
- `200 {"status": "signal_sent"}` — signal dispatched
- `500` — Temporal unreachable or signal failed

**Who calls it:** The HITL resolve flow (e.g. VNC "Mark as Resolved" callback or a frontend HITL resolution handler) after fetching fresh Tabby credentials.

### adoptai-workflows API

#### `POST /api/v1/tabby-resolution/signal`

Receives the resolved credentials from adoptwebui and delivers them to the Temporal workflow via the Python SDK.

**Request body:**
```json
{
  "workflow_id": "temporal-workflow-id",
  "security_headers": {"X-Cookie": "real-cookie-value=abc123"}
}
```

**Responses:**
- `200 {"status": "signal_sent", "workflow_id": "..."}` — signal delivered
- `500` — workflow not found or Temporal error

**Who calls it:** `_signal_workflow()` in `adoptwebui/backend/app/routes/internal_tabby.py`.

---

## Configuration

### adoptai-workflows

| Env var | Where used | Description |
|---------|-----------|-------------|
| `ADOPT_API_ENDPOINT` | `notify_tabby_needed_activity` via `get_settings().adopt_api_endpoint` | Base URL of adoptwebui (e.g. `http://adoptwebui.internal`). No trailing slash. Missing or empty → activity raises `ValueError` immediately. |

### adoptwebui

| Env var / config | Where used | Description |
|------------------|-----------|-------------|
| `AdoptWorkflowSettings.adopt_workflow_url` | `_signal_workflow()` | Base URL of adoptai-workflows API (e.g. `http://workflows.internal`). |
| Redis connection | `_get_redis_manager()` → `RedisStreamManager` | Used to emit `tabby_hitl_required` stream events. If Redis is unavailable, the HITL card is not emitted but the 202 is still returned (non-fatal, logged as warning). |
| DB (PostgreSQL) | `PlaygroundProfile` lookup | Profile must exist and have `security_headers` populated with token name map. |

---

## Testing

### adoptai-workflows

**File:** `/home/moraski/work/adoptai-workflows/tests/test_tabby_resolution_workflow.py`

Three test classes:

1. **`TestTabbyResolutionSignalLogic`** (7 tests) — tests the signal handler logic extracted as a pure function. Covers: valid payload updates headers and sets `_tabby_resolved`, `None` context (still resolves), invalid JSON raises, non-dict `security_headers` raises, empty dict is valid, unrelated context keys preserved, multiple headers replaced.

2. **`TestNotifyTabbyNeededActivity`** (5 tests) — tests the async activity via `IsolatedAsyncioTestCase` with mocked `httpx.AsyncClient`. Covers: successful POST, missing `ADOPT_API_ENDPOINT` raises `ValueError`, `None` endpoint raises, non-2xx raises, 202 is accepted, trailing slash stripped from base URL.

3. **`TestTabbyCredentialsNeededDetection`** (7 tests) — tests the detection condition as pure Python. Covers: fires when A3 returns `tabby_credentials_needed` without pre-resolved, skipped when `tabby_pre_resolved=True`, skipped when A3 status is different, absent metadata, explicit `False` still fires.

**Run:**
```bash
cd /home/moraski/work/adoptai-workflows
python -m pytest tests/test_tabby_resolution_workflow.py -v
```

### adoptwebui

**File:** `/home/moraski/work/adoptwebui/backend/tests/test_internal_tabby.py`

Seven test classes:

1. **`TestHandleTabbyResolutionNeededSuccess`** (2 tests) — happy path: tokens resolved and signal sent; `profile.security_headers` passed as `raw_headers` to `resolve_tabby_tokens`.
2. **`TestHandleTabbyResolutionNeededHitl`** (2 tests) — HITL path: 202 returned, stream event emitted to correct Redis key; missing Redis handled gracefully.
3. **`TestHandleTabbyResolutionNeededProfileNotFound`** (1 test) — 404 on unknown profile.
4. **`TestHandleTabbyResolutionNeededError`** (1 test) — 500 on unexpected exception.
5. **`TestSendTabbyResolutionSignal`** (2 tests) — success returns `signal_sent`; failure returns 500.
6. **`TestSignalWorkflow`** (2 tests) — `_signal_workflow` calls the correct adoptai-workflows endpoint with correct body; 5xx raises.

**Run:**
```bash
cd /home/moraski/work/adoptwebui/backend
python -m pytest tests/test_internal_tabby.py -v
```

---

## Future: MCP Integration

### What currently happens in the MCP path

python-mcp sets `tabby_pre_resolved=True` in the workflow dispatch metadata and passes already-resolved `security_headers`. The resolution happens at the API layer before the workflow starts, using `resolve_tabby_tokens_or_hitl()` in `tabby_resolution_service.py`. If the session is not healthy at dispatch time, the MCP call itself returns a HITL response — the workflow is never started.

This is "Option A" from the original plan: pre-resolution at the API boundary, before the routing LLM runs.

### What would change for MCP to use mid-workflow resolution

1. **python-mcp would stop pre-resolving tokens** and stop setting `tabby_pre_resolved=True`
2. **python-mcp would pass raw token names** (e.g. `{"X-Cookie": "sfdc_cookie"}`) in `security_headers`, same as Copilot does
3. **The workflow would handle HITL mid-flight** for MCP calls, pausing and waiting up to 10 minutes
4. **MCP call semantics would change**: today MCP calls are synchronous (the caller blocks until the workflow result is available). If the workflow pauses for HITL, the MCP SDK's blocking wait would need to be extended beyond the current timeout, or the MCP tool would need to return a "pending" result and the caller would poll

Concretely, `workflow.py` requires no code changes. The detection condition already handles this:
```python
tabby_pre_resolved = request.get("metadata", {}).get("tabby_pre_resolved", False)
# Setting this to False (or omitting it) enables mid-workflow resolution for MCP
```

The profile lookup in `handle_tabby_resolution_needed` already works for service-level calls (`user_id=None, user_jwt=None`), since it uses the profile-level auth rather than per-user credentials.

### What `tabby_pre_resolved` means for this

The flag is the **only** thing preventing mid-workflow resolution from triggering for MCP calls today. Removing `tabby_pre_resolved=True` from the MCP dispatch payload is the sole code change in python-mcp needed to switch it to the mid-workflow path.

The flag was added specifically as an escape hatch to make the two paths mutually exclusive during the initial rollout, so mid-workflow resolution could be deployed without breaking the already-working MCP path.

### Trade-offs of switching MCP to mid-workflow vs keeping pre-resolution

| Aspect | Keep pre-resolution (current) | Switch to mid-workflow |
|--------|-------------------------------|------------------------|
| Session cold-start UX | MCP call blocks ~150s on pod startup before returning any response | Workflow starts immediately; pod startup happens mid-flight; MCP caller gets a "pending" or long-polling response |
| Latency (session HEALTHY) | ~100ms overhead at dispatch time | ~200ms round-trip for callback + signal |
| False Tabby triggers | Only when MCP explicitly calls a Tabby action (action_id is always known) | Only when A3 returns `tabby_credentials_needed` — same trigger, different timing |
| HITL during MCP call | HITL response returned synchronously to MCP caller | HITL pauses the workflow; MCP caller must wait or poll |
| MCP SDK changes needed | None | May need extended timeouts or async/polling semantics |
| Failure isolation | Tabby failure blocks MCP dispatch | Tabby failure surfaces inside the workflow, not at the MCP API boundary |
| Complexity | Pre-resolution logic stays in python-mcp | All resolution in one place (the workflow) |

The main obstacle to switching MCP is the synchronous nature of current MCP tool invocations. The mid-workflow path works best when the caller can tolerate being notified asynchronously (as Copilot does via the Redis experience stream). MCP callers today expect a synchronous JSON response. Switching would require either extending the MCP SDK's blocking timeout to cover HITL duration (minutes to hours) or adding a polling/webhook callback mechanism to the MCP tool contract.
