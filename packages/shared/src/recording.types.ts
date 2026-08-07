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
 */
export const RECORDING_SCHEMA_VERSION = 2;

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
}
