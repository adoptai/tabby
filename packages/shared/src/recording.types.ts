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
  timestamp: string;
}

/** A main-frame URL transition observed during the recording. */
export interface RecordedUrlEvent {
  from_url: string;
  to_url: string;
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

/** The bundle drained on "Finish & export" and pulled by NoUI. */
export interface RecordingBundle {
  session_id: string;
  recording_mode: RecordingMode;
  started_at: string;
  stopped_at: string;
  har: RecordingHar;
  click_events: RecordedInteractionEvent[];
  url_events: RecordedUrlEvent[];
}
