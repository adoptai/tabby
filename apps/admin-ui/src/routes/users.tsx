import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { usersApi, type User } from '@/api/users';
import { useHasRole } from '@/hooks/use-role';
import { useAuthStore } from '@/stores/auth';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { EmptyState } from '@/components/shared/empty-state';

const PAGE_SIZE = 20;

const ROLES = ['Admin', 'Editor', 'Operator', 'Viewer'] as const;

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

const BADGE_BASE: React.CSSProperties = {
  display: 'inline-block',
  padding: '2px 8px',
  borderRadius: 9999,
  fontSize: 11,
  fontWeight: 500,
};

function RoleBadge({ role }: { role: string }) {
  switch (role) {
    case 'Admin':
      return (
        <span style={{ ...BADGE_BASE, background: 'var(--primary)', color: 'var(--primary-fg)' }}>
          {role}
        </span>
      );
    case 'Editor':
      return (
        <span style={{ ...BADGE_BASE, background: '#ede9fe', color: '#5b21b6' }}>{role}</span>
      );
    case 'Operator':
      return (
        <span style={{ ...BADGE_BASE, background: '#dbeafe', color: '#1d4ed8' }}>{role}</span>
      );
    case 'Viewer':
    default:
      return (
        <span style={{ ...BADGE_BASE, background: 'var(--card-2)', color: 'var(--muted-fg)' }}>
          {role}
        </span>
      );
  }
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'active') {
    return (
      <span style={{ ...BADGE_BASE, background: '#dcfce7', color: '#15803d' }}>{status}</span>
    );
  }
  return (
    <span style={{ ...BADGE_BASE, background: 'var(--card-2)', color: 'var(--muted-fg)' }}>
      {status}
    </span>
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

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--muted-fg)',
  marginBottom: 5,
  display: 'block',
};

interface CreateDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

function CreateUserDialog({ open, onClose, onCreated }: CreateDialogProps) {
  const currentTenantId = useAuthStore((s) => s.user?.tenant_id ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<string>('Operator');
  const [tenantId, setTenantId] = useState(currentTenantId);
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: () => usersApi.create({ email, password, role, tenant_id: tenantId }),
    onSuccess: () => {
      onCreated();
      onClose();
      setEmail('');
      setPassword('');
      setRole('Operator');
      setError('');
    },
    onError: (err: Error) => setError(err.message),
  });

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password || !tenantId.trim()) return;
    mutation.mutate();
  };

  const isDisabled =
    mutation.isPending || !email.trim() || !password || !tenantId.trim();

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
        <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 18 }}>New User</h3>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label style={LABEL_STYLE}>
              Email<span style={{ color: '#dc2626', marginLeft: 2 }}>*</span>
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              required
              style={INPUT_STYLE}
            />
          </div>

          <div>
            <label style={LABEL_STYLE}>
              Password<span style={{ color: '#dc2626', marginLeft: 2 }}>*</span>
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={INPUT_STYLE}
            />
            <p style={{ fontSize: 11, color: 'var(--faint-fg)', marginTop: 4 }}>
              Min 12 chars, must include uppercase, lowercase, digit, and special character
            </p>
          </div>

          <div>
            <label style={LABEL_STYLE}>
              Role<span style={{ color: '#dc2626', marginLeft: 2 }}>*</span>
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value)}
              style={INPUT_STYLE}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
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
              {mutation.isPending ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function UsersPage() {
  const isAdmin = useHasRole('Admin');
  const qc = useQueryClient();
  const [page, setPage] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<User | null>(null);
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['users', { limit: PAGE_SIZE, offset: page * PAGE_SIZE }],
    queryFn: () => usersApi.list({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    enabled: isAdmin,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => usersApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
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

  const users = data?.data ?? [];
  const total = data?.total ?? 0;

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
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--fg)' }}>Users</h1>
          <p style={{ fontSize: 13, color: 'var(--muted-fg)', marginTop: 2 }}>
            User account management
          </p>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
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
          + New User
        </button>
      </div>

      {isLoading && (
        <p style={{ color: 'var(--muted-fg)', fontSize: 13 }}>Loading...</p>
      )}

      {!isLoading && users.length === 0 && (
        <EmptyState
          title="No users"
          description="Create a user to get started."
          action={
            <button
              onClick={() => setCreateOpen(true)}
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
              + New User
            </button>
          }
        />
      )}

      {users.length > 0 && (
        <>
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
                  <th style={thStyle}>Email</th>
                  <th style={thStyle}>Role</th>
                  <th style={thStyle}>Tenant</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Created</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr
                    key={u.id}
                    onMouseEnter={() => setHoveredRow(u.id)}
                    onMouseLeave={() => setHoveredRow(null)}
                    style={{
                      borderTop: '1px solid var(--border)',
                      background:
                        hoveredRow === u.id
                          ? 'color-mix(in srgb, var(--fg) 4%, transparent)'
                          : undefined,
                    }}
                  >
                    <td style={tdStyle}>{u.email}</td>
                    <td style={tdStyle}>
                      <RoleBadge role={u.role} />
                    </td>
                    <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 12 }}>
                      {u.tenant_id}
                    </td>
                    <td style={tdStyle}>
                      <StatusBadge status={u.status} />
                    </td>
                    <td style={{ ...tdStyle, color: 'var(--muted-fg)' }}>
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                      <button
                        onClick={() => setDeleteTarget(u)}
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {total > PAGE_SIZE && (
            <div
              className="mt-4 flex items-center justify-between"
              style={{ fontSize: 13, color: 'var(--muted-fg)' }}
            >
              <span>
                Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                  disabled={page === 0}
                  style={{
                    background: 'var(--card)',
                    border: '1px solid var(--border)',
                    color: 'var(--fg)',
                    borderRadius: 6,
                    padding: '4px 12px',
                    fontSize: 13,
                    cursor: page === 0 ? 'not-allowed' : 'pointer',
                    opacity: page === 0 ? 0.5 : 1,
                  }}
                >
                  Prev
                </button>
                <button
                  onClick={() => setPage((p) => p + 1)}
                  disabled={(page + 1) * PAGE_SIZE >= total}
                  style={{
                    background: 'var(--card)',
                    border: '1px solid var(--border)',
                    color: 'var(--fg)',
                    borderRadius: 6,
                    padding: '4px 12px',
                    fontSize: 13,
                    cursor: (page + 1) * PAGE_SIZE >= total ? 'not-allowed' : 'pointer',
                    opacity: (page + 1) * PAGE_SIZE >= total ? 0.5 : 1,
                  }}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <CreateUserDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => qc.invalidateQueries({ queryKey: ['users'] })}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title={`Delete user "${deleteTarget?.email}"`}
        description="This will permanently remove the user. They will no longer be able to sign in."
        confirmLabel="Delete User"
        destructive
        onConfirm={() => deleteMutation.mutate(deleteTarget!.id)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
