import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { idpApi, type IdentityProviderConfig } from '@/api/identity-providers';
import { useHasRole } from '@/hooks/use-role';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { EmptyState } from '@/components/shared/empty-state';

const DEFAULT_ROLES = ['Admin', 'Editor', 'Operator', 'Viewer'] as const;

function LockIcon() {
  return (
    <svg
      width="48"
      height="48"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ color: 'var(--faint-fg)', marginBottom: 12 }}
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

type IdpFormState = {
  provider_type: string;
  name: string;
  issuer_url: string;
  jwks_uri: string;
  auth_url: string;
  token_url: string;
  userinfo_url: string;
  audience: string;
  scopes: string;
  user_id_claim: string;
  email_claim: string;
  name_claim: string;
  tenant_id_claim: string;
  allow_auto_provision: boolean;
  enabled: boolean;
  admin_domains: string;
  default_role: string;
  role_claim: string;
  admin_role_values: string;
  editor_role_values: string;
};

const emptyForm = (): IdpFormState => ({
  provider_type: 'oidc',
  name: '',
  issuer_url: '',
  jwks_uri: '',
  auth_url: '',
  token_url: '',
  userinfo_url: '',
  audience: '',
  scopes: 'openid email profile',
  user_id_claim: 'sub',
  email_claim: 'email',
  name_claim: '',
  tenant_id_claim: '',
  allow_auto_provision: false,
  enabled: true,
  admin_domains: '',
  default_role: 'Operator',
  role_claim: '',
  admin_role_values: '',
  editor_role_values: '',
});

type ExtendedIdp = IdentityProviderConfig & {
  provider_type?: string;
  jwks_uri?: string;
  scopes?: string;
  name_claim?: string;
  enabled?: boolean;
};

function idpToForm(idp: IdentityProviderConfig): IdpFormState {
  const ext = idp as ExtendedIdp;
  return {
    provider_type: ext.provider_type ?? 'oidc',
    name: idp.name,
    issuer_url: idp.issuer_url ?? '',
    jwks_uri: ext.jwks_uri ?? '',
    auth_url: idp.auth_url ?? '',
    token_url: idp.token_url ?? '',
    userinfo_url: idp.userinfo_url ?? '',
    audience: idp.audience ?? '',
    scopes: ext.scopes ?? 'openid email profile',
    user_id_claim: idp.user_id_claim,
    email_claim: idp.email_claim,
    name_claim: ext.name_claim ?? '',
    tenant_id_claim: idp.tenant_id_claim ?? '',
    allow_auto_provision: idp.allow_auto_provision,
    enabled: ext.enabled ?? true,
    admin_domains: (idp.admin_domains ?? []).join('\n'),
    default_role: idp.default_role,
    role_claim: idp.role_claim ?? '',
    admin_role_values: (idp.admin_role_values ?? []).join('\n'),
    editor_role_values: (idp.editor_role_values ?? []).join('\n'),
  };
}

function formToPayload(form: IdpFormState): Partial<IdentityProviderConfig> {
  const splitLines = (s: string) =>
    s
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean);

  return {
    provider_type: form.provider_type,
    name: form.name,
    issuer_url: form.issuer_url,
    jwks_uri: form.jwks_uri || null,
    auth_url: form.auth_url || null,
    token_url: form.token_url || null,
    userinfo_url: form.userinfo_url || null,
    audience: form.audience || null,
    scopes: form.scopes || null,
    user_id_claim: form.user_id_claim,
    email_claim: form.email_claim,
    name_claim: form.name_claim || null,
    tenant_id_claim: form.tenant_id_claim || null,
    allow_auto_provision: form.allow_auto_provision,
    enabled: form.enabled,
    admin_domains: splitLines(form.admin_domains),
    default_role: form.default_role,
    role_claim: form.role_claim || null,
    admin_role_values: splitLines(form.admin_role_values),
    editor_role_values: splitLines(form.editor_role_values),
  } as Partial<IdentityProviderConfig>;
}

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  height: 36,
  padding: '0 11px',
  borderRadius: 8,
  border: '1px solid var(--border-2)',
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontSize: 13,
  boxSizing: 'border-box',
  outline: 'none',
};

const TEXTAREA_STYLE: React.CSSProperties = {
  width: '100%',
  padding: '8px 11px',
  borderRadius: 8,
  border: '1px solid var(--border-2)',
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontSize: 13,
  boxSizing: 'border-box',
  outline: 'none',
  resize: 'vertical',
};

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--muted-fg)',
  marginBottom: 5,
  display: 'block',
};

const SECTION_HEADER_STYLE: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--faint-fg)',
  paddingBottom: 8,
  borderBottom: '1px solid var(--border)',
  marginTop: 8,
  marginBottom: 12,
};

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <div style={SECTION_HEADER_STYLE}>{children}</div>;
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label style={LABEL_STYLE}>
        {label}
        {required && <span style={{ color: '#dc2626', marginLeft: 2 }}>*</span>}
      </label>
      {children}
    </div>
  );
}

interface IdpFormDialogProps {
  open: boolean;
  editing: IdentityProviderConfig | null;
  onClose: () => void;
  onSaved: () => void;
}

function IdpFormDialog({ open, editing, onClose, onSaved }: IdpFormDialogProps) {
  const [form, setForm] = useState<IdpFormState>(emptyForm);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setForm(editing ? idpToForm(editing) : emptyForm());
      setError('');
    }
  }, [open, editing?.id]);

  const set = <K extends keyof IdpFormState>(field: K, value: IdpFormState[K]) =>
    setForm((f) => ({ ...f, [field]: value }));

  const mutation = useMutation({
    mutationFn: () => {
      const payload = formToPayload(form);
      return editing
        ? idpApi.update(editing.id, payload)
        : idpApi.create(payload);
    },
    onSuccess: () => {
      onSaved();
      onClose();
      setError('');
    },
    onError: (err: Error) => setError(err.message),
  });

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };

  const isDisabled =
    mutation.isPending ||
    !form.name.trim() ||
    !form.issuer_url.trim() ||
    !form.provider_type;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--elev)',
          border: '1px solid var(--border-2)',
          borderRadius: 12,
          padding: 24,
          width: 600,
          maxHeight: '85vh',
          overflowY: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 18 }}>
          {editing ? 'Edit Identity Provider' : 'New Identity Provider'}
        </h3>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Top-level required fields */}
          <div className="grid grid-cols-2 gap-4">
            <Field label="Provider Type" required>
              <select
                value={form.provider_type}
                onChange={(e) => set('provider_type', e.target.value)}
                required
                style={INPUT_STYLE}
              >
                <option value="oidc">oidc</option>
                <option value="saml">saml</option>
              </select>
            </Field>
            <Field label="Name" required>
              <input
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder="My IdP"
                required
                style={INPUT_STYLE}
              />
            </Field>
          </div>

          {/* OIDC Configuration */}
          <SectionHeader>OIDC Configuration</SectionHeader>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Issuer URL">
              <input
                value={form.issuer_url}
                onChange={(e) => set('issuer_url', e.target.value)}
                placeholder="https://idp.example.com"
                style={INPUT_STYLE}
              />
            </Field>
            <Field label="JWKS URI">
              <input
                value={form.jwks_uri}
                onChange={(e) => set('jwks_uri', e.target.value)}
                placeholder="https://idp.example.com/.well-known/jwks.json"
                style={INPUT_STYLE}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Auth URL">
              <input
                value={form.auth_url}
                onChange={(e) => set('auth_url', e.target.value)}
                placeholder="https://idp.example.com/authorize"
                style={INPUT_STYLE}
              />
            </Field>
            <Field label="Token URL">
              <input
                value={form.token_url}
                onChange={(e) => set('token_url', e.target.value)}
                placeholder="https://idp.example.com/token"
                style={INPUT_STYLE}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Userinfo URL">
              <input
                value={form.userinfo_url}
                onChange={(e) => set('userinfo_url', e.target.value)}
                placeholder="https://idp.example.com/userinfo"
                style={INPUT_STYLE}
              />
            </Field>
            <Field label="Audience">
              <input
                value={form.audience}
                onChange={(e) => set('audience', e.target.value)}
                placeholder="api://my-app"
                style={INPUT_STYLE}
              />
            </Field>
          </div>

          <Field label="Scopes">
            <input
              value={form.scopes}
              onChange={(e) => set('scopes', e.target.value)}
              placeholder="openid email profile"
              style={INPUT_STYLE}
            />
          </Field>

          {/* User Identity Mapping */}
          <SectionHeader>User Identity Mapping</SectionHeader>

          <div className="grid grid-cols-2 gap-4">
            <Field label="User ID Claim">
              <input
                value={form.user_id_claim}
                onChange={(e) => set('user_id_claim', e.target.value)}
                style={INPUT_STYLE}
              />
            </Field>
            <Field label="Email Claim">
              <input
                value={form.email_claim}
                onChange={(e) => set('email_claim', e.target.value)}
                style={INPUT_STYLE}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Name Claim">
              <input
                value={form.name_claim}
                onChange={(e) => set('name_claim', e.target.value)}
                placeholder="name"
                style={INPUT_STYLE}
              />
            </Field>
            <Field label="Tenant ID Claim">
              <input
                value={form.tenant_id_claim}
                onChange={(e) => set('tenant_id_claim', e.target.value)}
                placeholder="tenant_id"
                style={INPUT_STYLE}
              />
            </Field>
          </div>

          {/* Role Mapping */}
          <SectionHeader>Role Mapping</SectionHeader>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Role Claim">
              <input
                value={form.role_claim}
                onChange={(e) => set('role_claim', e.target.value)}
                placeholder="roles"
                style={INPUT_STYLE}
              />
            </Field>
            <Field label="Default Role">
              <select
                value={form.default_role}
                onChange={(e) => set('default_role', e.target.value)}
                style={INPUT_STYLE}
              >
                {DEFAULT_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Admin Role Values (one per line)">
              <textarea
                value={form.admin_role_values}
                onChange={(e) => set('admin_role_values', e.target.value)}
                rows={3}
                placeholder={'admin\nsuperuser'}
                style={TEXTAREA_STYLE}
              />
            </Field>
            <Field label="Editor Role Values (one per line)">
              <textarea
                value={form.editor_role_values}
                onChange={(e) => set('editor_role_values', e.target.value)}
                rows={3}
                placeholder="editor"
                style={TEXTAREA_STYLE}
              />
            </Field>
          </div>

          <Field label="Admin Domains (one per line)">
            <textarea
              value={form.admin_domains}
              onChange={(e) => set('admin_domains', e.target.value)}
              rows={3}
              placeholder={'example.com\ncorp.example.com'}
              style={TEXTAREA_STYLE}
            />
          </Field>

          {/* Provisioning */}
          <SectionHeader>Provisioning</SectionHeader>

          <div className="flex flex-col gap-3">
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => set('enabled', e.target.checked)}
                style={{ width: 15, height: 15 }}
              />
              Enabled
            </label>
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={form.allow_auto_provision}
                onChange={(e) => set('allow_auto_provision', e.target.checked)}
                style={{ width: 15, height: 15 }}
              />
              Allow Auto-Provision (create tenants/users on first JWT validation)
            </label>
          </div>

          {error && <p style={{ fontSize: 12, color: '#dc2626' }}>{error}</p>}

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'var(--card)',
                border: '1px solid var(--border)',
                color: 'var(--fg)',
                borderRadius: 8,
                padding: '0 16px',
                height: 36,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isDisabled}
              style={{
                background: 'var(--primary)',
                color: 'var(--primary-fg)',
                border: 'none',
                borderRadius: 8,
                padding: '0 16px',
                height: 36,
                fontSize: 13,
                fontWeight: 500,
                cursor: isDisabled ? 'not-allowed' : 'pointer',
                opacity: isDisabled ? 0.5 : 1,
              }}
            >
              {mutation.isPending ? 'Saving...' : editing ? 'Save Changes' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface TestResult {
  key_count: number;
  latency_ms: number;
}

function TestJwksButton({ idpId }: { idpId: string }) {
  const [result, setResult] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState('');

  const mutation = useMutation({
    mutationFn: () => idpApi.test(idpId),
    onSuccess: (data) => {
      setResult(data);
      setTestError('');
    },
    onError: (err: Error) => {
      setTestError(err.message);
      setResult(null);
    },
  });

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        style={{
          fontSize: 12,
          color: 'var(--primary)',
          background: 'none',
          border: 'none',
          cursor: mutation.isPending ? 'not-allowed' : 'pointer',
          textDecoration: 'underline',
          opacity: mutation.isPending ? 0.5 : 1,
          padding: 0,
        }}
      >
        {mutation.isPending ? 'Testing...' : 'Test JWKS'}
      </button>
      {result && (
        <span style={{ fontSize: 11, color: '#16a34a' }}>
          ✓ {result.key_count} key{result.key_count !== 1 ? 's' : ''} ({result.latency_ms}ms)
        </span>
      )}
      {testError && (
        <span style={{ fontSize: 11, color: '#dc2626' }}>{testError}</span>
      )}
    </div>
  );
}

const BADGE_BASE: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 9999,
  fontSize: 11,
  fontWeight: 500,
};

export function IdentityProvidersPage() {
  const isAdmin = useHasRole('Admin');
  const qc = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<IdentityProviderConfig | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IdentityProviderConfig | null>(null);
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);

  const { data: idps, isLoading } = useQuery({
    queryKey: ['identity-providers'],
    queryFn: () => idpApi.list(),
    enabled: isAdmin,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => idpApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['identity-providers'] });
      setDeleteTarget(null);
    },
  });

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <LockIcon />
        <p style={{ fontSize: 15, fontWeight: 500, color: 'var(--fg)' }}>
          You don't have permission to view this page.
        </p>
      </div>
    );
  }

  const handleEdit = (idp: IdentityProviderConfig) => {
    setEditing(idp);
    setFormOpen(true);
  };

  const handleCloseForm = () => {
    setFormOpen(false);
    setEditing(null);
  };

  const thStyle: React.CSSProperties = {
    padding: '11px 14px',
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    fontWeight: 500,
    color: 'var(--faint-fg)',
    textAlign: 'left',
    background: 'var(--card-2)',
  };

  const tdStyle: React.CSSProperties = {
    padding: '11px 14px',
    fontSize: 13,
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--fg)' }}>
            Identity Providers
          </h1>
          <p style={{ fontSize: 13, color: 'var(--muted-fg)', marginTop: 2 }}>
            OIDC and SAML provider configuration
          </p>
        </div>
        <button
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
          style={{
            background: 'var(--primary)',
            color: 'var(--primary-fg)',
            border: 'none',
            borderRadius: 8,
            padding: '0 16px',
            height: 36,
            fontSize: 13,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          + New IdP
        </button>
      </div>

      {isLoading && (
        <p style={{ color: 'var(--muted-fg)', fontSize: 13 }}>Loading...</p>
      )}

      {!isLoading && (idps ?? []).length === 0 && (
        <EmptyState
          title="No identity providers"
          description="Add an IdP to enable OAuth/OIDC login."
          action={
            <button
              onClick={() => setFormOpen(true)}
              style={{
                background: 'var(--primary)',
                color: 'var(--primary-fg)',
                border: 'none',
                borderRadius: 8,
                padding: '0 16px',
                height: 36,
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              + New IdP
            </button>
          }
        />
      )}

      {(idps ?? []).length > 0 && (
        <div
          className="overflow-x-auto"
          style={{
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            overflow: 'hidden',
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Issuer URL</th>
                <th style={thStyle}>Auto-Provision</th>
                <th style={thStyle}>Default Role</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {idps!.map((idp) => (
                <tr
                  key={idp.id}
                  onMouseEnter={() => setHoveredRow(idp.id)}
                  onMouseLeave={() => setHoveredRow(null)}
                  style={{
                    borderTop: '1px solid var(--border)',
                    background:
                      hoveredRow === idp.id
                        ? 'color-mix(in srgb, var(--fg) 4%, transparent)'
                        : undefined,
                  }}
                >
                  <td style={{ ...tdStyle, fontWeight: 500 }}>{idp.name}</td>
                  <td
                    style={{
                      ...tdStyle,
                      fontFamily: 'monospace',
                      fontSize: 12,
                      maxWidth: 240,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={idp.issuer_url ?? ''}
                  >
                    {idp.issuer_url ?? '—'}
                  </td>
                  <td style={tdStyle}>
                    {idp.allow_auto_provision ? (
                      <span style={{ ...BADGE_BASE, background: '#dcfce7', color: '#15803d' }}>
                        Yes
                      </span>
                    ) : (
                      <span
                        style={{ ...BADGE_BASE, background: 'var(--card-2)', color: 'var(--muted-fg)' }}
                      >
                        No
                      </span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <span
                      style={{ ...BADGE_BASE, background: 'var(--card-2)', color: 'var(--muted-fg)' }}
                    >
                      {idp.default_role}
                    </span>
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    <div className="flex items-center justify-end gap-3">
                      <TestJwksButton idpId={idp.id} />
                      <button
                        onClick={() => handleEdit(idp)}
                        style={{
                          fontSize: 12,
                          color: 'var(--primary)',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          padding: 0,
                        }}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => setDeleteTarget(idp)}
                        style={{
                          fontSize: 12,
                          color: '#dc2626',
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          padding: 0,
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <IdpFormDialog
        open={formOpen}
        editing={editing}
        onClose={handleCloseForm}
        onSaved={() => qc.invalidateQueries({ queryKey: ['identity-providers'] })}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title={`Delete IdP "${deleteTarget?.name}"`}
        description="This will remove the identity provider. Users who only have access via this IdP will no longer be able to sign in."
        confirmLabel="Delete IdP"
        destructive
        onConfirm={() => deleteMutation.mutate(deleteTarget!.id)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
