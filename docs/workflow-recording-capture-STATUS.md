# Workflow Recording Capture — Status & Gaps

**PR:** [adoptai/tabby#163](https://github.com/adoptai/tabby/pull/163) ·
**Branch:** `feat/workflow-recording-capture` · **Updated:** 2026-08-14

Companion feature in noui: [adoptai/noui#139](https://github.com/adoptai/noui/pull/139)
(compiles + replays what this branch captures). See that PR's
`docs/browser-skill-evidence-STATUS.md` for the compile/replay side.

This is a living reference: what the feature does, what we hardened, and the
gaps still worth fixing. Update it as gaps close.

---

## What this feature delivers

The worker records a human doing a workflow in a real browser session, in enough
detail that a compiler (noui) can turn the recording into a replayable skill and
prove it against a live app — instead of a skill author guessing selectors.

- **Locator candidates + `match_count`** — the recorder emits every way it could
  address a control (testid, id, name, aria-label, role+name, visible text,
  container-label, row-scoped, css-path) with how many nodes each matched, so the
  compiler chooses (and can revisit) rather than committing in-page to one
  selector that might match forty nodes.
- **Element evidence** — role, accessible name, visible/occluded, in-shadow-dom,
  in-iframe (`frame_url`/`frame_name`), captured at the only moment it is knowable.
- **Interaction outcomes** — `navigated`, `to_url`, `request_count`, `settled_ms`,
  `download` per interaction, so a goal ("a file arrived", "a form submitted") is
  derivable rather than inferred from step counts.
- **Hover/menu capture** — records the hover that reveals the control a click then
  lands on (ICICI's hover-nav), so replay opens the menu before clicking into it.
- **Dense event numbering (`seq`)** — a gap means an interaction was observed and
  deliberately not recorded; ordering survives the 500ms input debounce.
- **Browser control primitives** (`/execute/browser`) the compiled skill replays
  through, including iframe-scoped actions.
- **Pod runtime-error surfacing** — `getPodRuntime` → `session.last_runtime_error`
  (migration `034`), so an OOM-killed worker says why instead of "fetch failed".
- **PII masking** — PANs/account numbers redacted in the recorder and in
  `get_page_summary` before anything is persisted.

Schema is at **recording `schema_version: 5`**; pre-5 bundles must compile as
they did (the noui side honours this — see its doc).

---

## What we hardened (this review round → `5f64bba`)

| Ref | Area | Fix |
|----|------|-----|
| T2 | `dom-recorder.injected.ts` | `maskSensitive` separator class widened `[ .\-]` → `[\s.,_-]`; `\s` covers NBSP/thin-space, so a PAN grouped by any separator is masked before it reaches the aria-label / accessible_name / selector / data-attr paths (which mask raw, unlike `normText`). Tests per separator. |
| T4 | `packages/shared/recording.types.ts` | Added `container_label` + `row_scoped` to the `kind` union (the injected recorder is `any` and emits both; an exhaustive consumer would have dropped them). |
| T6 | `pod-manager.service.ts` | `getPodRuntime` decides on the worker container first; a noVNC sidecar crash while the worker is healthy no longer writes `novnc: …` into `last_runtime_error` (which resurfaced as the phantom cause of a later, unrelated failure). |
| T3 | `recording-outcomes.download.spec.ts` | Pinned the download tie-break's known limit with a test + rationale (see Known Limits). |

Earlier hardening already on the branch (highlights): masking account numbers out
of recordings (`af89f05`), row/container-label locators for div-nav portals
(`8a4cdd4`, `bb4f3dd`), hover-reveal capture (`da46317`, `56112dc`), `<select>`
handling (`5dc31a7`, `7023c12`), dense `seq` numbering (`3e50470`), worker
death-cause reporting (`695a259`, `9b03374`), idempotent migration 034 (`f638234`).

---

## Open gaps that need attention

| ID | Sev | Location | Issue | Recommended fix | Status |
|----|-----|----------|-------|-----------------|--------|
| **T1** | **High / security** | `auth/token-exchange.service.ts:274,286` | `agent_assertion` mints the **target user's role** (`targetUser.role`) from a **client-supplied `target_user_id` looked up by id alone, no tenant scope, no broker→user binding**. Because `role === 'Admin'` makes the controllers drop *both* filters (`sessions.controller.ts:62-63` → `tenantId = undefined`, no owner filter; `sessions.service.ts:171-172`), a minted Admin token reads/controls **every session in every tenant**. UUIDs aren't secret (they leak via `owner_user_id` in audit/API/logs). Net: a profile-confined **Agent** credential + any leaked Admin UUID → **deployment-wide** access. | **Cap the minted role** so `agent_assertion` never mints Admin (Operator/Editor still flow through, bounded to a member/tenant). Alternative: require `targetUser.tenant_id === agent_payload.tenant_id`, but that **breaks the test-enshrined cross-tenant vouching** (`token-exchange.service.spec.ts`) — a prior tenant-guard attempt was reverted for this reason. Decision owner: security. | **OPEN** (thread unresolved; user chose to defer the code change) |
| **T5** | Ops / capacity | `charts/browser-hitl/values.yaml:130` | Worker memory **limit** raised 1536Mi → 2560Mi (HAR-drain OOM fix). `requests.memory` unchanged at 1Gi, so scheduling density/steady-state is unaffected — only the per-pod **burst ceiling** rose. | Confirm node headroom for concurrent HAR-drain bursts against current staging/prod sizing. No code change; ops sign-off. | **OPEN** (thread left for ops) |

### T1 quick reference (the escalation ladder, by minted role)

| Minted role | tenant filter | owner filter | Blast radius |
|---|---|---|---|
| Operator / Viewer | agent's tenant | `owner_user_id = target` | one member's sessions — bounded |
| Editor | agent's tenant | none | whole tenant |
| **Admin** | **dropped (`undefined`)** | none | **whole deployment, all tenants** |

---

## Known limits (deliberate, not bugs)

- **Download attribution ambiguity (T3).** A labelled control >`LABEL_TIE_MS`
  (3s) before an unrelated newest click is credited to the newest click. This is
  the structural dual of the ICICI production case the recency rule was written
  for (`download previous statement` link then the real *unlabelled*
  `#DOWNLOAD_ESTATEMENT_PDF` button) — the two are **indistinguishable** from the
  only signals attribution has (timestamps + `text_content`). A label-preference
  "fix" reopens the production bug. **The real fix** is a per-click "this action
  started the download" signal the recorder doesn't yet emit — capturing that
  (e.g. binding Playwright's `download` event to the interaction that triggered
  it) would let attribution stop guessing. Pinned in
  `recording-outcomes.download.spec.ts`.

---

## Cross-repo dependency

Capture (this PR) → compile + replay (noui #139) → replay card
(design-system #17) → card wiring (adoptwebui #1631) → install gate
(adoptai-workflows #1552). A capture-schema change here ripples through the noui
compiler and the shared fingerprint vectors — keep `schema_version` bumps
deliberate.

---

## Verify

```bash
pnpm run build && pnpm run test           # full suite (pre-commit runs this)
npx jest apps/worker/src/dom-recorder.injected apps/worker/src/recording-outcomes.download
npx jest apps/controller/src/pod-manager.service
```
