import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { appsApi } from '@/api/apps';
import { StatusBadge } from '@/components/shared/status-badge';
import { useHasRole } from '@/hooks/use-role';

const PAGE_SIZE = 20;

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

export function AppsPage() {
  const [page, setPage] = useState(0);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const canWrite = useHasRole('Admin', 'Editor', 'Operator');

  const { data, isLoading } = useQuery({
    queryKey: ['apps', { limit: PAGE_SIZE, offset: page * PAGE_SIZE }],
    queryFn: () => appsApi.list({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
  });

  const apps = data?.data ?? [];
  const total = data?.total ?? 0;
  const hasNext = (page + 1) * PAGE_SIZE < total;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', margin: 0, color: 'var(--fg)' }}>
            Applications
          </h1>
          <p style={{ color: 'var(--muted-fg)', fontSize: 12.5, marginTop: 3, marginBottom: 0 }}>
            Configured browser automation applications
          </p>
        </div>
        {canWrite && (
          <Link
            to="/apps/new"
            style={{
              display: 'inline-flex', alignItems: 'center',
              height: 34, padding: '0 14px', borderRadius: 8,
              background: 'var(--primary)', color: 'var(--primary-fg)',
              fontWeight: 600, fontSize: 12.5, textDecoration: 'none',
            }}
          >
            + New Application
          </Link>
        )}
      </div>

      {isLoading && (
        <p style={{ color: 'var(--muted-fg)', fontSize: 13 }}>Loading…</p>
      )}

      {!isLoading && apps.length === 0 && (
        <div style={{
          border: '1px dashed var(--border-2)', borderRadius: 12,
          padding: '48px 24px', textAlign: 'center',
        }}>
          <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--fg)', margin: '0 0 6px' }}>
            No applications
          </p>
          <p style={{ fontSize: 13, color: 'var(--muted-fg)', margin: 0 }}>
            Create an application to start automating browser sessions.
          </p>
          {canWrite && (
            <Link
              to="/apps/new"
              style={{
                display: 'inline-flex', alignItems: 'center', marginTop: 16,
                height: 34, padding: '0 14px', borderRadius: 8,
                background: 'var(--primary)', color: 'var(--primary-fg)',
                fontWeight: 600, fontSize: 12.5, textDecoration: 'none',
              }}
            >
              + New Application
            </Link>
          )}
        </div>
      )}

      {apps.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
              <thead>
                <tr style={{ background: 'var(--card-2)' }}>
                  <th style={TH}>NAME</th>
                  <th style={TH}>TENANT</th>
                  <th style={TH}>SESSIONS</th>
                  <th style={TH}>EXECUTE</th>
                  <th style={TH}>CREATED</th>
                </tr>
              </thead>
              <tbody>
                {apps.map((app, i) => (
                  <tr
                    key={app.id}
                    onMouseEnter={() => setHoveredId(app.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    style={{
                      borderBottom: i < apps.length - 1 ? '1px solid var(--border)' : 'none',
                      background: hoveredId === app.id
                        ? 'color-mix(in srgb, var(--fg) 4%, transparent)'
                        : undefined,
                    }}
                  >
                    <td style={{ ...TD, fontWeight: 500 }}>
                      <Link
                        to={`/apps/${app.id}`}
                        style={{ color: 'var(--fg)', textDecoration: 'none' }}
                      >
                        {app.name}
                      </Link>
                    </td>
                    <td style={TD_MONO}>{app.tenant_id}</td>
                    <td style={{ ...TD, fontVariantNumeric: 'tabular-nums' }}>
                      {app.desired_session_count}
                    </td>
                    <td style={TD}>
                      <StatusBadge value={app.execute_enabled ? 'ENABLED' : 'DISABLED'} />
                    </td>
                    <td style={{ ...TD, color: 'var(--muted-fg)' }}>
                      {new Date(app.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{
            borderTop: '1px solid var(--border)', padding: '10px 14px',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            fontSize: 12, color: 'var(--muted-fg)',
          }}>
            <span>
              {total === 0
                ? '0 results'
                : `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total}`}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                style={{
                  height: 28, padding: '0 11px', borderRadius: 7,
                  border: '1px solid var(--border-2)', background: 'var(--card)',
                  color: 'var(--fg)', fontSize: 12,
                  cursor: page === 0 ? 'default' : 'pointer',
                  opacity: page === 0 ? 0.4 : 1,
                }}
              >
                Prev
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={!hasNext}
                style={{
                  height: 28, padding: '0 11px', borderRadius: 7,
                  border: '1px solid var(--border-2)', background: 'var(--card)',
                  color: 'var(--fg)', fontSize: 12,
                  cursor: !hasNext ? 'default' : 'pointer',
                  opacity: !hasNext ? 0.4 : 1,
                }}
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
