/**
 * VNC Recording contract types.
 *
 * A human drives a Tabby VNC session while the worker captures HAR network
 * traffic + DOM interaction events server-side. On an explicit "Finish &
 * export" the worker drains a RecordingBundle, which NoUI replays into its
 * existing capture-session ingestion + compiler.
 *
 * The event shape mirrors NoUI's ClickEvent model so the existing login and
 * workflow compilers consume it unchanged (frozen contract — see
 * plans/noui/noui-vnc-recording-plan.md, Phase 0).
 */

export type RecordingMode = 'login' | 'workflow';

/**
 * One way of addressing the element that was interacted with, and how many
 * nodes it actually matched at that instant.
 *
 * The recorder used to emit a single `selector` chosen in-page by a fixed
 * priority ladder, with no idea whether it matched one node or forty. That
 * verdict was final — the page is gone once the recording ends, so no later
 * compiler improvement could revisit it, and ambiguity only surfaced in
 * production. (`a.mb-0` on ICICI's dashboard is the canonical example.)
 *
 * Emitting candidates plus `match_count` moves the choice into the compiler,
 * where it is revisable, and makes ambiguity detectable at compile time: a
 * candidate with `match_count > 1` cannot be trusted to identify this element,
 * and one with `match_count === 0` did not even find it.
 *
 * `match_count` is -1 when counting failed (an engine that could not evaluate
 * the selector) — distinct from 0, which is a real "matched nothing".
 */
export interface RecordedLocatorCandidate {
  /** How this candidate addresses the element; also its durability ranking. */
  kind:
    | 'testid'
    | 'id'
    | 'name'
    | 'aria_label'
    | 'role_name'
    | 'label'
    | 'text'
    | 'css_path';
  /**
   * The addressing value. A CSS selector for css-expressible kinds; for
   * `role_name` / `text` / `label` it is the accessible name or text to match,
   * which the runtime resolves semantically (getByRole / getByText / getByLabel)
   * rather than as CSS.
   */
  value: string;
  /** Nodes this matched when it was recorded. 1 is the only trustworthy count. */
  match_count: number;
}

/**
 * What was true about the element at the moment it was interacted with.
 *
 * All of this is free to capture at record time and impossible to recover
 * afterwards. `occluded` in particular is the overlay-intercepted-click problem
 * answered at the only moment it is knowable — the runtime otherwise has to
 * discover it by having a click fail.
 */
export interface RecordedElementEvidence {
  tag: string;
  /** Explicit `role` attribute, else the implicit role for the tag. */
  role: string | null;
  accessible_name: string | null;
  /** CSS-visible: not display:none / visibility:hidden / opacity:0 / aria-hidden. */
  visible: boolean;
  /** Something else was painted over its centre point. */
  occluded: boolean;
  rect: { x: number; y: number; w: number; h: number } | null;
  /**
   * The element lives inside a shadow root, so a document-level listener sees
   * the shadow HOST rather than this element — which is why the legacy
   * `selector` field describes the wrong node for these.
   */
  in_shadow_dom: boolean;
  /** The interaction happened inside an iframe; `url` on the event is that frame's. */
  in_iframe: boolean;
}

/**
 * What happened in the moments after an interaction.
 *
 * The compiler otherwise has to INFER causality — which click caused which
 * navigation — from bare timestamps. It is also precisely what a compiled step
 * needs as its POSTCONDITION: "after this click the URL becomes X, and traffic
 * settles in ~400ms" is what lets a runtime agent know within one step that it
 * is off-route, rather than discovering it five clicks later on the wrong page,
 * and what lets it wait on a real condition instead of a guessed sleep.
 *
 * Absent when the interaction's time could not be parsed — "not known", which is
 * honest, rather than a zeroed outcome that would read as "nothing happened".
 */
export interface RecordedInteractionOutcome {
  /** The page navigated (or client-side routed) within the window. */
  navigated: boolean;
  to_url: string | null;
  /** Requests that STARTED in the window. 0 means the click did nothing. */
  request_count: number;
  /** ms from the interaction until the last of those requests finished. */
  settled_ms: number | null;
  /** A file download began — for most browser skills, the success condition. */
  download: boolean;
}

/** A single captured DOM interaction. Field names mirror NoUI's ClickEvent. */
export interface RecordedInteractionEvent {
  event_type: 'click' | 'input' | 'change' | 'submit';
  tag_name: string;
  element_id: string | null;
  class_name: string | null;
  text_content?: string | null;
  href?: string | null;
  selector: string;
  url: string;
  x?: number;
  y?: number;
  input_type?: string | null;
  /** Redacted to "[REDACTED]" in-pod when field_role is password/otp. */
  value?: string | null;
  field_name?: string | null;
  field_role?: 'username' | 'password' | 'otp' | null;
  is_redacted?: boolean;
  autocomplete?: string | null;
  placeholder?: string | null;
  aria_label?: string | null;
  role_attr?: string | null;
  data_attrs_json?: string | null;
  /**
   * Ranked ways to address the element, with match counts. `workflow`
   * recordings only — see RecordedLocatorCandidate for why this exists.
   *
   * These describe the ACTIONABLE element (the `a`/`button`/input the human
   * meant), which is frequently not the node `selector` describes: the legacy
   * resolution walks up to the nearest ancestor with an id *or any class*, and
   * on a modern page that is usually the innermost wrapper — a `span` inside the
   * button. `selector` is left exactly as it was so the login compiler is
   * unaffected; new consumers should prefer `candidates`.
   */
  candidates?: RecordedLocatorCandidate[];
  /** State of the actionable element at interaction time. `workflow` only. */
  element?: RecordedElementEvidence;
  /**
   * What happened next. `workflow` only, derived at drain — see
   * RecordedInteractionOutcome.
   */
  outcome?: RecordedInteractionOutcome;
  /**
   * Total-order key across ALL events in the bundle (interactions and URL
   * transitions share one counter). Strictly increasing in interaction order;
   * gaps are normal and carry no meaning.
   *
   * Order by this, not by `timestamp`. The injected recorder debounces `input`
   * by 500ms, so a field filled and submitted inside that window flushes its
   * input event AFTER the click — and `timestamp` records that flush (see
   * below), which puts the click first. `seq` is assigned at interaction time
   * and is also immune to the beacon channel's delivery order and to clock
   * granularity.
   *
   * OPTIONAL because it was added additively: this interface also describes
   * bundles read back from storage (RecordingStore.retrieve), and anything
   * persisted before schema_version 2 has no `seq`. It can also be lost in
   * transit — NoUI's `/clicks` ingestion projects events onto a fixed column
   * list. Detect it; never assume it. RecordingRunner does guarantee it on every
   * bundle IT drains, but that is a producer guarantee, not a wire one.
   */
  seq?: number;
  /**
   * Wall clock of the interaction itself. For `input` this is the first
   * keystroke of the debounce burst; for every other event type it is the same
   * clock read as `timestamp` to within a statement. Read this when you need the
   * time an interaction happened, and `seq` when you need order.
   *
   * Optional for the same reason as `seq` — see there. Unlike `seq` it is never
   * reconstructed server-side: it comes from the page, so a bundle drained by a
   * worker older than schema_version 2 has none.
   */
  event_time?: string;
  /**
   * Wall clock at which the event payload was BUILT — for the debounced `input`
   * handler that is the flush, up to 500ms after the keystroke; for every other
   * event type it is the interaction itself.
   *
   * Semantics AND value are frozen: this field predates `seq`/`event_time` and
   * existing consumers (notably the NoUI login compiler) read it, so each handler
   * keeps its own original clock read in its original position rather than
   * copying `event_time`. Never assume `event_time === timestamp`; only
   * `event_time <= timestamp` holds. New code wanting interaction time should
   * read `event_time`, and wanting order, `seq`.
   */
  timestamp: string;
}

/** A main-frame URL transition observed during the recording. */
export interface RecordedUrlEvent {
  from_url: string;
  to_url: string;
  /**
   * Same counter as RecordedInteractionEvent.seq — clicks and navigations
   * interleave in one total order. Optional for the same reason: see there.
   */
  seq?: number;
  /** Emitted inline at navigation, so this is also the interaction time. */
  timestamp: string;
  /**
   * Which page the transition happened in: 0 is the page the human started on,
   * >0 are popups/new tabs opened during the session. Only emitted for
   * `workflow` recordings; absent on `login` bundles, which are single-page and
   * whose shape must not move.
   */
  page_id?: number;
}

/**
 * A file download started during the recording (`workflow` mode only).
 *
 * The terminal step of most browser skills is "a file arrived", and it is the
 * one event the rest of the capture cannot see: a `blob:` download never
 * touches the network so HAR misses it, and the click that triggered it looks
 * like any other click. Without this the compiler has no success condition to
 * compile.
 *
 * Metadata only, and captured without awaiting the transfer — the recorder must
 * never make the human wait.
 */
export interface RecordedDownloadEvent {
  url: string;
  suggested_filename: string;
  /** URL of the page the download was triggered from. */
  page_url: string;
  page_id: number;
  timestamp: string;
}

/** HAR 1.2 log (subset Tabby assembles). */
export interface RecordingHar {
  log: {
    version: string;
    creator: { name: string; version: string };
    entries: unknown[];
  };
}

/**
 * A browser cookie captured at drain time (Playwright Cookie shape) so an
 * authenticated session can be reused: a workflow recording provisioned
 * `--from` a login recording seeds these via context.addCookies(), starting the
 * human already signed in without storing username/password.
 */
export interface RecordedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/**
 * Bundle schema revision. Bumped only when the event contract changes.
 *   1 — implicit (absent). Events carry no `seq`/`event_time`.
 *   2 — every event carries `seq`; interaction events also carry `event_time`.
 *   3 — workflow recordings additionally capture downloads (`download_events`)
 *       and attach to popups/new tabs (`page_id` on url events).
 *   4 — workflow interactions additionally carry `candidates` (ranked locators
 *       with match counts) and `element` (state at interaction time).
 *   5 — workflow interactions additionally carry `outcome` (what happened
 *       next), and the workflow HAR is reduced to metadata: no bodies, no
 *       headers, no query strings. The HAR 1.2 shape is preserved.
 */
export const RECORDING_SCHEMA_VERSION = 5;

/** The bundle drained on "Finish & export" and pulled by NoUI. */
export interface RecordingBundle {
  /**
   * See RECORDING_SCHEMA_VERSION. Absent on bundles drained before it existed,
   * which is what "version 1" means.
   *
   * Informational: it describes what the WORKER produced. Consumers should still
   * detect `seq` per event rather than dispatch on this, because a bundle can
   * lose the field in transit — NoUI's `/clicks` ingestion projects events onto
   * a fixed column list, and anything not in it is dropped.
   */
  schema_version?: number;
  session_id: string;
  recording_mode: RecordingMode;
  started_at: string;
  stopped_at: string;
  har: RecordingHar;
  click_events: RecordedInteractionEvent[];
  url_events: RecordedUrlEvent[];
  /** Session cookies captured at drain (login recordings) for session reuse. */
  cookies?: RecordedCookie[];

  /**
   * Downloads observed during the recording. `workflow` mode only — a `login`
   * bundle never carries this key at all, so the login compiler sees no new
   * collection to reason about.
   */
  download_events?: RecordedDownloadEvent[];
}
