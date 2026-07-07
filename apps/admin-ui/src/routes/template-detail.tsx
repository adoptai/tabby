import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { templatesApi } from '@/api/templates';
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

const CARD: React.CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: '20px 24px',
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

const ERR: React.CSSProperties = { fontSize: 11, color: 'var(--error)', marginTop: 4 };

function tryParseJson(raw: string): unknown {
  if (!raw.trim()) return null;
  try { return JSON.parse(raw); } catch { return undefined; }
}

export function TemplateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canWrite = useHasRole('Admin', 'Editor');

  const [showDelete, setShowDelete] = useState(false);
  const [showEdit, setShowEdit] = useState(false);

  // Edit state
  const [editName, setEditName] = useState('');
  const [editProfilePattern, setEditProfilePattern] = useState('');
  const [editCredentialRef, setEditCredentialRef] = useState('');
  const [editIdleShutdown, setEditIdleShutdown] = useState('');
  const [editExecuteEnabled, setEditExecuteEnabled] = useState(false);
  const [editExtraEgress, setEditExtraEgress] = useState('');
  const [editLoginConfigSteps, setEditLoginConfigSteps] = useState<unknown[]>([]);
  const [editLoginConfigExtra, setEditLoginConfigExtra] = useState<Record<string, unknown>>({});
  const [editKeepaliveConfig, setEditKeepaliveConfig] = useState('');
  const [editExportPolicy, setEditExportPolicy] = useState('');
  const [editBrowserPolicy, setEditBrowserPolicy] = useState('');
  const [editNotificationConfig, setEditNotificationConfig] = useState('');
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});

  const { data: tpl, isLoading } = useQuery({
    queryKey: ['template', id],
    queryFn: () => templatesApi.get(id!),
    enabled: !!id,
  });

  const deleteMutation = useMutation({
    mutationFn: () => templatesApi.remove(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['templates'] });
      navigate('/templates');
    },
  });

  const updateMutation = useMutation({
    mutationFn: (payload: Parameters<typeof templatesApi.update>[1]) =>
      templatesApi.update(id!, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['template', id] });
      qc.invalidateQueries({ queryKey: ['templates'] });
      setShowEdit(false);
    },
  });

  if (isLoading || !tpl) {
    return <p style={{ color: 'var(--muted-fg)', fontSize: 13 }}>Loading…</p>;
  }

  function openEdit() {
    setEditName(tpl!.name);
    setEditProfilePattern(tpl!.profile_name_pattern ?? '');
    setEditCredentialRef(tpl!.credential_ref_default ?? '');
    setEditIdleShutdown(tpl!.idle_shutdown_seconds != null ? String(tpl!.idle_shutdown_seconds) : '');
    setEditExecuteEnabled(tpl!.execute_enabled);
    setEditExtraEgress(tpl!.extra_egress_allowlist?.join('\n') ?? '');
    if (tpl!.login_config && typeof tpl!.login_config === 'object') {
      const { steps, ...rest } = tpl!.login_config as Record<string, unknown>;
      setEditLoginConfigSteps(Array.isArray(steps) ? steps : []);
      setEditLoginConfigExtra(rest);
    } else {
      setEditLoginConfigSteps([]);
      setEditLoginConfigExtra({});
    }
    setEditKeepaliveConfig(tpl!.keepalive_config ? JSON.stringify(tpl!.keepalive_config, null, 2) : '');
    setEditExportPolicy(tpl!.export_policy ? JSON.stringify(tpl!.export_policy, null, 2) : '');
    setEditBrowserPolicy(tpl!.browser_policy ? JSON.stringify(tpl!.browser_policy, null, 2) : '');
    setEditNotificationConfig(tpl!.notification_config ? JSON.stringify(tpl!.notification_config, null, 2) : '');
    setEditErrors({});
    setShowEdit(true);
  }

  function handleEditSubmit() {
    const errors: Record<string, string> = {};
    if (!editName.trim()) errors.name = 'Name is required.';
    if (!editProfilePattern.trim()) errors.profile_name_pattern = 'Profile name pattern is required.';
    if (editIdleShutdown && (isNaN(Number(editIdleShutdown)) || Number(editIdleShutdown) < 60)) {
      errors.idle_shutdown_seconds = 'Must be a number ≥ 60.';
    }

    const jsonFields: [string, string][] = [
      ['keepalive_config', editKeepaliveConfig],
      ['export_policy', editExportPolicy],
      ['browser_policy', editBrowserPolicy],
      ['notification_config', editNotificationConfig],
    ];
    for (const [key, raw] of jsonFields) {
      if (raw.trim() && tryParseJson(raw) === undefined) errors[key] = 'Invalid JSON.';
    }

    if (Object.keys(errors).length) { setEditErrors(errors); return; }

    updateMutation.mutate({
      name: editName.trim(),
      profile_name_pattern: editProfilePattern.trim() || null,
      credential_ref_default: editCredentialRef.trim() || null,
      idle_shutdown_seconds: editIdleShutdown ? Number(editIdleShutdown) : null,
      execute_enabled: editExecuteEnabled,
      extra_egress_allowlist: editExtraEgress.split('\n').map((s) => s.trim()).filter(Boolean),
      login_config: { ...editLoginConfigExtra, steps: editLoginConfigSteps },
      keepalive_config: tryParseJson(editKeepaliveConfig),
      export_policy: tryParseJson(editExportPolicy),
      browser_policy: tryParseJson(editBrowserPolicy),
      notification_config: tryParseJson(editNotificationConfig),
    });
  }

  const configSections = [
    { label: 'Login Config', value: tpl.login_config },
    { label: 'Keepalive Config', value: tpl.keepalive_config },
    { label: 'Export Policy', value: tpl.export_policy },
    { label: 'Browser Policy', value: tpl.browser_policy },
    { label: 'Notification Config', value: tpl.notification_config },
  ];

  return (
    <div>
      <ConfirmDialog
        open={showDelete}
        title="Delete Template"
        description="This will permanently delete the template. Applications using it will not be affected."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => { await deleteMutation.mutateAsync(); setShowDelete(false); }}
        onCancel={() => setShowDelete(false)}
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
              Edit Template
            </h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label style={FORM_LABEL}>Name <span style={{ color: 'var(--error)' }}>*</span></label>
                <input value={editName} onChange={(e) => setEditName(e.target.value)} style={FORM_INPUT} />
                {editErrors.name && <p style={ERR}>{editErrors.name}</p>}
              </div>

              <div>
                <label style={FORM_LABEL}>Profile Name Pattern <span style={{ color: 'var(--error)' }}>*</span></label>
                <input
                  value={editProfilePattern}
                  onChange={(e) => setEditProfilePattern(e.target.value)}
                  placeholder="my-app-*"
                  style={{ ...FORM_INPUT, fontFamily: 'ui-monospace, Menlo, monospace' }}
                />
                {editErrors.profile_name_pattern && <p style={ERR}>{editErrors.profile_name_pattern}</p>}
              </div>

              <div>
                <label style={FORM_LABEL}>Credential Ref Default</label>
                <input
                  value={editCredentialRef}
                  onChange={(e) => setEditCredentialRef(e.target.value)}
                  placeholder="k8s:secret/my-secret"
                  style={{ ...FORM_INPUT, fontFamily: 'ui-monospace, Menlo, monospace' }}
                />
              </div>

              <div>
                <label style={FORM_LABEL}>Idle Shutdown Seconds</label>
                <input
                  type="number" min={60} step={1}
                  value={editIdleShutdown}
                  onChange={(e) => setEditIdleShutdown(e.target.value)}
                  placeholder="3600"
                  style={{ ...FORM_INPUT, width: 120 }}
                />
                {editErrors.idle_shutdown_seconds && <p style={ERR}>{editErrors.idle_shutdown_seconds}</p>}
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
                <label style={FORM_LABEL}>Extra Egress Allowlist</label>
                <textarea
                  value={editExtraEgress}
                  onChange={(e) => setEditExtraEgress(e.target.value)}
                  placeholder={'api.example.com\ncdn.example.com'}
                  style={{ ...FORM_TEXTAREA, fontFamily: 'ui-monospace, Menlo, monospace', minHeight: 60 }}
                />
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
                    {editErrors[key] && <p style={ERR}>{editErrors[key]}</p>}
                  </div>
                ),
              )}
            </div>

            {updateMutation.isError && (
              <p style={{ fontSize: 12, color: 'var(--error)', marginTop: 12 }}>
                Failed to update template. Check your inputs and try again.
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <Link to="/templates" style={{ fontSize: 12.5, color: 'var(--muted-fg)', textDecoration: 'none' }}>
          Templates
        </Link>
        <span style={{ color: 'var(--faint-fg)', fontSize: 12.5 }}>/</span>
        <span style={{ fontSize: 12.5, color: 'var(--fg)' }}>{tpl.name}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', margin: 0, color: 'var(--fg)' }}>
            {tpl.name}
          </h1>
          <p style={{
            fontFamily: 'ui-monospace, Menlo, monospace',
            fontSize: 12, color: 'var(--faint-fg)', marginTop: 4, marginBottom: 0,
          }}>
            {tpl.id}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
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
              onClick={() => setShowDelete(true)}
              style={{
                height: 34, padding: '0 14px', borderRadius: 8,
                border: `1px solid color-mix(in srgb, var(--error) 40%, transparent)`,
                background: 'var(--card)',
                color: 'var(--error)', fontSize: 12.5, cursor: 'pointer',
              }}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {/* Details card */}
      <div style={{ ...CARD, marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px 32px' }}>
          {[
            { label: 'Name', value: tpl.name, mono: false },
            { label: 'Profile Name Pattern', value: tpl.profile_name_pattern ?? '—', mono: true },
            { label: 'Credential Ref Default', value: tpl.credential_ref_default ?? '—', mono: true },
            { label: 'Idle Shutdown', value: tpl.idle_shutdown_seconds != null ? `${tpl.idle_shutdown_seconds}s` : '—', mono: false },
            { label: 'Execute Enabled', value: tpl.execute_enabled ? 'Yes' : 'No', mono: false },
            { label: 'Tenant ID', value: tpl.tenant_id ?? '—', mono: true },
          ].map(({ label, value, mono }) => (
            <div key={label}>
              <div style={LABEL_STYLE}>{label}</div>
              <div style={mono ? FIELD_MONO : FIELD_TEXT}>{value}</div>
            </div>
          ))}
        </div>
      </div>

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
