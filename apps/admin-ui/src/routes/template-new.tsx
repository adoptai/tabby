import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { templatesApi } from '@/api/templates';
import { DslStepBuilder } from '@/components/templates/dsl-step-builder';

const LABEL: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--muted-fg)',
  display: 'block',
  marginBottom: 5,
};

const INPUT: React.CSSProperties = {
  width: '100%',
  height: 36,
  padding: '0 11px',
  borderRadius: 8,
  border: '1px solid var(--border-2)',
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
};

const TEXTAREA: React.CSSProperties = {
  width: '100%',
  minHeight: 80,
  padding: '8px 11px',
  borderRadius: 8,
  border: '1px solid var(--border-2)',
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
  resize: 'vertical',
};

const TEXTAREA_MONO: React.CSSProperties = {
  ...TEXTAREA,
  fontFamily: 'ui-monospace, Menlo, monospace',
};

const REQUIRED_MARK = <span style={{ color: 'var(--error)' }}> *</span>;
const HELPER: React.CSSProperties = { fontSize: 11, color: 'var(--muted-fg)', marginTop: 4 };
const ERR: React.CSSProperties = { fontSize: 11, color: 'var(--error)', marginTop: 4 };

const DEFAULT_KEEPALIVE_CONFIG = JSON.stringify({ health_checks: [] }, null, 2);
const DEFAULT_EXPORT_POLICY = JSON.stringify({ artifact_types: ['cookies'] }, null, 2);

function tryParseJson(raw: string): unknown {
  if (!raw.trim()) return null;
  try { return JSON.parse(raw); } catch { return undefined; }
}

export function TemplateNewPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [name, setName] = useState('');
  const [profileNamePattern, setProfileNamePattern] = useState('');
  const [credentialRefDefault, setCredentialRefDefault] = useState('');
  const [idleShutdownSeconds, setIdleShutdownSeconds] = useState('');
  const [executeEnabled, setExecuteEnabled] = useState(false);
  const [tenantId, setTenantId] = useState('');
  const [extraEgressRaw, setExtraEgressRaw] = useState('');
  const [loginConfigSteps, setLoginConfigSteps] = useState<unknown[]>([]);
  const [loginConfigExtra] = useState<Record<string, unknown>>({});
  const [keepaliveConfigRaw, setKeepaliveConfigRaw] = useState(DEFAULT_KEEPALIVE_CONFIG);
  const [exportPolicyRaw, setExportPolicyRaw] = useState(DEFAULT_EXPORT_POLICY);
  const [browserPolicyRaw, setBrowserPolicyRaw] = useState('');
  const [notificationConfigRaw, setNotificationConfigRaw] = useState('');
  const [showBrowserPolicy, setShowBrowserPolicy] = useState(false);
  const [showNotificationConfig, setShowNotificationConfig] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const createMutation = useMutation({
    mutationFn: templatesApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['templates'] });
      navigate('/templates');
    },
  });

  function validate(): boolean {
    const next: Record<string, string> = {};

    if (!name.trim()) next.name = 'Name is required.';
    if (!profileNamePattern.trim()) next.profile_name_pattern = 'Profile name pattern is required.';

    if (idleShutdownSeconds !== '') {
      const n = Number(idleShutdownSeconds);
      if (isNaN(n) || n < 60) next.idle_shutdown_seconds = 'Must be a number ≥ 60.';
    }

    const requiredJsonFields: [string, string][] = [
      ['keepalive_config', keepaliveConfigRaw],
      ['export_policy', exportPolicyRaw],
    ];
    for (const [key, raw] of requiredJsonFields) {
      if (!raw.trim()) {
        next[key] = 'This field is required.';
      } else if (tryParseJson(raw) === undefined) {
        next[key] = 'Invalid JSON.';
      }
    }

    const optionalJsonFields: [string, string][] = [
      ['browser_policy', browserPolicyRaw],
      ['notification_config', notificationConfigRaw],
    ];
    for (const [key, raw] of optionalJsonFields) {
      if (raw.trim() && tryParseJson(raw) === undefined) next[key] = 'Invalid JSON.';
    }

    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;

    const extraEgress = extraEgressRaw.split('\n').map((s) => s.trim()).filter(Boolean);

    createMutation.mutate({
      name: name.trim(),
      profile_name_pattern: profileNamePattern.trim(),
      credential_ref_default: credentialRefDefault.trim() || null,
      idle_shutdown_seconds: idleShutdownSeconds !== '' ? Number(idleShutdownSeconds) : null,
      execute_enabled: executeEnabled,
      ...(tenantId.trim() ? { tenant_id: tenantId.trim() } : {}),
      ...(extraEgress.length > 0 ? { extra_egress_allowlist: extraEgress } : {}),
      login_config: { ...loginConfigExtra, steps: loginConfigSteps },
      keepalive_config: tryParseJson(keepaliveConfigRaw) ?? { health_checks: [] },
      export_policy: tryParseJson(exportPolicyRaw) ?? { artifact_types: ['cookies'] },
      ...(browserPolicyRaw.trim() ? { browser_policy: tryParseJson(browserPolicyRaw) } : {}),
      ...(notificationConfigRaw.trim() ? { notification_config: tryParseJson(notificationConfigRaw) } : {}),
    });
  }

  return (
    <div style={{ maxWidth: 600 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <Link to="/templates" style={{ fontSize: 12.5, color: 'var(--muted-fg)', textDecoration: 'none' }}>
          Templates
        </Link>
        <span style={{ color: 'var(--faint-fg)', fontSize: 12.5 }}>/</span>
        <span style={{ fontSize: 12.5, color: 'var(--fg)' }}>New</span>
      </div>

      <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', margin: '0 0 24px', color: 'var(--fg)' }}>
        New Template
      </h1>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* Name */}
        <div>
          <label style={LABEL}>Name{REQUIRED_MARK}</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-template"
            style={INPUT}
          />
          {errors.name && <p style={ERR}>{errors.name}</p>}
        </div>

        {/* Profile Name Pattern */}
        <div>
          <label style={LABEL}>Profile Name Pattern{REQUIRED_MARK}</label>
          <input
            value={profileNamePattern}
            onChange={(e) => setProfileNamePattern(e.target.value)}
            placeholder="my-app-*"
            style={{ ...INPUT, fontFamily: 'ui-monospace, Menlo, monospace' }}
          />
          <p style={HELPER}>Pattern matched against profile names when resolving templates.</p>
          {errors.profile_name_pattern && <p style={ERR}>{errors.profile_name_pattern}</p>}
        </div>

        {/* Login Config */}
        <div>
          <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-fg)', marginBottom: 5 }}>
            Login Config <span style={{ color: 'var(--error)' }}>*</span>
          </div>
          <DslStepBuilder
            value={loginConfigSteps}
            onChange={setLoginConfigSteps}
          />
        </div>

        {/* Keepalive Config */}
        <div>
          <label style={LABEL}>Keepalive Config{REQUIRED_MARK}</label>
          <textarea
            value={keepaliveConfigRaw}
            onChange={(e) => setKeepaliveConfigRaw(e.target.value)}
            rows={5}
            style={TEXTAREA_MONO}
          />
          {errors.keepalive_config && <p style={ERR}>{errors.keepalive_config}</p>}
        </div>

        {/* Export Policy */}
        <div>
          <label style={LABEL}>Export Policy{REQUIRED_MARK}</label>
          <textarea
            value={exportPolicyRaw}
            onChange={(e) => setExportPolicyRaw(e.target.value)}
            rows={4}
            style={TEXTAREA_MONO}
          />
          {errors.export_policy && <p style={ERR}>{errors.export_policy}</p>}
        </div>

        {/* Credential Ref Default */}
        <div>
          <label style={LABEL}>Credential Ref Default</label>
          <input
            value={credentialRefDefault}
            onChange={(e) => setCredentialRefDefault(e.target.value)}
            placeholder="k8s:secret/my-secret"
            style={{ ...INPUT, fontFamily: 'ui-monospace, Menlo, monospace' }}
          />
        </div>

        {/* Idle Shutdown Seconds */}
        <div>
          <label style={LABEL}>Idle Shutdown Seconds</label>
          <input
            type="number"
            min={60}
            step={1}
            value={idleShutdownSeconds}
            onChange={(e) => setIdleShutdownSeconds(e.target.value)}
            placeholder="3600"
            style={{ ...INPUT, width: 120 }}
          />
          <p style={HELPER}>Minimum 60. Leave blank to disable idle shutdown.</p>
          {errors.idle_shutdown_seconds && <p style={ERR}>{errors.idle_shutdown_seconds}</p>}
        </div>

        {/* Execute Enabled */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            id="execute_enabled"
            type="checkbox"
            checked={executeEnabled}
            onChange={(e) => setExecuteEnabled(e.target.checked)}
            style={{ width: 16, height: 16, accentColor: 'var(--primary)', cursor: 'pointer' }}
          />
          <label htmlFor="execute_enabled" style={{ fontSize: 13, color: 'var(--fg)', cursor: 'pointer' }}>
            Execute enabled
          </label>
        </div>

        {/* Extra Egress Allowlist */}
        <div>
          <label style={LABEL}>Extra Egress Allowlist</label>
          <textarea
            value={extraEgressRaw}
            onChange={(e) => setExtraEgressRaw(e.target.value)}
            placeholder={'api.example.com\ncdn.example.com'}
            style={{ ...TEXTAREA_MONO, minHeight: 60 }}
          />
          <p style={HELPER}>One hostname per line.</p>
        </div>

        {/* Tenant ID */}
        <div>
          <label style={LABEL}>Tenant ID</label>
          <input
            value={tenantId}
            onChange={(e) => setTenantId(e.target.value)}
            placeholder="optional"
            style={INPUT}
          />
        </div>

        {/* Browser Policy (collapsible) */}
        <div>
          <button
            type="button"
            onClick={() => setShowBrowserPolicy((v) => !v)}
            style={{
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              fontSize: 12, fontWeight: 500, color: 'var(--muted-fg)',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <span style={{ fontSize: 10 }}>{showBrowserPolicy ? '▾' : '▸'}</span>
            Browser Policy
          </button>
          {showBrowserPolicy && (
            <div style={{ marginTop: 8 }}>
              <textarea
                value={browserPolicyRaw}
                onChange={(e) => setBrowserPolicyRaw(e.target.value)}
                rows={5}
                placeholder='{"streaming_mode": "vnc"}'
                style={TEXTAREA_MONO}
              />
              {errors.browser_policy && <p style={ERR}>{errors.browser_policy}</p>}
            </div>
          )}
        </div>

        {/* Notification Config (collapsible) */}
        <div>
          <button
            type="button"
            onClick={() => setShowNotificationConfig((v) => !v)}
            style={{
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              fontSize: 12, fontWeight: 500, color: 'var(--muted-fg)',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <span style={{ fontSize: 10 }}>{showNotificationConfig ? '▾' : '▸'}</span>
            Notification Config
          </button>
          {showNotificationConfig && (
            <div style={{ marginTop: 8 }}>
              <textarea
                value={notificationConfigRaw}
                onChange={(e) => setNotificationConfigRaw(e.target.value)}
                rows={5}
                placeholder="{}"
                style={TEXTAREA_MONO}
              />
              {errors.notification_config && <p style={ERR}>{errors.notification_config}</p>}
            </div>
          )}
        </div>

        {createMutation.isError && (
          <p style={{ fontSize: 12, color: 'var(--error)' }}>
            Failed to create template. Check your inputs and try again.
          </p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 8 }}>
          <Link
            to="/templates"
            style={{
              display: 'inline-flex', alignItems: 'center',
              height: 34, padding: '0 14px', borderRadius: 8,
              border: '1px solid var(--border-2)', background: 'var(--card)',
              color: 'var(--fg)', fontSize: 12.5, textDecoration: 'none',
            }}
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={createMutation.isPending}
            style={{
              height: 34, padding: '0 14px', borderRadius: 8,
              background: 'var(--primary)', color: 'var(--primary-fg)',
              fontWeight: 600, fontSize: 12.5, border: 'none',
              cursor: createMutation.isPending ? 'default' : 'pointer',
              opacity: createMutation.isPending ? 0.6 : 1,
            }}
          >
            {createMutation.isPending ? 'Creating…' : 'Create Template'}
          </button>
        </div>
      </form>
    </div>
  );
}
