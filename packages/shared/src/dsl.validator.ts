import { DslStep, DslActionType, HumanInputType, FailureHandler } from './dsl.types';
import { LoginConfig, KeepaliveConfig, ExportPolicy, NotificationConfig } from './config.types';

// ============================================================
// DSL Validation (per spec sections 10.2, 10.3)
// ============================================================

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

const VALID_ACTIONS: DslActionType[] = [
  'goto', 'fill', 'type', 'click', 'select',
  'wait_for', 'wait_for_url', 'frame', 'main_frame',
  'popup', 'keyboard', 'evaluate', 'sleep', 'screenshot', 'reload',
  'request_human_input',
];

const VALID_INPUT_TYPES: HumanInputType[] = [
  'otp', 'email', 'password', 'captcha', 'verification_code', 'url', 'confirm',
];

function validateStep(step: DslStep, index: number, prefix: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const path = `${prefix}[${index}]`;

  if (!step.action || !VALID_ACTIONS.includes(step.action)) {
    errors.push({ path: `${path}.action`, message: `Invalid action: ${step.action}. Must be one of: ${VALID_ACTIONS.join(', ')}` });
    return errors;
  }

  if (step.timeout_ms !== undefined && (typeof step.timeout_ms !== 'number' || step.timeout_ms <= 0)) {
    errors.push({ path: `${path}.timeout_ms`, message: 'timeout_ms must be a positive number' });
  }

  if (step.retry_count !== undefined && (typeof step.retry_count !== 'number' || step.retry_count < 0)) {
    errors.push({ path: `${path}.retry_count`, message: 'retry_count must be a non-negative number' });
  }

  if (step.retry_backoff !== undefined && !['fixed', 'exponential'].includes(step.retry_backoff)) {
    errors.push({ path: `${path}.retry_backoff`, message: 'retry_backoff must be "fixed" or "exponential"' });
  }

  if (step.retry_delay_ms !== undefined && (typeof step.retry_delay_ms !== 'number' || step.retry_delay_ms <= 0)) {
    errors.push({ path: `${path}.retry_delay_ms`, message: 'retry_delay_ms must be a positive number' });
  }

  if (step.retry_max_delay_ms !== undefined && (typeof step.retry_max_delay_ms !== 'number' || step.retry_max_delay_ms <= 0)) {
    errors.push({ path: `${path}.retry_max_delay_ms`, message: 'retry_max_delay_ms must be a positive number' });
  }

  // Validate on_failure if present
  if (step.on_failure) {
    const FAILURE_ALLOWED_ACTIONS: DslActionType[] = ['wait_for', 'wait_for_url', 'click', 'fill', 'goto'];
    if (!FAILURE_ALLOWED_ACTIONS.includes(step.action)) {
      errors.push({ path: `${path}.on_failure`, message: `on_failure is only valid on ${FAILURE_ALLOWED_ACTIONS.join(', ')} steps` });
    }
    const fa = step.on_failure as FailureHandler;
    if (!['request_help', 'skip', 'abort'].includes(fa.action)) {
      errors.push({ path: `${path}.on_failure.action`, message: 'on_failure.action must be "request_help", "skip", or "abort"' });
    }
    if (fa.action === 'request_help') {
      if (!fa.message || typeof fa.message !== 'string') {
        errors.push({ path: `${path}.on_failure.message`, message: 'on_failure.message is required for request_help' });
      }
    }
  }

  switch (step.action) {
    case 'goto':
      if (!step.url || typeof step.url !== 'string') {
        errors.push({ path: `${path}.url`, message: 'goto requires a url string' });
      }
      break;

    case 'fill':
    case 'type':
      if (!step.selector || typeof step.selector !== 'string') {
        errors.push({ path: `${path}.selector`, message: `${step.action} requires a selector string` });
      }
      if (step.value === undefined || typeof step.value !== 'string') {
        errors.push({ path: `${path}.value`, message: `${step.action} requires a value string` });
      }
      break;

    case 'click':
      if (!step.selector || typeof step.selector !== 'string') {
        errors.push({ path: `${path}.selector`, message: 'click requires a selector string' });
      }
      break;

    case 'select':
      if (!step.selector || typeof step.selector !== 'string') {
        errors.push({ path: `${path}.selector`, message: 'select requires a selector string' });
      }
      if (step.value === undefined || typeof step.value !== 'string') {
        errors.push({ path: `${path}.value`, message: 'select requires a value string' });
      }
      break;

    case 'wait_for':
      if (!step.selector || typeof step.selector !== 'string') {
        errors.push({ path: `${path}.selector`, message: 'wait_for requires a selector string' });
      }
      break;

    case 'wait_for_url':
      if (!step.pattern || typeof step.pattern !== 'string') {
        errors.push({ path: `${path}.pattern`, message: 'wait_for_url requires a pattern string' });
      }
      break;

    case 'frame':
      if (!step.selector || typeof step.selector !== 'string') {
        errors.push({ path: `${path}.selector`, message: 'frame requires a selector string' });
      }
      break;

    case 'main_frame':
      // No params needed
      break;

    case 'popup':
      // Only optional timeout_ms
      break;

    case 'keyboard':
      if (!step.key || typeof step.key !== 'string') {
        errors.push({ path: `${path}.key`, message: 'keyboard requires a key string' });
      }
      break;

    case 'evaluate':
      if (!step.expression || typeof step.expression !== 'string') {
        errors.push({ path: `${path}.expression`, message: 'evaluate requires an expression string' });
      }
      break;

    case 'sleep':
      if (step.ms === undefined || typeof step.ms !== 'number' || step.ms <= 0) {
        errors.push({ path: `${path}.ms`, message: 'sleep requires a positive ms number' });
      }
      break;

    case 'screenshot':
    case 'reload':
      // No params needed
      break;

    case 'request_human_input': {
      const inputType = (step as any).input_type;
      if (!inputType || !VALID_INPUT_TYPES.includes(inputType)) {
        errors.push({ path: `${path}.input_type`, message: `request_human_input requires input_type (one of: ${VALID_INPUT_TYPES.join(', ')})` });
      }
      if (!(step as any).label || typeof (step as any).label !== 'string') {
        errors.push({ path: `${path}.label`, message: 'request_human_input requires a label string' });
      }
      if (inputType && !['url', 'confirm'].includes(inputType)) {
        if (!(step as any).field_selector || typeof (step as any).field_selector !== 'string') {
          errors.push({ path: `${path}.field_selector`, message: `field_selector is required when input_type is "${inputType}"` });
        }
      }
      break;
    }
  }

  return errors;
}

export function validateLoginConfig(config: LoginConfig): ValidationResult {
  const errors: ValidationError[] = [];

  if (!config.login_url || typeof config.login_url !== 'string') {
    errors.push({ path: 'login_url', message: 'login_url is required' });
  }

  if (!config.credential_ref || typeof config.credential_ref !== 'string') {
    errors.push({ path: 'credential_ref', message: 'credential_ref is required' });
  } else if (!config.credential_ref.startsWith('k8s:secret/') && !config.credential_ref.startsWith('manual:')) {
    errors.push({ path: 'credential_ref', message: 'credential_ref must start with k8s:secret/ or manual:' });
  }

  if (!config.steps || !Array.isArray(config.steps) || config.steps.length === 0) {
    errors.push({ path: 'steps', message: 'steps must be a non-empty array' });
  } else {
    // Must include at least one goto action (spec 10.2)
    const hasGoto = config.steps.some(s => s.action === 'goto');
    if (!hasGoto) {
      errors.push({ path: 'steps', message: 'steps must include at least one goto action' });
    }

    for (let i = 0; i < config.steps.length; i++) {
      errors.push(...validateStep(config.steps[i], i, 'steps'));
    }
  }

  if (config.otp_prompt) {
    if (config.otp_prompt.method !== 'chat') {
      errors.push({ path: 'otp_prompt.method', message: 'otp_prompt.method must be "chat"' });
    }
    if (!config.otp_prompt.field_selector || typeof config.otp_prompt.field_selector !== 'string') {
      errors.push({ path: 'otp_prompt.field_selector', message: 'otp_prompt.field_selector is required' });
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateKeepaliveConfig(config: KeepaliveConfig): ValidationResult {
  const errors: ValidationError[] = [];

  if (config.interval_seconds === undefined || config.interval_seconds < 60) {
    errors.push({ path: 'interval_seconds', message: 'interval_seconds must be >= 60' });
  }

  if (!config.actions || !Array.isArray(config.actions)) {
    errors.push({ path: 'actions', message: 'actions must be an array' });
  } else {
    for (let i = 0; i < config.actions.length; i++) {
      errors.push(...validateStep(config.actions[i], i, 'actions'));
    }
  }

  if (!config.health_checks || !Array.isArray(config.health_checks) || config.health_checks.length === 0) {
    errors.push({ path: 'health_checks', message: 'health_checks must be a non-empty array' });
  } else {
    for (let i = 0; i < config.health_checks.length; i++) {
      const check = config.health_checks[i];
      const path = `health_checks[${i}]`;

      if (!['url_check', 'dom_check', 'network_check'].includes(check.type)) {
        errors.push({ path: `${path}.type`, message: 'Invalid check type' });
        continue;
      }

      if (check.type === 'url_check' || check.type === 'network_check') {
        if (!check.url || typeof check.url !== 'string') {
          errors.push({ path: `${path}.url`, message: `${check.type} requires a url` });
        }
        if (check.expect_status === undefined || typeof check.expect_status !== 'number') {
          errors.push({ path: `${path}.expect_status`, message: `${check.type} requires expect_status` });
        }
      }

      if (check.type === 'dom_check') {
        if (!check.selector || typeof check.selector !== 'string') {
          errors.push({ path: `${path}.selector`, message: 'dom_check requires a selector' });
        }
      }
    }
  }

  if (config.policy && !['all', 'any', 'quorum'].includes(config.policy)) {
    errors.push({ path: 'policy', message: 'policy must be all, any, or quorum' });
  }

  if (config.policy === 'quorum' && (config.quorum_n === undefined || config.quorum_n < 1)) {
    errors.push({ path: 'quorum_n', message: 'quorum_n is required when policy is quorum' });
  }

  return { valid: errors.length === 0, errors };
}

// RFC 7230 token: header names are alphanumeric + !#$%&'*+-.^_`|~
const HTTP_HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

function validateHeaderAllowlist(
  path: string,
  allowlist: unknown,
  artifactTypes: string[],
  opts: { rejectCookie?: boolean } = {},
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!Array.isArray(allowlist)) {
    errors.push({ path, message: `${path} must be an array of header names` });
    return errors;
  }
  if (allowlist.length === 0) {
    errors.push({ path, message: `${path} must be a non-empty array if provided` });
    return errors;
  }
  if (!artifactTypes.includes('headers')) {
    errors.push({ path, message: `${path} requires 'headers' in artifact_types` });
  }
  for (let i = 0; i < allowlist.length; i++) {
    const entry = allowlist[i];
    const entryPath = `${path}[${i}]`;
    if (typeof entry !== 'string' || entry.length === 0) {
      errors.push({ path: entryPath, message: 'header name must be a non-empty string' });
      continue;
    }
    if (entry === '*') {
      errors.push({ path: entryPath, message: 'wildcard "*" is not permitted in header allowlist' });
      continue;
    }
    if (!HTTP_HEADER_NAME_RE.test(entry)) {
      errors.push({ path: entryPath, message: `"${entry}" is not a valid HTTP header name` });
      continue;
    }
    if (opts.rejectCookie && entry.toLowerCase() === 'cookie') {
      errors.push({
        path: entryPath,
        message: 'Cookie header is not permitted in request_header_allowlist — use artifact_types: ["cookies"] instead',
      });
    }
  }
  return errors;
}

export function validateExportPolicy(config: ExportPolicy): ValidationResult {
  const errors: ValidationError[] = [];
  const validArtifactTypes = ['cookies', 'headers', 'csrf_token', 'local_storage', 'session_storage'];

  const artifactTypes: string[] = Array.isArray(config.artifact_types) ? config.artifact_types : [];

  if (!config.artifact_types || !Array.isArray(config.artifact_types) || config.artifact_types.length === 0) {
    errors.push({ path: 'artifact_types', message: 'artifact_types must be a non-empty array' });
  } else {
    for (const at of config.artifact_types) {
      if (!validArtifactTypes.includes(at)) {
        errors.push({ path: 'artifact_types', message: `Invalid artifact type: ${at}` });
      }
    }
  }

  if (!config.encryption || config.encryption.algo !== 'AES-256-GCM') {
    errors.push({ path: 'encryption.algo', message: 'encryption.algo must be AES-256-GCM' });
  }

  if (config.ttl_seconds === undefined || config.ttl_seconds < 300) {
    errors.push({ path: 'ttl_seconds', message: 'ttl_seconds must be >= 300' });
  }

  if (config.header_allowlist !== undefined) {
    errors.push(...validateHeaderAllowlist('header_allowlist', config.header_allowlist, artifactTypes));
  }

  if (config.request_header_allowlist !== undefined) {
    errors.push(
      ...validateHeaderAllowlist('request_header_allowlist', config.request_header_allowlist, artifactTypes, {
        rejectCookie: true,
      }),
    );
  }

  return { valid: errors.length === 0, errors };
}

export function validateNotificationConfig(config: NotificationConfig): ValidationResult {
  const errors: ValidationError[] = [];
  const channelPattern = /^(slack|teams|agent):.+$/;

  if (config.channels && config.channels.length > 0) {
    for (let i = 0; i < config.channels.length; i++) {
      if (!channelPattern.test(config.channels[i])) {
        errors.push({ path: `channels[${i}]`, message: 'Channel must match format {provider}:{reference} where provider is slack, teams, or agent' });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateTargetUrls(urls: string[]): ValidationResult {
  const errors: ValidationError[] = [];

  if (!urls || !Array.isArray(urls) || urls.length === 0) {
    errors.push({ path: 'target_urls', message: 'target_urls must contain at least one URL' });
    return { valid: false, errors };
  }

  for (let i = 0; i < urls.length; i++) {
    try {
      const u = new URL(urls[i]);
      if (u.protocol !== 'https:') {
        errors.push({ path: `target_urls[${i}]`, message: 'target_urls must be HTTPS URLs' });
      }
    } catch {
      errors.push({ path: `target_urls[${i}]`, message: `Invalid URL: ${urls[i]}` });
    }
  }

  return { valid: errors.length === 0, errors };
}
