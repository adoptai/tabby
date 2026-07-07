import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { tenantsApi, type Tenant } from '@/api/tenants';
import { useHasRole } from '@/hooks/use-role';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { EmptyState } from '@/components/shared/empty-state';

const PAGE_SIZE = 20;

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

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 500,
  color: 'var(--muted-fg)',
  marginBottom: 5,
  display: 'block',
};

interface TenantDialogProps {
  open: boolean;
  editing: Tenant | null;
  onClose: () => void;
  onSaved: () => void;
}

function TenantDialog({ open, editing, onClose, onSaved }: TenantDialogProps) {
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [maxSessions, setMaxSessions] = useState('10');
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? '');
      setId(editing?.id ?? '');
      setMaxSessions(String(editing?.max_sessions ?? 10));
      setError('');
    }
  }, [open, editing?.id]);

  const mutation = useMutation({
    mutationFn: () =>
      editing
        ? tenantsApi.update(editing.id, { max_sessions: Number(maxSessions) })
        : tenantsApi.create({
            name,
            ...(id.trim() ? { id: id.trim() } : {}),
            max_sessions: Number(maxSessions),
          }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing && !name.trim()) return;
    mutation.mutate();
  };

  const isDisabled = mutation.isPending || (!editing && !name.trim());

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
        <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 18 }}>
          {editing ? 'Edit Tenant' : 'New Tenant'}
        </h3>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label style={LABEL_STYLE}>
              Name{!editing && <span style={{ color: '#dc2626', marginLeft: 2 }}>*</span>}
            </label>
            {editing ? (
              <div
                style={{
                  ...INPUT_STYLE,
                  display: 'flex',
                  alignItems: 'center',
                  opacity: 0.55,
                  cursor: 'default',
                  userSelect: 'none',
                }}
              >
                {editing.name}
              </div>
            ) : (
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="acme-corp"
                required
                style={INPUT_STYLE}
              />
            )}
          </div>

          {!editing && (
            <div>
              <label style={LABEL_STYLE}>
                ID{' '}
                <span style={{ fontSize: 11, color: 'var(--faint-fg)', fontWeight: 400 }}>
                  (optional, auto-generated)
                </span>
              </label>
              <input
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="acme-corp"
                style={INPUT_STYLE}
              />
            </div>
          )}

          <div>
            <label style={LABEL_STYLE}>
              Max Sessions<span style={{ color: '#dc2626', marginLeft: 2 }}>*</span>
            </label>
            <input
              type="number"
              min={1}
              max={1000}
              value={maxSessions}
              onChange={(e) => setMaxSessions(e.target.value)}
              style={{ ...INPUT_STYLE, fontVariantNumeric: 'tabular-nums' }}
            />
          </div>

          {error && (
            <p style={{ fontSize: 12, color: '#dc2626' }}>{error}</p>
          )}

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
              {mutation.isPending
                ? editing
                  ? 'Saving...'
                  : 'Creating...'
                : editing
                ? 'Save Changes'
                : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function TenantsPage() {
  const isAdmin = useHasRole('Admin');
  const qc = useQueryClient();
  const [page, setPage] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Tenant | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Tenant | null>(null);
  const [hoveredRow, setHoveredRow] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['tenants', { limit: PAGE_SIZE, offset: page * PAGE_SIZE }],
    queryFn: () => tenantsApi.list({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    enabled: isAdmin,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => tenantsApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenants'] });
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

  const tenants = data?.data ?? [];
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

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--fg)' }}>Tenants</h1>
          <p style={{ fontSize: 13, color: 'var(--muted-fg)', marginTop: 2 }}>
            Multi-tenant management
          </p>
        </div>
        <button
          onClick={openCreate}
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
          + New Tenant
        </button>
      </div>

      {isLoading && (
        <p style={{ color: 'var(--muted-fg)', fontSize: 13 }}>Loading...</p>
      )}

      {!isLoading && tenants.length === 0 && (
        <EmptyState
          title="No tenants"
          description="Create a tenant to get started."
          action={
            <button
              onClick={openCreate}
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
              + New Tenant
            </button>
          }
        />
      )}

      {tenants.length > 0 && (
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
                  <th style={thStyle}>ID</th>
                  <th style={thStyle}>Name</th>
                  <th style={{ ...thStyle, fontVariantNumeric: 'tabular-nums' }}>Max Sessions</th>
                  <th style={thStyle}>Created</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <tr
                    key={t.id}
                    onMouseEnter={() => setHoveredRow(t.id)}
                    onMouseLeave={() => setHoveredRow(null)}
                    style={{
                      borderTop: '1px solid var(--border)',
                      background:
                        hoveredRow === t.id
                          ? 'color-mix(in srgb, var(--fg) 4%, transparent)'
                          : undefined,
                    }}
                  >
                    <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 12 }}>{t.id}</td>
                    <td style={{ ...tdStyle, fontWeight: 500 }}>{t.name}</td>
                    <td style={{ ...tdStyle, fontVariantNumeric: 'tabular-nums' }}>
                      {t.max_sessions}
                    </td>
                    <td style={{ ...tdStyle, color: 'var(--muted-fg)' }}>
                      {new Date(t.created_at).toLocaleDateString()}
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                      <div className="flex items-center justify-end gap-3">
                        <button
                          onClick={() => {
                            setEditing(t);
                            setDialogOpen(true);
                          }}
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
                          onClick={() => setDeleteTarget(t)}
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

      <TenantDialog
        open={dialogOpen}
        editing={editing}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
        onSaved={() => qc.invalidateQueries({ queryKey: ['tenants'] })}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title={`Delete tenant "${deleteTarget?.name}"`}
        description="This will permanently delete the tenant and all associated data."
        confirmLabel="Delete Tenant"
        destructive
        requireInput={deleteTarget?.name}
        onConfirm={() => deleteMutation.mutate(deleteTarget!.id)}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
