import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { agentClientsApi, type AgentClient } from '@/api/agent-clients';
import { useHasRole } from '@/hooks/use-role';
import { useAuthStore } from '@/stores/auth';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { EmptyState } from '@/components/shared/empty-state';

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

const BADGE_BASE: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 9999,
  fontSize: 11,
  fontWeight: 500,
};

interface RegisterDialogProps {
  open: boolean;
  defaultTenantId: string;
  onClose: () => void;
  onRegistered: (clientId: string, clientSecret: string) => void;
}

function RegisterDialog({ open, defaultTenantId, onClose, onRegistered }: RegisterDialogProps) {
  const [name, setName] = useState('');
  const [tenantId, setTenantId] = useState(defaultTenantId);
  const [allowedProfiles, setAllowedProfiles] = useState('');
  const [unrestrictedProfiles, setUnrestrictedProfiles] = useState(false);
  const [tokenTtl, setTokenTtl] = useState('');
  const [rateLimit, setRateLimit] = useState('');
  const [error, setError] = useState('');

  const parsedProfiles = allowedProfiles
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const mutation = useMutation({
    mutationFn: () =>
      agentClientsApi.register({
        name,
        tenant_id: tenantId,
        ...(unrestrictedProfiles
          ? { unrestricted_profiles: true }
          : { allowed_profiles: parsedProfiles }),
        ...(tokenTtl ? { token_ttl_seconds: Number(tokenTtl) } : {}),
        ...(rateLimit ? { rate_limit_per_minute: Number(rateLimit) } : {}),
      }),
    onSuccess: (data) => {
      onRegistered(data.client_id, data.client_secret);
      setName('');
      setAllowedProfiles('');
      setUnrestrictedProfiles(false);
      setTokenTtl('');
      setRateLimit('');
      setError('');
    },
    onError: (err: Error) => setError(err.message),
  });

  if (!open) return null;

  const profilesInvalid = !unrestrictedProfiles && parsedProfiles.length === 0;
  const isDisabled =
    mutation.isPending || !name.trim() || !tenantId.trim() || profilesInvalid;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isDisabled) return;
    mutation.mutate();
  };

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
          width: 480,
          maxHeight: '85vh',
          overflowY: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 18 }}>Register Agent Client</h3>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label style={LABEL_STYLE}>
              Name<span style={{ color: '#dc2626', marginLeft: 2 }}>*</span>
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-agent"
              required
              style={INPUT_STYLE}
            />
          </div>

          <div>
            <label style={LABEL_STYLE}>
              Tenant ID<span style={{ color: '#dc2626', marginLeft: 2 }}>*</span>
            </label>
            <input
              value={tenantId}
              onChange={(e) => setTenantId(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              required
              style={INPUT_STYLE}
            />
          </div>

          <div>
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={unrestrictedProfiles}
                onChange={(e) => setUnrestrictedProfiles(e.target.checked)}
                style={{ width: 15, height: 15 }}
              />
              Unrestricted Profiles
            </label>
          </div>

          {!unrestrictedProfiles && (
            <div>
              <label style={LABEL_STYLE}>
                Allowed Profiles<span style={{ color: '#dc2626', marginLeft: 2 }}>*</span>
                <span style={{ fontSize: 11, color: 'var(--faint-fg)', fontWeight: 400, marginLeft: 4 }}>
                  (one per line, min 1)
                </span>
              </label>
              <textarea
                value={allowedProfiles}
                onChange={(e) => setAllowedProfiles(e.target.value)}
                rows={3}
                placeholder={'salesforce-prod\nhubspot-staging'}
                style={TEXTAREA_STYLE}
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label style={LABEL_STYLE}>Token TTL Seconds</label>
              <input
                type="number"
                min={1}
                value={tokenTtl}
                onChange={(e) => setTokenTtl(e.target.value)}
                placeholder="3600"
                style={INPUT_STYLE}
              />
            </div>
            <div>
              <label style={LABEL_STYLE}>Rate Limit Per Minute</label>
              <input
                type="number"
                min={1}
                max={1000}
                value={rateLimit}
                onChange={(e) => setRateLimit(e.target.value)}
                placeholder="60"
                style={INPUT_STYLE}
              />
            </div>
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
              {mutation.isPending ? 'Registering...' : 'Register'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

interface SecretRevealDialogProps {
  open: boolean;
  clientId: string;
  clientSecret: string;
  title: string;
  onClose: () => void;
}

function SecretRevealDialog({
  open,
  clientId,
  clientSecret,
  title,
  onClose,
}: SecretRevealDialogProps) {
  const [copied, setCopied] = useState<'id' | 'secret' | null>(null);

  if (!open) return null;

  const copy = async (text: string, field: 'id' | 'secret') => {
    await navigator.clipboard.writeText(text);
    setCopied(field);
    setTimeout(() => setCopied(null), 2000);
  };

  const copyBtnStyle = (active: boolean): React.CSSProperties => ({
    flexShrink: 0,
    background: 'var(--card)',
    border: '1px solid var(--border)',
    color: active ? '#16a34a' : 'var(--fg)',
    borderRadius: 8,
    padding: '0 12px',
    height: 32,
    fontSize: 12,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });

  return (
    // Non-dismissable: no onClick on the backdrop
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
    >
      <div
        style={{
          background: 'var(--elev)',
          border: '1px solid var(--border-2)',
          borderRadius: 12,
          padding: 24,
          width: 480,
          maxHeight: '85vh',
          overflowY: 'auto',
        }}
      >
        <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 18 }}>{title}</h3>

        <div className="space-y-3">
          <div>
            <label style={LABEL_STYLE}>Client ID</label>
            <div className="flex items-center gap-2">
              <code
                style={{
                  flex: 1,
                  fontFamily: 'monospace',
                  fontSize: 12,
                  background: 'var(--card-2)',
                  borderRadius: 8,
                  padding: '8px 11px',
                  wordBreak: 'break-all',
                  display: 'block',
                }}
              >
                {clientId}
              </code>
              <button onClick={() => copy(clientId, 'id')} style={copyBtnStyle(copied === 'id')}>
                {copied === 'id' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          <div>
            <label style={LABEL_STYLE}>Client Secret</label>
            <div className="flex items-center gap-2">
              <code
                style={{
                  flex: 1,
                  fontFamily: 'monospace',
                  fontSize: 12,
                  background: 'var(--card-2)',
                  borderRadius: 8,
                  padding: '8px 11px',
                  wordBreak: 'break-all',
                  display: 'block',
                }}
              >
                {clientSecret}
              </code>
              <button
                onClick={() => copy(clientSecret, 'secret')}
                style={copyBtnStyle(copied === 'secret')}
              >
                {copied === 'secret' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
        </div>

        <p
          style={{
            fontSize: 13,
            color: '#dc2626',
            marginTop: 16,
            padding: '10px 12px',
            background: '#fee2e2',
            borderRadius: 8,
          }}
        >
          ⚠ Save this secret now. It cannot be retrieved again.
        </p>

        <div className="flex justify-end mt-6">
          <button
            onClick={onClose}
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
            Done, I've saved the secret
          </button>
        </div>
      </div>
    </div>
  );
}

export function AgentClientsPage() {
  const isAdmin = useHasRole('Admin');
  const currentTenantId = useAuthStore((s) => s.user?.tenant_id ?? '');
  const qc = useQueryClient();
  const [selectedTenantId, setSelectedTenantId] = useState(currentTenantId);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [secret, setSecret] = useState<{
    clientId: string;
    clientSecret: string;
    title: string;
  } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AgentClient | null>(null);
  const [rotateTarget, setRotateTarget] = useState<AgentClient | null>(null);
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);

  const { data: clients, isLoading } = useQuery({
    queryKey: ['agent-clients', selectedTenantId],
    queryFn: () => agentClientsApi.list(selectedTenantId),
    enabled: isAdmin && !!selectedTenantId.trim(),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => agentClientsApi.revoke(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-clients', selectedTenantId] });
      setRevokeTarget(null);
    },
  });

  const rotateMutation = useMutation({
    mutationFn: (id: string) => agentClientsApi.rotateSecret(id),
    onSuccess: (data, id) => {
      const client = clients?.find((c) => c.id === id);
      setRotateTarget(null);
      setSecret({
        clientId: client?.client_id ?? id,
        clientSecret: data.client_secret,
        title: 'New Client Secret',
      });
      qc.invalidateQueries({ queryKey: ['agent-clients', selectedTenantId] });
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
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--fg)' }}>Agent Clients</h1>
          <p style={{ fontSize: 13, color: 'var(--muted-fg)', marginTop: 2 }}>
            OAuth client credentials for AI agents
          </p>
        </div>
        <button
          onClick={() => setRegisterOpen(true)}
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
          + Register Client
        </button>
      </div>

      <div className="flex items-center gap-3 mb-4">
        <label style={{ fontSize: 12, fontWeight: 500, color: 'var(--muted-fg)' }}>Tenant</label>
        <input
          value={selectedTenantId}
          onChange={(e) => setSelectedTenantId(e.target.value)}
          placeholder="tenant-id"
          style={{
            height: 36,
            padding: '0 11px',
            borderRadius: 8,
            border: '1px solid var(--border-2)',
            background: 'var(--bg)',
            color: 'var(--fg)',
            fontSize: 13,
            width: 300,
            boxSizing: 'border-box',
            outline: 'none',
          }}
        />
      </div>

      {!selectedTenantId.trim() && (
        <p style={{ color: 'var(--muted-fg)', fontSize: 13 }}>
          Enter a tenant ID to view agent clients.
        </p>
      )}

      {selectedTenantId.trim() && isLoading && (
        <p style={{ color: 'var(--muted-fg)', fontSize: 13 }}>Loading...</p>
      )}

      {selectedTenantId.trim() && !isLoading && (clients ?? []).length === 0 && (
        <EmptyState
          title="No agent clients"
          description="Register an agent client to allow programmatic access."
          action={
            <button
              onClick={() => setRegisterOpen(true)}
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
              + Register Client
            </button>
          }
        />
      )}

      {(clients ?? []).length > 0 && (
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
                <th style={thStyle}>Client ID</th>
                <th style={thStyle}>Allowed Profiles</th>
                <th style={thStyle}>Revoked</th>
                <th style={thStyle}>Last Used</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {clients!.map((c) => (
                <tr
                  key={c.id}
                  onMouseEnter={() => setHoveredRow(c.id)}
                  onMouseLeave={() => setHoveredRow(null)}
                  style={{
                    borderTop: '1px solid var(--border)',
                    opacity: c.revoked_at ? 0.5 : 1,
                    background:
                      hoveredRow === c.id
                        ? 'color-mix(in srgb, var(--fg) 4%, transparent)'
                        : undefined,
                  }}
                >
                  <td style={{ ...tdStyle, fontWeight: 500 }}>{c.name}</td>
                  <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 12 }}>
                    {c.client_id}
                  </td>
                  <td style={tdStyle}>
                    {c.unrestricted_profiles ? (
                      <span
                        style={{ ...BADGE_BASE, background: '#fef9c3', color: '#854d0e' }}
                      >
                        Unrestricted
                      </span>
                    ) : c.allowed_profiles && c.allowed_profiles.length > 0 ? (
                      <span style={{ fontSize: 12, color: 'var(--fg)' }}>
                        {c.allowed_profiles.join(', ')}
                      </span>
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--faint-fg)' }}>None</span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    {c.revoked_at ? (
                      <span style={{ ...BADGE_BASE, background: '#fee2e2', color: '#991b1b' }}>
                        Revoked
                      </span>
                    ) : (
                      <span style={{ ...BADGE_BASE, background: '#dcfce7', color: '#15803d' }}>
                        Active
                      </span>
                    )}
                  </td>
                  <td style={{ ...tdStyle, color: 'var(--muted-fg)', fontSize: 12 }}>
                    {c.last_used_at ? new Date(c.last_used_at).toLocaleString() : '—'}
                  </td>
                  <td style={{ ...tdStyle, textAlign: 'right' }}>
                    {!c.revoked_at && (
                      <div className="flex items-center justify-end gap-3">
                        <button
                          onClick={() => setRotateTarget(c)}
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
                          Rotate Secret
                        </button>
                        <button
                          onClick={() => setRevokeTarget(c)}
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
                          Revoke
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <RegisterDialog
        open={registerOpen}
        defaultTenantId={selectedTenantId}
        onClose={() => setRegisterOpen(false)}
        onRegistered={(clientId, clientSecret) => {
          setRegisterOpen(false);
          setSecret({ clientId, clientSecret, title: 'Client Registered' });
          qc.invalidateQueries({ queryKey: ['agent-clients', selectedTenantId] });
        }}
      />

      {secret && (
        <SecretRevealDialog
          open
          clientId={secret.clientId}
          clientSecret={secret.clientSecret}
          title={secret.title}
          onClose={() => setSecret(null)}
        />
      )}

      <ConfirmDialog
        open={!!rotateTarget}
        title={`Rotate secret for "${rotateTarget?.name}"`}
        description="The current client secret will be invalidated immediately. Any agent using the old secret will start receiving 401 errors until updated."
        confirmLabel="Rotate Secret"
        destructive
        onConfirm={() => rotateMutation.mutate(rotateTarget!.id)}
        onCancel={() => setRotateTarget(null)}
      />

      <ConfirmDialog
        open={!!revokeTarget}
        title={`Revoke client "${revokeTarget?.name}"`}
        description="This client will be permanently revoked. It will no longer be able to obtain tokens. This cannot be undone."
        confirmLabel="Revoke Client"
        destructive
        onConfirm={() => revokeMutation.mutate(revokeTarget!.id)}
        onCancel={() => setRevokeTarget(null)}
      />
    </div>
  );
}
