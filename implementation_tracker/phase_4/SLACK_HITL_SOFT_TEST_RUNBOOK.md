# Slack HITL Soft Test Runbook

**Date:** 2026-02-19  
**Purpose:** Real-human end-to-end test using Slack direct OTP command path (no Slack App token required).

Canonical runbook: `RUNBOOK.md` (root). This file is the phase-4 snapshot.

Deterministic one-command prep path (recommended):

```bash
make local-fresh-e2e
```

## 1. What this validates

1. HITL request is posted in Slack when intervention starts.
2. Human provides OTP in Slack (`OTP <session_id> <code>`).
3. OTP is delivered to API and worker.
4. Session recovers to `HEALTHY`.
5. Slack posts completion message that automation resumed.

## 2. Prerequisites

1. Cluster running (`browser-hitl` namespace).
2. API deployed and reachable.
3. Test harness reachable in-cluster (`http://test-harness:8000`).
4. `.env.local` present (from `.env.example`) with Slack/API/NATS/admin values.

## 3. Fresh ngrok + API stream host (required before new session)

```bash
make local-ngrok-refresh-apply-stream-host
make local-ngrok-status
```

## 4. Terminal A: Port-forwards

```bash
kubectl -n browser-hitl port-forward svc/browser-hitl-nats 4222:4222
```

## 5. Terminal B: Start soft Slack bridge

```bash
make slack-soft-start
```

## 6. Terminal C: Start manual HITL scenario

```bash
set -a
source .env.local
set +a
python3 scripts/hitl_manual_slack_scenario.py
```

The script prints:
- `Session ID: <uuid>`
- instruction:
  - `OTP <session_id> 123456`

## 7. Human action in Slack

In `#tabby-experiments`, send exactly:

```text
OTP <session_id> 123456
```

## 8. Expected outcomes

1. Slack bridge posts:
   - `Action Required: Salesforce Authentication 🔒`
2. Session transitions to `HEALTHY`.
3. Slack bridge posts:
   - `Thanks. I received your code. Waiting for your Adopt agent to continue the task..`
   - `Thank You: Verification Complete ✅`
4. Scenario script exits success and writes evidence:
   - `implementation_tracker/phase_4/evidence/manual_slack_hitl_<timestamp>/summary.json`

## 9. Troubleshooting

1. No HITL message appears:
   - check worker scheduling first:
   - `kubectl -n browser-hitl get pods | rg worker-`
   - if `Pending` with `Insufficient cpu`, run:
   - `make hitl-scale-down-active`
   - `kubectl -n browser-hitl delete pod -l app=browser-worker --wait=false`
2. `Session not found` in Slack bridge:
   - verify scenario script is running and session id matches.
3. OTP delivery conflict:
   - resend once; stale OTP key may still be pending for up to 60s.
4. Viewer link stale/broken:
   - rerun `make local-ngrok-refresh-apply-stream-host`
5. Session never becomes `HEALTHY`:
   - inspect worker logs and `state_poll_*.json` in evidence directory.
