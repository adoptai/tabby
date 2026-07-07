import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { appsApi } from '@/api/apps';
import { sessionsApi } from '@/api/sessions';
import { StatusBadge } from '@/components/shared/status-badge';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useHasRole } from '@/hooks/use-role';
import { DslStepBuilder } from '@/components/templates/dsl-step-builder';

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  fontWeight: 500,
  color: 'var(--faint-fg)',
  marginBottom: 4,
};

const FIELD_MONO: React.CSSProperties = {
  fontFamily: 'ui-monospace, Menlo, monospace',
  fontSize: 12,
  color: 'var(--fg)',
  wordBreak: 'break-all',
};

const FIELD_TEXT: React.CSSProperties = { fontSize: 13, color: 'var(--fg)' };

const PRE_STYLE: React.CSSProperties = {
  fontFamily: 'ui-monospace, Menlo, monospace',
  fontSize: 12,
  overflowX: 'auto',
  background: 'var(--card-2)',
  padding: '12px 14px',
  borderRadius: 8,
  margin: 0,
  color: 'var(--fg)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
};

const FORM_LABEL: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--muted-fg)',
  display: 'block',
  marginBottom: 5,
};

const FORM_INPUT: React.CSSProperties = {
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

const FORM_TEXTAREA: React.CSSProperties = {
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

const CARD: React.CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: '20px 24px',
};

function tryParseJson(raw: string): unknown {
  if (!raw.trim()) return null;
  try { return JSON.parse(raw); } catch { return undefined; }
}

export function AppDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canWrite = useHasRole('Admin', 'Editor');

  const [scaleValue, setScaleValue] = useState('');
  const [showDeactivate, setShowDeactivate] = useState(false);
  const [showDestroy, setShowDestroy] = useState(false);
  const [showEdit, setShowEdit] = useState(false);

  // Edit dialog state
  const [editName, setEditName] = useState('');
  const [editTargetUrls, setEditTargetUrls] = useState('');
  const [editExecuteEnabled, setEditExecuteEnabled] = useState(false);
  const [editDesiredCount, setEditDesiredCount] = useState('');
  const [editLoginConfigSteps, setEditLoginConfigSteps] = useState<unknown[]>([]);
  const [editLoginConfigExtra, setEditLoginConfigExtra] = useState<Record<string, unknown>>({});
  const [editKeepaliveConfig, setEditKeepaliveConfig] = useState('');
  const [editExportPolicy, setEditExportPolicy] = useState('');
  const [editBrowserPolicy, setEditBrowserPolicy] = useState('');
  const [editNotificationConfig, setEditNotificationConfig] = useState('');
  const [editExtraEgress, setEditExtraEgress] = useState('');
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});

  const { data: app, isLoading } = useQuery({
    queryKey: ['app', id],
    queryFn: () => appsApi.get(id!),
    enabled: !!id,
  });

  const scaleMutation = useMutation({
    mutationFn: () => sessionsApi.scale(id!, Number(scaleValue)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app', id] });
      setScaleValue('');
    },
  });

  const deactivateMutation = useMutation({
    mutationFn: () => appsApi.deactivate(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apps'] });
      navigate('/apps');
    },
  });

  const destroyMutation = useMutation({
    mutationFn: () => appsApi.destroy(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apps'] });
      navigate('/apps');
    },
  });

  const updateMutation = useMutation({
    mutationFn: (payload: Parameters<typeof appsApi.update>[1]) => appsApi.update(id!, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['app', id] });
      qc.invalidateQueries({ queryKey: ['apps'] });
      setShowEdit(false);
    },
  });

  if (isLoading || !app) {
    return <p style={{ color: 'var(--muted-fg)', fontSize: 13 }}>Loading…</p>;
  }

  function openEdit() {
    setEditName(app!.name);
    setEditTargetUrls(app!.target_urls.join('\n'));
    setEditExecuteEnabled(app!.execute_enabled);
    setEditDesiredCount(String(app!.desired_session_count));
    if (app!.login_config && typeof app!.login_config === 'object') {
      const { steps, ...rest } = app!.login_config as Record<string, unknown>;
      setEditLoginConfigSteps(Array.isArray(steps) ? steps : []);
      setEditLoginConfigExtra(rest);
    } else {
      setEditLoginConfigSteps([]);
      setEditLoginConfigExtra({});
    }
    setEditKeepaliveConfig(app!.keepalive_config ? JSON.stringify(app!.keepalive_config, null, 2) : '');
    setEditExportPolicy(app!.export_policy ? JSON.stringify(app!.export_policy, null, 2) : '');
    setEditBrowserPolicy(app!.browser_policy ? JSON.stringify(app!.browser_policy, null, 2) : '');
    setEditNotificationConfig(app!.notification_config ? JSON.stringify(app!.notification_config, null, 2) : '');
    setEditExtraEgress(app!.extra_egress_allowlist?.join('\n') ?? '');
    setEditErrors({});
    setShowEdit(true);
  }

  function handleEditSubmit() {
    const errors: Record<string, string> = {};
    if (!editName.trim()) errors.name = 'Name is required.';

    const jsonChecks: [string, string][] = [
      ['keepalive_config', editKeepaliveConfig],
      ['export_policy', editExportPolicy],
      ['browser_policy', editBrowserPolicy],
      ['notification_config', editNotificationConfig],
    ];
    for (const [key, raw] of jsonChecks) {
      if (raw.trim() && tryParseJson(raw) === undefined) errors[key] = 'Invalid JSON.';
    }

    if (Object.keys(errors).length) {
      setEditErrors(errors);
      return;
    }

    updateMutation.mutate({
      name: editName.trim(),
      target_urls: editTargetUrls.split('\n').map((u) => u.trim()).filter(Boolean),
      execute_enabled: editExecuteEnabled,
      desired_session_count: editDesiredCount !== '' ? Number(editDesiredCount) : (app?.desired_session_count ?? 0),
      login_config: { ...editLoginConfigExtra, steps: editLoginConfigSteps },
      keepalive_config: tryParseJson(editKeepaliveConfig),
      export_policy: tryParseJson(editExportPolicy),
      browser_policy: tryParseJson(editBrowserPolicy),
      notification_config: tryParseJson(editNotificationConfig),
      extra_egress_allowlist: editExtraEgress.split('\n').map((s) => s.trim()).filter(Boolean),
    });
  }

  const configSections = [
    { label: 'Login Config', value: app.login_config },
    { label: 'Keepalive Config', value: app.keepalive_config },
    { label: 'Export Policy', value: app.export_policy },
    { label: 'Browser Policy', value: app.browser_policy },
  ];

  return (
    <div>
      {/* Confirm dialogs */}
      <ConfirmDialog
        open={showDeactivate}
        title="Deactivate Application"
        description="This will deactivate the application and stop new sessions from being created."
        confirmLabel="Deactivate"
        destructive
        onConfirm={async () => { await deactivateMutation.mutateAsync(); setShowDeactivate(false); }}
        onCancel={() => setShowDeactivate(false)}
      />
      <ConfirmDialog
        open={showDestroy}
        title="Destroy Application"
        description="This will permanently destroy the application and all associated sessions. This cannot be undone."
        confirmLabel="Destroy"
        destructive
        requireInput={app.name}
        onConfirm={async () => { await destroyMutation.mutateAsync(); setShowDestroy(false); }}
        onCancel={() => setShowDestroy(false)}
      />

      {/* Edit dialog */}
      {showEdit && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 50,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(0,0,0,0.5)',
          }}
          onClick={() => setShowEdit(false)}
        >
          <div
            style={{
              width: '100%', maxWidth: 900, maxHeight: '90vh', overflowY: 'auto',
              background: 'var(--card)', borderRadius: 12, padding: '24px',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--fg)', margin: '0 0 20px' }}>
              Edit Application
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label style={FORM_LABEL}>
                  Name <span style={{ color: 'var(--error)' }}>*</span>
                </label>
                <input value={editName} onChange={(e) => setEditName(e.target.value)} style={FORM_INPUT} />
                {editErrors.name && <p style={{ fontSize: 11, color: 'var(--error)', marginTop: 4 }}>{editErrors.name}</p>}
              </div>

              <div>
                <label style={FORM_LABEL}>Target URLs</label>
                <textarea
                  value={editTargetUrls}
                  onChange={(e) => setEditTargetUrls(e.target.value)}
                  placeholder="https://example.com&#10;https://example.com/app"
                  style={{ ...FORM_TEXTAREA, fontFamily: 'ui-monospace, Menlo, monospace', minHeight: 72 }}
                />
                <p style={{ fontSize: 11, color: 'var(--muted-fg)', marginTop: 3 }}>One URL per line.</p>
              </div>

              <div>
                <label style={FORM_LABEL}>Desired Session Count</label>
                <input
                  type="number" min={0} step={1}
                  value={editDesiredCount}
                  onChange={(e) => setEditDesiredCount(e.target.value)}
                  style={{ ...FORM_INPUT, width: 120 }}
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  id="edit_execute_enabled"
                  type="checkbox"
                  checked={editExecuteEnabled}
                  onChange={(e) => setEditExecuteEnabled(e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: 'var(--primary)', cursor: 'pointer' }}
                />
                <label htmlFor="edit_execute_enabled" style={{ fontSize: 13, color: 'var(--fg)', cursor: 'pointer' }}>
                  Execute enabled
                </label>
              </div>

              <div>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-fg)', marginBottom: 5 }}>
                  Login Config <span style={{ color: 'var(--error)' }}>*</span>
                </div>
                <DslStepBuilder
                  value={editLoginConfigSteps}
                  onChange={setEditLoginConfigSteps}
                />
              </div>

              {([
                ['keepalive_config', 'Keepalive Config', editKeepaliveConfig, setEditKeepaliveConfig],
                ['export_policy', 'Export Policy', editExportPolicy, setEditExportPolicy],
                ['browser_policy', 'Browser Policy', editBrowserPolicy, setEditBrowserPolicy],
                ['notification_config', 'Notification Config', editNotificationConfig, setEditNotificationConfig],
              ] as [string, string, string, React.Dispatch<React.SetStateAction<string>>][]).map(
                ([key, label, value, setter]) => (
                  <div key={key}>
                    <label style={FORM_LABEL}>{label}</label>
                    <textarea
                      value={value}
                      onChange={(e) => setter(e.target.value)}
                      rows={4}
                      style={{ ...FORM_TEXTAREA, fontFamily: 'ui-monospace, Menlo, monospace' }}
                    />
                    {editErrors[key] && (
                      <p style={{ fontSize: 11, color: 'var(--error)', marginTop: 4 }}>{editErrors[key]}</p>
                    )}
                  </div>
                ),
              )}

              <div>
                <label style={FORM_LABEL}>Extra Egress Allowlist</label>
                <textarea
                  value={editExtraEgress}
                  onChange={(e) => setEditExtraEgress(e.target.value)}
                  placeholder="api.example.com&#10;cdn.example.com"
                  style={{ ...FORM_TEXTAREA, fontFamily: 'ui-monospace, Menlo, monospace', minHeight: 60 }}
                />
                <p style={{ fontSize: 11, color: 'var(--muted-fg)', marginTop: 3 }}>One entry per line.</p>
              </div>
            </div>

            {updateMutation.isError && (
              <p style={{ fontSize: 12, color: 'var(--error)', marginTop: 12 }}>
                Failed to update application. Check your inputs and try again.
              </p>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 24 }}>
              <button
                onClick={() => setShowEdit(false)}
                style={{
                  height: 34, padding: '0 14px', borderRadius: 8,
                  border: '1px solid var(--border-2)', background: 'var(--card)',
                  color: 'var(--fg)', fontSize: 12.5, cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleEditSubmit}
                disabled={updateMutation.isPending}
                style={{
                  height: 34, padding: '0 14px', borderRadius: 8,
                  background: 'var(--primary)', color: 'var(--primary-fg)',
                  fontWeight: 600, fontSize: 12.5, border: 'none',
                  cursor: updateMutation.isPending ? 'default' : 'pointer',
                  opacity: updateMutation.isPending ? 0.6 : 1,
                }}
              >
                {updateMutation.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Breadcrumb + header */}
      <div style={{ marginBottom: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <Link to="/apps" style={{ fontSize: 12.5, color: 'var(--muted-fg)', textDecoration: 'none' }}>
            Applications
          </Link>
          <span style={{ color: 'var(--faint-fg)', fontSize: 12.5 }}>/</span>
          <span style={{ fontSize: 12.5, color: 'var(--fg)' }}>{app.name}</span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', margin: 0, color: 'var(--fg)' }}>
              {app.name}
            </h1>
            <StatusBadge value={app.execute_enabled ? 'ENABLED' : 'DISABLED'} />
          </div>
          <p style={{
            fontFamily: 'ui-monospace, Menlo, monospace',
            fontSize: 12, color: 'var(--faint-fg)', marginTop: 4, marginBottom: 0,
          }}>
            {app.id}
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {canWrite && (
            <button
              onClick={openEdit}
              style={{
                height: 34, padding: '0 14px', borderRadius: 8,
                border: '1px solid var(--border-2)', background: 'var(--card)',
                color: 'var(--fg)', fontSize: 12.5, cursor: 'pointer',
              }}
            >
              Edit
            </button>
          )}
          {canWrite && (
            <button
              onClick={() => setShowDeactivate(true)}
              style={{
                height: 34, padding: '0 14px', borderRadius: 8,
                border: `1px solid color-mix(in srgb, var(--warning) 40%, transparent)`,
                background: 'var(--card)',
                color: 'var(--warning)', fontSize: 12.5, cursor: 'pointer',
              }}
            >
              Deactivate
            </button>
          )}
          {canWrite && (
            <button
              onClick={() => setShowDestroy(true)}
              style={{
                height: 34, padding: '0 14px', borderRadius: 8,
                border: `1px solid color-mix(in srgb, var(--error) 40%, transparent)`,
                background: 'var(--card)',
                color: 'var(--error)', fontSize: 12.5, cursor: 'pointer',
              }}
            >
              Destroy
            </button>
          )}
        </div>
      </div>

      {/* Two-column: details + scale */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 16, marginBottom: 16 }}>
        {/* Details card */}
        <div style={CARD}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px 32px' }}>
            {[
              { label: 'Application ID', value: app.id, mono: true },
              { label: 'Tenant ID', value: app.tenant_id, mono: true },
              { label: 'Template ID', value: app.template_id ?? '—', mono: true },
              { label: 'Owner User ID', value: app.owner_user_id ?? '—', mono: true },
              { label: 'Created', value: new Date(app.created_at).toLocaleString(), mono: false },
              { label: 'Updated', value: new Date(app.updated_at).toLocaleString(), mono: false },
            ].map(({ label, value, mono }) => (
              <div key={label}>
                <div style={LABEL_STYLE}>{label}</div>
                <div style={mono ? FIELD_MONO : FIELD_TEXT}>{value}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Scale card */}
        <div style={CARD}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 500, color: 'var(--faint-fg)', marginBottom: 16 }}>
            SCALE
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted-fg)', marginBottom: 6 }}>Desired sessions</div>
          <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--fg)', marginBottom: 16 }}>
            {app.desired_session_count}
          </div>
          {canWrite && (
            <>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={scaleValue}
                  onChange={(e) => setScaleValue(e.target.value)}
                  placeholder="Count"
                  style={{
                    width: 80, height: 34, padding: '0 10px', borderRadius: 8,
                    border: '1px solid var(--border-2)', background: 'var(--bg)',
                    color: 'var(--fg)', fontSize: 13, outline: 'none', boxSizing: 'border-box',
                  }}
                />
                <button
                  onClick={() => scaleMutation.mutate()}
                  disabled={scaleMutation.isPending || scaleValue === ''}
                  style={{
                    height: 34, padding: '0 14px', borderRadius: 8,
                    background: 'var(--primary)', color: 'var(--primary-fg)',
                    fontWeight: 600, fontSize: 12.5, border: 'none',
                    cursor: scaleValue === '' || scaleMutation.isPending ? 'default' : 'pointer',
                    opacity: scaleValue === '' || scaleMutation.isPending ? 0.5 : 1,
                  }}
                >
                  {scaleMutation.isPending ? 'Scaling…' : 'Scale'}
                </button>
              </div>
              {scaleMutation.isError && (
                <p style={{ fontSize: 12, color: 'var(--error)', marginTop: 8 }}>Scale failed.</p>
              )}
            </>
          )}
        </div>
      </div>

      {/* Target URLs */}
      <div style={{ ...CARD, marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', marginBottom: 12 }}>Target URLs</div>
        {app.target_urls.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted-fg)', margin: 0 }}>None configured.</p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {app.target_urls.map((url) => (
              <li key={url} style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, color: 'var(--fg)' }}>
                {url}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Extra Egress Allowlist */}
      {(app.extra_egress_allowlist?.length ?? 0) > 0 && (
        <div style={{ ...CARD, marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', marginBottom: 12 }}>Extra Egress Allowlist</div>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {app.extra_egress_allowlist!.map((entry) => (
              <li key={entry} style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, color: 'var(--fg)' }}>
                {entry}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Config sections */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {configSections.map(({ label, value }) => (
          <div key={label} style={CARD}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', marginBottom: 12 }}>{label}</div>
            <pre style={PRE_STYLE}>
              {value ? JSON.stringify(value, null, 2) : 'null'}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
