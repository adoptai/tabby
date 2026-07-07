import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { appsApi } from '@/api/apps';
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

export function AppNewPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [name, setName] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [targetUrlsRaw, setTargetUrlsRaw] = useState('');
  const [desiredCount, setDesiredCount] = useState('');
  const [executeEnabled, setExecuteEnabled] = useState(false);
  const [loginConfigSteps, setLoginConfigSteps] = useState<unknown[]>([]);
  const [loginConfigExtra] = useState<Record<string, unknown>>({});
  const [keepaliveConfigRaw, setKeepaliveConfigRaw] = useState(DEFAULT_KEEPALIVE_CONFIG);
  const [exportPolicyRaw, setExportPolicyRaw] = useState(DEFAULT_EXPORT_POLICY);
  const [browserPolicyRaw, setBrowserPolicyRaw] = useState('');
  const [notificationConfigRaw, setNotificationConfigRaw] = useState('');
  const [extraEgressRaw, setExtraEgressRaw] = useState('');
  const [showBrowserPolicy, setShowBrowserPolicy] = useState(false);
  const [showNotificationConfig, setShowNotificationConfig] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const createMutation = useMutation({
    mutationFn: appsApi.create,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apps'] });
      navigate('/apps');
    },
  });

  function validate(): boolean {
    const next: Record<string, string> = {};

    if (!name.trim()) next.name = 'Name is required.';

    const targetUrls = targetUrlsRaw.split('\n').map((u) => u.trim()).filter(Boolean);
    if (targetUrls.length === 0) next.target_urls = 'At least one URL is required.';

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

    const targetUrls = targetUrlsRaw.split('\n').map((u) => u.trim()).filter(Boolean);
    const extraEgress = extraEgressRaw.split('\n').map((s) => s.trim()).filter(Boolean);

    createMutation.mutate({
      name: name.trim(),
      ...(tenantId.trim() ? { tenant_id: tenantId.trim() } : {}),
      target_urls: targetUrls,
      desired_session_count: desiredCount !== '' ? Number(desiredCount) : undefined,
      execute_enabled: executeEnabled,
      login_config: { ...loginConfigExtra, steps: loginConfigSteps },
      keepalive_config: tryParseJson(keepaliveConfigRaw) ?? { health_checks: [] },
      export_policy: tryParseJson(exportPolicyRaw) ?? { artifact_types: ['cookies'] },
      ...(browserPolicyRaw.trim() ? { browser_policy: tryParseJson(browserPolicyRaw) } : {}),
      ...(notificationConfigRaw.trim() ? { notification_config: tryParseJson(notificationConfigRaw) } : {}),
      ...(extraEgress.length > 0 ? { extra_egress_allowlist: extraEgress } : {}),
    });
  }

  const sectionGap = 20;

  return (
    <div style={{ maxWidth: 600 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <Link to="/apps" style={{ fontSize: 12.5, color: 'var(--muted-fg)', textDecoration: 'none' }}>
          Applications
        </Link>
        <span style={{ color: 'var(--faint-fg)', fontSize: 12.5 }}>/</span>
        <span style={{ fontSize: 12.5, color: 'var(--fg)' }}>New</span>
      </div>

      <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', margin: '0 0 24px', color: 'var(--fg)' }}>
        New Application
      </h1>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: sectionGap }}>

        {/* Name */}
        <div>
          <label style={LABEL}>Name{REQUIRED_MARK}</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-app"
            style={INPUT}
          />
          {errors.name && <p style={ERR}>{errors.name}</p>}
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

        {/* Target URLs */}
        <div>
          <label style={LABEL}>Target URLs{REQUIRED_MARK}</label>
          <textarea
            value={targetUrlsRaw}
            onChange={(e) => setTargetUrlsRaw(e.target.value)}
            placeholder={'https://example.com\nhttps://example.com/app'}
            style={{ ...TEXTAREA_MONO, minHeight: 72 }}
          />
          <p style={HELPER}>One URL per line, minimum 1.</p>
          {errors.target_urls && <p style={ERR}>{errors.target_urls}</p>}
        </div>

        {/* Desired Session Count */}
        <div>
          <label style={LABEL}>Desired Session Count</label>
          <input
            type="number"
            min={0}
            step={1}
            value={desiredCount}
            onChange={(e) => setDesiredCount(e.target.value)}
            placeholder="0"
            style={{ ...INPUT, width: 120 }}
          />
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
            Failed to create application. Check your inputs and try again.
          </p>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, paddingTop: 8 }}>
          <Link
            to="/apps"
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
            {createMutation.isPending ? 'Creating…' : 'Create Application'}
          </button>
        </div>
      </form>
    </div>
  );
}
