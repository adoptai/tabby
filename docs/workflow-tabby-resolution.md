# Mid-Workflow Tabby Resolution via Temporal Signals

## Problem

When a user sends free text to the Copilot ("create a quote for me"), the platform cannot resolve Tabby credentials at the API layer because:

1. The API receives the user's message **without an `action_id`** — the user typed free text, not a specific action
2. The API dispatches the message to a Temporal workflow (`NLWDLExecutionWorkflow`)
3. The workflow runs a **RoutingPrompt** (LLM) that selects which action to use
4. Only **after** routing does the system know the action requires Tabby
5. By then, the workflow already has empty `security_headers` — no Tabby tokens were resolved

### Current workaround (Option A)

If the org has `use_tabby=True` on the default Playground Profile, the API pre-resolves Tabby tokens for **every** message before dispatching to the workflow. This works but has downsides:

- Every free-text message triggers Tabby resolution (even "what can you do?")
- If the session is cold (no active worker), the user waits 2+ minutes for pod startup before the workflow even starts
- If the action selected by routing doesn't need Tabby, the resolution was wasted

### The real fix

Tabby resolution should happen **inside the workflow**, after the RoutingPrompt selects an action that requires Tabby, and before that action executes.

---

## Solution: Temporal Signal-Based Pause

### How it works

```
User: "create a quote for me"
  → API dispatches to NLWDLExecutionWorkflow (no Tabby resolution)
  → Workflow runs RoutingPrompt → selects "CPQ Quote Creation"
  → Workflow checks: does this action need Tabby? → YES
  → Workflow emits "tabby_needed" event to Redis stream (user sees progress)
  → Workflow sets _tabby_paused = True
  → Workflow calls await workflow.wait_condition(lambda: self._tabby_resolved)
  → API receives callback → resolves Tabby tokens → provisions session if needed
  → HITL card shown to user if login required
  → User completes login via VNC
  → API sends signal to workflow with resolved security_headers
  → Workflow resumes with real credentials
  → Action executes successfully
```

### What already exists

| Component | Status | Location |
|-----------|--------|----------|
| Temporal signal infrastructure | ✅ Exists | `POST /api/v1/workflows/signal` in adoptai-workflows |
| `wait_condition` pattern | ✅ Used | `NLWDLExecutionWorkflow` already waits for `user_input_signal` between turns |
| HITL pause pattern | ✅ Used | `_hitl_paused=True` extends wait timeout to 7 days |
| Signal handler pattern | ✅ Used | `hitl_resolution_signal` injects external resolution into workflow |
| `_last_request_context` | ✅ Exists | Stores last request dict including `security_headers` for replay |
| Redis stream events | ✅ Exists | `stream:request:{conversation_id}` used by Experience SDK |
| `tabby_provisioning` activity | ✅ Just added | Emits progress events during polling loop |
| HITL card rendering | ✅ Exists | Experience SDK handles `tabby_hitl_required` responses |
| Tabby resolution service | ✅ Exists | `resolve_tabby_tokens()` in adoptwebui |

### What needs to be built

#### 1. adoptai-workflows: New signal + detection

**File:** `src/workflows/nl_wdl_execution/workflow.py`

**New signal handler:**
```python
@workflow.signal
async def tabby_resolution_signal(self, payload_json: str) -> None:
    """Receives resolved Tabby security_headers from the API."""
    payload = json.loads(payload_json)
    self._last_request_context["security_headers"] = payload["security_headers"]
    self._tabby_resolved = True
```

**Detection in activity:** After `execute_user_query_activity` returns, check if the result indicates Tabby credentials were needed but missing. ProjectA3's `ActionExecutorV2` would need to return a structured error like:
```json
{
  "status": "tabby_credentials_needed",
  "action_id": "123",
  "profile_id": "salesforce-human-assisted-aa"
}
```

**Workflow loop change:**
```python
result = await workflow.execute_activity(
    execute_user_query_activity, ...
)

if result.get("status") == "tabby_credentials_needed":
    # Notify API that we need Tabby resolution
    await workflow.execute_activity(
        notify_tabby_needed_activity,
        args=[conversation_id, result["action_id"], result["profile_id"]],
    )
    # Pause and wait for resolution signal
    self._tabby_resolved = False
    await workflow.wait_condition(
        lambda: self._tabby_resolved,
        timeout=timedelta(minutes=10),
    )
    if not self._tabby_resolved:
        # Timeout — Tabby never resolved
        # Emit error to stream and continue without Tabby
        pass
    else:
        # Re-run the same query with resolved headers
        result = await workflow.execute_activity(
            execute_user_query_activity, ...
        )
```

#### 2. adoptai-workflows: Callback activity

**New activity:** `notify_tabby_needed_activity`

Calls back to adoptwebui API to trigger Tabby resolution:
```python
@activity.defn
async def notify_tabby_needed_activity(
    conversation_id: str,
    action_id: str,
    profile_id: str,
) -> None:
    """Notify the API that this workflow needs Tabby credentials."""
    async with httpx.AsyncClient() as client:
        await client.post(
            f"{ADOPT_API_URL}/v1/internal/tabby-resolution-needed",
            json={
                "conversation_id": conversation_id,
                "action_id": action_id,
                "profile_id": profile_id,
                "workflow_id": activity.info().workflow_id,
            },
        )
```

#### 3. adoptwebui: Resolution endpoint

**New endpoint:** `POST /v1/internal/tabby-resolution-needed`

```python
@router.post("/internal/tabby-resolution-needed")
async def handle_tabby_needed(request: TabbyResolutionRequest):
    """Called by the workflow when it needs Tabby credentials mid-execution."""
    # 1. Resolve Tabby tokens (may trigger HITL if session needs login)
    resolved, hitl_response = await resolve_tabby_tokens_or_hitl(
        security_headers=request.security_headers,
        action_id=request.action_id,
        org_id=request.org_id,
        db=db,
        conversation_id=request.conversation_id,
    )

    if hitl_response:
        # HITL needed — emit to stream, wait for human
        # The frontend shows the HITL card
        # After human resolves, /tabby-resolve-hitl is called
        # Which then signals the workflow
        return hitl_response

    # 2. Tokens resolved — signal the workflow to resume
    await signal_workflow(
        workflow_id=request.workflow_id,
        signal_name="tabby_resolution_signal",
        payload={"security_headers": resolved},
    )
    return {"status": "resolved"}
```

#### 4. adoptwebui: Signal dispatch

**New function** in workflow integration layer:
```python
async def signal_workflow(workflow_id: str, signal_name: str, payload: dict):
    """Send a signal to a running Temporal workflow."""
    async with httpx.AsyncClient() as client:
        await client.post(
            f"{ADOPT_WORKFLOW_URL}/api/v1/workflows/signal",
            params={"workflow_id": workflow_id},
            json={"signal_name": signal_name, "payload": payload},
        )
```

#### 5. ProjectA3: Return structured error when Tabby needed

Inside `ActionExecutorV2` (or the WDL execution layer), when `security_headers` contains unresolved token names (the raw names like `sfdc_cookie` instead of actual cookie values), return:
```json
{
  "status": "tabby_credentials_needed",
  "action_id": "...",
  "missing_tokens": ["sfdc_cookie", "aura_token"]
}
```

This is the trickiest part — ProjectA3 currently doesn't know about Tabby. It just receives `security_params` and uses them. The detection could be: if a security_param value matches a known token name pattern (no `=` sign, no base64, etc.), it's unresolved.

---

## Data flow diagram

```
┌──────────┐     ┌───────────┐     ┌──────────────┐     ┌───────┐
│   User   │────→│ adoptwebui│────→│ Temporal WF  │────→│ Tabby │
│ (Copilot)│     │   (API)   │     │ (workflows)  │     │ (API) │
└──────────┘     └───────────┘     └──────────────┘     └───────┘
     │                 │                   │                  │
     │  1. "create     │                   │                  │
     │     quote"      │                   │                  │
     │────────────────→│                   │                  │
     │                 │  2. Dispatch WF   │                  │
     │                 │  (no tabby yet)   │                  │
     │                 │──────────────────→│                  │
     │                 │                   │  3. Route →      │
     │                 │                   │  selects CPQ     │
     │                 │                   │  (needs tabby)   │
     │                 │  4. Callback:     │                  │
     │                 │  "need tabby      │                  │
     │                 │   for action X"   │                  │
     │                 │←──────────────────│                  │
     │                 │                   │  5. WF pauses    │
     │                 │                   │  (wait_condition) │
     │                 │  6. Resolve       │                  │
     │                 │  Tabby tokens     │                  │
     │                 │─────────────────────────────────────→│
     │                 │                   │                  │
     │  7. HITL card   │                   │                  │
     │  (if login      │                   │                  │
     │   needed)       │                   │                  │
     │←────────────────│                   │                  │
     │                 │                   │                  │
     │  8. Human       │                   │                  │
     │  resolves VNC   │                   │                  │
     │────────────────→│                   │                  │
     │                 │  9. Signal WF     │                  │
     │                 │  with resolved    │                  │
     │                 │  headers          │                  │
     │                 │──────────────────→│                  │
     │                 │                   │  10. WF resumes  │
     │                 │                   │  executes action │
     │                 │                   │  with real creds │
     │  11. Result     │                   │                  │
     │←────────────────│←──────────────────│                  │
```

---

## Testing

### Unit tests

1. **Workflow signal handler**: send `tabby_resolution_signal` with mock headers → verify `_last_request_context` updated and `_tabby_resolved` set
2. **Detection logic**: mock `execute_user_query_activity` returning `tabby_credentials_needed` → verify workflow pauses
3. **Timeout**: workflow pauses, no signal sent within 10 min → verify workflow continues with error
4. **Callback endpoint**: mock Tabby online → verify tokens resolved and signal sent
5. **Callback endpoint**: mock Tabby offline → verify error response and no signal sent

### Integration tests

1. **Happy path**: send free text → workflow selects Tabby action → callback → resolve → signal → action executes
2. **HITL path**: send free text → workflow selects Tabby action → callback → session needs login → HITL card shown → human resolves → signal → action executes
3. **Tabby offline**: send free text → workflow selects Tabby action → callback → Tabby unreachable → error shown to user
4. **Non-Tabby action**: send free text → workflow selects non-Tabby action → no callback, no pause, executes normally
5. **Timeout**: workflow pauses → no one resolves → 10 min timeout → error message to user

### Manual testing

1. Send "create a quote for me" with Tabby online, session HEALTHY → should execute instantly (tokens from cache)
2. Send "create a quote for me" with Tabby online, no session → should show HITL card, user logs in, action resumes
3. Send "create a quote for me" with Tabby offline → should show "Browser automation service is unreachable"
4. Send "what can you do?" with Tabby online → should NOT trigger Tabby (non-Tabby action selected by routing)

---

## Trade-offs

| Aspect | Option A (current) | Option C (this plan) |
|--------|-------------------|---------------------|
| Latency (session exists) | ~100ms (pre-resolve) | ~200ms (callback + signal round-trip) |
| Latency (cold start) | 2+ min blocking before workflow starts | Workflow starts immediately, pauses mid-flight |
| False positive Tabby triggers | Every message if org has use_tabby | Only when action actually needs Tabby |
| User experience during cold start | "Thinking..." for 2+ min | Workflow starts, shows routing progress, THEN shows "provisioning browser..." |
| Complexity | 2 lines of code | 4 repos changed (adoptwebui, adoptai-workflows, ProjectA3, maybe python-mcp) |
| Failure isolation | Tabby failure blocks all messages | Tabby failure only blocks Tabby actions |
| MCP impact | Works (already sends action_id) | Works (already sends action_id, pre-resolution path unchanged) |

## Repos affected

| Repo | Changes |
|------|---------|
| `adoptai-workflows` | New signal handler, detection logic, callback activity |
| `adoptwebui` | New callback endpoint, signal dispatch function |
| ProjectA3 | Return structured error when credentials missing |
| `tabby` | None (API already supports everything needed) |

## Rollout

1. Ship Option A (done) — works now, covers the common case
2. Build Option C incrementally:
   - Phase 1: Add `tabby_resolution_signal` to workflow + callback endpoint to API
   - Phase 2: Add detection in ProjectA3 + callback activity
   - Phase 3: Wire up HITL card flow through the signal path
   - Phase 4: Remove Option A pre-resolution (or keep as fast-path optimization)

Option A and C can coexist — A handles the pre-resolved case (session already HEALTHY), C handles the cold-start case. Eventually A can be removed or kept as an optimization (skip the round-trip when tokens are cached).
