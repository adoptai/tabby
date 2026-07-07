import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { sessionsApi } from '@/api/sessions';
import { StatusBadge } from '@/components/shared/status-badge';
import { useAuthStore } from '@/stores/auth';
import { useHasRole } from '@/hooks/use-role';

const PAGE_SIZE = 20;

const TABLE_HEADERS = ['Application', 'State', 'Health', 'Created'] as const;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function SessionsPage() {
  const [page, setPage] = useState(0);
  const [filterMode, setFilterMode] = useState<'all' | 'mine' | null>(null);
  const navigate = useNavigate();
  const isAdmin = useHasRole('Admin');
  const user = useAuthStore((s) => s.user);
  const effectiveMode = filterMode ?? (isAdmin ? 'all' : 'mine');

  const { data, isLoading } = useQuery({
    queryKey: ['sessions', { limit: PAGE_SIZE, offset: page * PAGE_SIZE }],
    queryFn: () => sessionsApi.list({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    refetchInterval: 10_000,
  });

  const allSessions = data?.data ?? [];
  const sessions =
    effectiveMode === 'mine'
      ? allSessions.filter((s) => s.owner_user_id === user?.owner_user_id)
      : allSessions;
  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min((page + 1) * PAGE_SIZE, total);
  const hasPrev = page > 0;
  const hasNext = (page + 1) * PAGE_SIZE < total;

  return (
    <div>
      {/* Page header */}
      <div style={{ marginBottom: '20px', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <h1
            style={{
              fontSize: '24px',
              fontWeight: 800,
              letterSpacing: '-0.02em',
              color: 'var(--fg)',
              margin: 0,
            }}
          >
            Sessions
          </h1>
          <p style={{ fontSize: '12.5px', color: 'var(--muted-fg)', marginTop: '4px', marginBottom: 0 }}>
            All active and recent sessions · refreshes every 10s
          </p>
        </div>

        {/* Segmented filter control */}
        <div
          style={{
            display: 'flex',
            height: '28px',
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            overflow: 'hidden',
            flexShrink: 0,
          }}
        >
          {(['all', 'mine'] as const).map((mode, idx) => {
            const active = effectiveMode === mode;
            return (
              <button
                key={mode}
                onClick={() => setFilterMode(mode)}
                style={{
                  height: '100%',
                  padding: '0 12px',
                  fontSize: '12px',
                  fontWeight: active ? 600 : 400,
                  border: 'none',
                  borderLeft: idx > 0 ? '1px solid var(--border)' : 'none',
                  background: active ? 'var(--primary)' : 'transparent',
                  color: active ? 'var(--primary-fg)' : 'var(--muted-fg)',
                  cursor: 'pointer',
                  transition: 'background 100ms, color 100ms',
                }}
              >
                {mode === 'all' ? 'All Sessions' : 'My Sessions'}
              </button>
            );
          })}
        </div>
      </div>

      {/* Table card */}
      <div
        style={{
          border: '1px solid var(--border)',
          borderRadius: '12px',
          overflow: 'hidden',
          background: 'var(--card)',
        }}
      >
        {isLoading ? (
          <div
            style={{
              padding: '48px',
              textAlign: 'center',
              color: 'var(--muted-fg)',
              fontSize: '13px',
            }}
          >
            Loading…
          </div>
        ) : sessions.length === 0 ? (
          <div
            style={{
              padding: '48px',
              textAlign: 'center',
              color: 'var(--muted-fg)',
              fontSize: '13px',
            }}
          >
            No sessions found.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--card-2)' }}>
                {TABLE_HEADERS.map((col) => (
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
              {sessions.map((s, i) => (
                <tr
                  key={s.id}
                  onClick={() => navigate(`/sessions/${s.id}`)}
                  style={{
                    borderBottom: i < sessions.length - 1 ? '1px solid var(--border)' : 'none',
                    cursor: 'pointer',
                    transition: 'background 80ms',
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.background =
                      'color-mix(in srgb, var(--fg) 4%, transparent)';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.background = 'transparent';
                  }}
                >
                  {/* Application */}
                  <td style={{ padding: '11px 14px', fontSize: '13px', color: 'var(--fg)' }}>
                    <span style={{ display: 'block' }}>
                      {s.application?.name ?? s.app_id}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        fontFamily: 'ui-monospace, Menlo, monospace',
                        fontSize: '11px',
                        color: 'var(--faint-fg)',
                        marginTop: '2px',
                      }}
                    >
                      {s.app_id}
                    </span>
                  </td>
                  {/* State */}
                  <td style={{ padding: '11px 14px' }}>
                    <StatusBadge value={s.state} />
                  </td>
                  {/* Health */}
                  <td style={{ padding: '11px 14px' }}>
                    <StatusBadge value={s.health_result_type} />
                  </td>
                  {/* Created */}
                  <td
                    style={{
                      padding: '11px 14px',
                      fontFamily: 'ui-monospace, Menlo, monospace',
                      fontSize: '12px',
                      color: 'var(--muted-fg)',
                    }}
                  >
                    {formatDate(s.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Pagination footer */}
        <div
          style={{
            borderTop: sessions.length > 0 || isLoading ? '1px solid var(--border)' : 'none',
            padding: '10px 14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ fontSize: '12px', color: 'var(--muted-fg)' }}>
            {total === 0 ? 'No results' : `Showing ${from}–${to} of ${total}`}
          </span>
          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={!hasPrev}
              style={{
                height: '28px',
                padding: '0 10px',
                borderRadius: '7px',
                border: '1px solid var(--border)',
                background: hasPrev ? 'var(--card)' : 'var(--card-2)',
                color: hasPrev ? 'var(--fg)' : 'var(--faint-fg)',
                fontSize: '12px',
                cursor: hasPrev ? 'pointer' : 'default',
                opacity: hasPrev ? 1 : 0.5,
              }}
            >
              Previous
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasNext}
              style={{
                height: '28px',
                padding: '0 10px',
                borderRadius: '7px',
                border: '1px solid var(--border)',
                background: hasNext ? 'var(--card)' : 'var(--card-2)',
                color: hasNext ? 'var(--fg)' : 'var(--faint-fg)',
                fontSize: '12px',
                cursor: hasNext ? 'pointer' : 'default',
                opacity: hasNext ? 1 : 0.5,
              }}
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
