import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { profilesApi } from '@/api/profiles';
import { StatusBadge } from '@/components/shared/status-badge';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useHasRole } from '@/hooks/use-role';

const TH: React.CSSProperties = {
  padding: '11px 14px',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  fontWeight: 500,
  color: 'var(--faint-fg)',
  textAlign: 'left',
};

const TD: React.CSSProperties = { padding: '11px 14px', fontSize: 13, color: 'var(--fg)' };
const TD_MONO: React.CSSProperties = {
  padding: '11px 14px',
  fontFamily: 'ui-monospace, Menlo, monospace',
  fontSize: 12,
  color: 'var(--muted-fg)',
};

type ConfirmAction = { type: 'promote' | 'rollback'; id: string };

export function ProfilesPage() {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const canWrite = useHasRole('Admin', 'Editor');
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['profiles'],
    queryFn: () => profilesApi.list(),
  });

  const profiles = data ?? [];

  const promoteMutation = useMutation({
    mutationFn: (id: string) => profilesApi.promote(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profiles'] });
      setConfirmAction(null);
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: (id: string) => profilesApi.rollback(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profiles'] });
      setConfirmAction(null);
    },
  });

  const isPending = promoteMutation.isPending || rollbackMutation.isPending;

  return (
    <div>
      <ConfirmDialog
        open={confirmAction?.type === 'promote'}
        title="Promote Profile"
        description="This will advance the profile to the next stage. STAGING → CANARY → ACTIVE."
        confirmLabel="Promote"
        onConfirm={async () => {
          if (confirmAction) await promoteMutation.mutateAsync(confirmAction.id);
        }}
        onCancel={() => setConfirmAction(null)}
      />
      <ConfirmDialog
        open={confirmAction?.type === 'rollback'}
        title="Rollback Profile"
        description="This will roll back the active profile to its parent version."
        confirmLabel="Rollback"
        destructive
        onConfirm={async () => {
          if (confirmAction) await rollbackMutation.mutateAsync(confirmAction.id);
        }}
        onCancel={() => setConfirmAction(null)}
      />

      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', margin: 0, color: 'var(--fg)' }}>
          Profiles
        </h1>
        <p style={{ color: 'var(--muted-fg)', fontSize: 12.5, marginTop: 3, marginBottom: 0 }}>
          Service profile versions and canary management
        </p>
      </div>

      {isLoading && (
        <p style={{ color: 'var(--muted-fg)', fontSize: 13 }}>Loading…</p>
      )}

      {!isLoading && profiles.length === 0 && (
        <div style={{
          border: '1px dashed var(--border-2)', borderRadius: 12,
          padding: '48px 24px', textAlign: 'center',
        }}>
          <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--fg)', margin: '0 0 6px' }}>
            No profiles
          </p>
          <p style={{ fontSize: 13, color: 'var(--muted-fg)', margin: 0 }}>
            Service profiles are created automatically when applications run.
          </p>
        </div>
      )}

      {profiles.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
              <thead>
                <tr style={{ background: 'var(--card-2)' }}>
                  <th style={TH}>PROFILE ID</th>
                  <th style={TH}>VERSION</th>
                  <th style={TH}>STATE</th>
                  <th style={TH}>APP ID</th>
                  <th style={TH}>CANARY REQ</th>
                  <th style={TH}>CANARY ERR</th>
                  <th style={{ ...TH, textAlign: 'right' }}>ACTIONS</th>
                </tr>
              </thead>
              <tbody>
                {profiles.map((p, i) => (
                  <tr
                    key={p.id}
                    onMouseEnter={() => setHoveredId(p.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    style={{
                      borderBottom: i < profiles.length - 1 ? '1px solid var(--border)' : 'none',
                      background: hoveredId === p.id
                        ? 'color-mix(in srgb, var(--fg) 4%, transparent)'
                        : undefined,
                    }}
                  >
                    <td style={TD_MONO}>
                      <Link
                        to={`/profiles/${p.id}`}
                        style={{ color: 'var(--primary)', textDecoration: 'none' }}
                      >
                        {p.profile_id}
                      </Link>
                    </td>
                    <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>{p.version}</td>
                    <td style={TD}>
                      <StatusBadge value={p.version_state} />
                    </td>
                    <td style={{ ...TD_MONO, color: 'var(--muted-fg)' }}>{p.app_id}</td>
                    <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>{p.canary_request_count}</td>
                    <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>{p.canary_error_count}</td>
                    <td style={{ ...TD, textAlign: 'right' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                        {canWrite && (p.version_state === 'STAGING' || p.version_state === 'CANARY') && (
                          <button
                            onClick={() => setConfirmAction({ type: 'promote', id: p.id })}
                            disabled={isPending}
                            style={{
                              height: 26, padding: '0 10px', borderRadius: 6,
                              border: '1px solid var(--border-2)', background: 'var(--card)',
                              color: 'var(--fg)', fontSize: 12, cursor: isPending ? 'default' : 'pointer',
                              opacity: isPending ? 0.5 : 1,
                            }}
                          >
                            Promote
                          </button>
                        )}
                        {canWrite && p.version_state === 'ACTIVE' && p.parent_version_id && (
                          <button
                            onClick={() => setConfirmAction({ type: 'rollback', id: p.id })}
                            disabled={isPending}
                            style={{
                              height: 26, padding: '0 10px', borderRadius: 6,
                              border: `1px solid color-mix(in srgb, var(--warning) 40%, transparent)`,
                              background: 'var(--card)',
                              color: 'var(--warning)', fontSize: 12,
                              cursor: isPending ? 'default' : 'pointer',
                              opacity: isPending ? 0.5 : 1,
                            }}
                          >
                            Rollback
                          </button>
                        )}
                        <Link
                          to={`/profiles/${p.id}`}
                          style={{ fontSize: 12, color: 'var(--primary)', textDecoration: 'none' }}
                        >
                          Details
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
