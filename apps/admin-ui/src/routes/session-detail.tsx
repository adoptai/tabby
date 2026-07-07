import { useParams, Link } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { sessionsApi } from '@/api/sessions';
import { hitlApi } from '@/api/hitl';
import { StatusBadge } from '@/components/shared/status-badge';
import { useHasRole } from '@/hooks/use-role';
import { useAuthStore } from '@/stores/auth';

const INTERVENTION_HEADERS = ['Type', 'Outcome', 'Created', 'Completed'] as const;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function StatCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: '12px',
        padding: '14px 16px',
      }}
    >
      <p
        style={{
          fontSize: '11px',
          fontWeight: 500,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--faint-fg)',
          marginBottom: '8px',
          margin: '0 0 8px',
        }}
      >
        {label}
      </p>
      {children}
    </div>
  );
}

export function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const canOperate = useHasRole('Admin', 'Editor', 'Operator');
  const isAdmin = useHasRole('Admin');
  const currentUser = useAuthStore((s) => s.user);

  const { data: session, isLoading } = useQuery({
    queryKey: ['session', id],
    queryFn: () => sessionsApi.get(id!),
    refetchInterval: 5_000,
    enabled: !!id,
  });

  const { data: interventions } = useQuery({
    queryKey: ['interventions', id],
    queryFn: () => sessionsApi.interventions(id!, { limit: 20 }),
    enabled: !!id,
  });

  const streamMutation = useMutation({
    mutationFn: () => sessionsApi.stream(id!),
    onSuccess: (data) => window.open(data.url, '_blank'),
  });

  const takeoverMutation = useMutation({
    mutationFn: () => hitlApi.takeover(id!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session', id] }),
  });

  const releaseMutation = useMutation({
    mutationFn: () => hitlApi.release(id!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['session', id] }),
  });

  if (isLoading || !session) {
    return (
      <p style={{ color: 'var(--muted-fg)', fontSize: '13px' }}>Loading…</p>
    );
  }

  const isHitlState =
    session.state === 'LOGIN_IN_PROGRESS' || session.state === 'LOGIN_NEEDED';

  const canOpenViewer =
    isAdmin || session.owner_user_id === currentUser?.owner_user_id;

  const interventionRows = interventions?.data ?? [];

  return (
    <div>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          marginBottom: '24px',
        }}
      >
        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              marginBottom: '4px',
              flexWrap: 'wrap',
            }}
          >
            <h1
              style={{
                fontSize: '22px',
                fontWeight: 800,
                letterSpacing: '-0.02em',
                color: 'var(--fg)',
                margin: 0,
                fontFamily: 'ui-monospace, Menlo, monospace',
              }}
            >
              {session.id.slice(0, 8)}…
            </h1>
            <StatusBadge value={session.state} />
            {session.health_result_type && (
              <StatusBadge value={session.health_result_type} />
            )}
          </div>
          <p
            style={{
              fontSize: '12px',
              color: 'var(--faint-fg)',
              fontFamily: 'ui-monospace, Menlo, monospace',
              margin: 0,
            }}
          >
            {session.application?.name ?? session.app_id}
          </p>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
          {canOpenViewer ? (
            <Link
              to={`/sessions/${id}/viewer`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                height: '34px',
                padding: '0 14px',
                borderRadius: '8px',
                background: 'var(--primary)',
                color: '#fff',
                fontSize: '13px',
                fontWeight: 500,
                textDecoration: 'none',
              }}
            >
              Open Viewer
            </Link>
          ) : (
            <div title="You can only view sessions you own">
              <button
                disabled
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  height: '34px',
                  padding: '0 14px',
                  borderRadius: '8px',
                  background: 'var(--card-2)',
                  color: 'var(--faint-fg)',
                  fontSize: '13px',
                  fontWeight: 500,
                  border: '1px solid var(--border)',
                  cursor: 'not-allowed',
                  opacity: 0.6,
                }}
              >
                Open Viewer
              </button>
            </div>
          )}
          <button
            onClick={() => streamMutation.mutate()}
            disabled={streamMutation.isPending}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              height: '34px',
              padding: '0 14px',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              background: 'var(--card)',
              color: 'var(--fg)',
              fontSize: '13px',
              fontWeight: 500,
              cursor: streamMutation.isPending ? 'default' : 'pointer',
              opacity: streamMutation.isPending ? 0.6 : 1,
            }}
          >
            Stream URL
          </button>
        </div>
      </div>

      {/* Stats grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: '10px',
          marginBottom: '24px',
        }}
      >
        <StatCard label="State">
          <StatusBadge value={session.state} />
        </StatCard>
        <StatCard label="Health">
          <StatusBadge value={session.health_result_type} />
        </StatCard>
        <StatCard label="Retries">
          <p
            style={{
              fontSize: '22px',
              fontWeight: 800,
              color: 'var(--fg)',
              margin: 0,
              lineHeight: 1,
            }}
          >
            {session.retry_count}
          </p>
        </StatCard>
        <StatCard label="HITL Attempts">
          <p
            style={{
              fontSize: '22px',
              fontWeight: 800,
              color: 'var(--fg)',
              margin: 0,
              lineHeight: 1,
            }}
          >
            {session.hitl_attempt_count}
          </p>
        </StatCard>
      </div>

      {/* HITL controls */}
      {canOperate && isHitlState && (
        <div
          style={{
            marginBottom: '24px',
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: '12px',
            padding: '16px 18px',
          }}
        >
          <p
            style={{
              fontSize: '11px',
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--faint-fg)',
              margin: '0 0 12px',
            }}
          >
            HITL Controls
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => takeoverMutation.mutate()}
              disabled={takeoverMutation.isPending}
              style={{
                height: '34px',
                padding: '0 14px',
                borderRadius: '8px',
                background: 'var(--primary)',
                color: '#fff',
                fontSize: '13px',
                fontWeight: 500,
                border: 'none',
                cursor: takeoverMutation.isPending ? 'default' : 'pointer',
                opacity: takeoverMutation.isPending ? 0.6 : 1,
              }}
            >
              {takeoverMutation.isPending ? 'Taking over…' : 'Takeover Baton'}
            </button>
            <button
              onClick={() => releaseMutation.mutate()}
              disabled={releaseMutation.isPending}
              style={{
                height: '34px',
                padding: '0 14px',
                borderRadius: '8px',
                border: '1px solid var(--border)',
                background: 'var(--card)',
                color: 'var(--fg)',
                fontSize: '13px',
                fontWeight: 500,
                cursor: releaseMutation.isPending ? 'default' : 'pointer',
                opacity: releaseMutation.isPending ? 0.6 : 1,
              }}
            >
              {releaseMutation.isPending ? 'Releasing…' : 'Release Baton'}
            </button>
          </div>
        </div>
      )}

      {/* Interventions */}
      <h2
        style={{
          fontSize: '15px',
          fontWeight: 600,
          color: 'var(--fg)',
          margin: '0 0 12px',
        }}
      >
        Interventions
      </h2>
      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: '12px',
          overflow: 'hidden',
          background: 'var(--card)',
        }}
      >
        {interventionRows.length === 0 ? (
          <div
            style={{
              padding: '32px',
              textAlign: 'center',
              color: 'var(--muted-fg)',
              fontSize: '13px',
            }}
          >
            No interventions recorded.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--card-2)' }}>
                {INTERVENTION_HEADERS.map((col) => (
                  <th
                    key={col}
                    style={{
                      padding: '11px 14px',
                      textAlign: 'left',
                      fontSize: '11px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                      fontWeight: 500,
                      color: 'var(--faint-fg)',
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {interventionRows.map((item, i) => (
                <tr
                  key={item.id}
                  style={{
                    borderBottom:
                      i < interventionRows.length - 1
                        ? '1px solid var(--border)'
                        : 'none',
                  }}
                >
                  <td
                    style={{
                      padding: '11px 14px',
                      fontSize: '13px',
                      color: 'var(--fg)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.02em',
                    }}
                  >
                    {item.type}
                  </td>
                  <td style={{ padding: '11px 14px' }}>
                    <StatusBadge value={item.outcome} />
                  </td>
                  <td
                    style={{
                      padding: '11px 14px',
                      fontFamily: 'ui-monospace, Menlo, monospace',
                      fontSize: '12px',
                      color: 'var(--muted-fg)',
                    }}
                  >
                    {formatDate(item.created_at)}
                  </td>
                  <td
                    style={{
                      padding: '11px 14px',
                      fontFamily: 'ui-monospace, Menlo, monospace',
                      fontSize: '12px',
                      color: 'var(--muted-fg)',
                    }}
                  >
                    {item.completed_at ? formatDate(item.completed_at) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
