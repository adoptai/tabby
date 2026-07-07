import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { templatesApi } from '@/api/templates';
import { StatusBadge } from '@/components/shared/status-badge';
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

export function TemplatesPage() {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const canWrite = useHasRole('Admin', 'Editor');

  const { data, isLoading } = useQuery({
    queryKey: ['templates'],
    queryFn: () => templatesApi.list(),
  });

  const templates = data ?? [];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', margin: 0, color: 'var(--fg)' }}>
            App Templates
          </h1>
          <p style={{ color: 'var(--muted-fg)', fontSize: 12.5, marginTop: 3, marginBottom: 0 }}>
            Reusable application configurations
          </p>
        </div>
        {canWrite && (
          <Link
            to="/templates/new"
            style={{
              display: 'inline-flex', alignItems: 'center',
              height: 34, padding: '0 14px', borderRadius: 8,
              background: 'var(--primary)', color: 'var(--primary-fg)',
              fontWeight: 600, fontSize: 12.5, textDecoration: 'none',
            }}
          >
            + New Template
          </Link>
        )}
      </div>

      {isLoading && (
        <p style={{ color: 'var(--muted-fg)', fontSize: 13 }}>Loading…</p>
      )}

      {!isLoading && templates.length === 0 && (
        <div style={{
          border: '1px dashed var(--border-2)', borderRadius: 12,
          padding: '48px 24px', textAlign: 'center',
        }}>
          <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--fg)', margin: '0 0 6px' }}>
            No templates
          </p>
          <p style={{ fontSize: 13, color: 'var(--muted-fg)', margin: 0 }}>
            Templates define reusable application configurations.
          </p>
          {canWrite && (
            <Link
              to="/templates/new"
              style={{
                display: 'inline-flex', alignItems: 'center', marginTop: 16,
                height: 34, padding: '0 14px', borderRadius: 8,
                background: 'var(--primary)', color: 'var(--primary-fg)',
                fontWeight: 600, fontSize: 12.5, textDecoration: 'none',
              }}
            >
              + New Template
            </Link>
          )}
        </div>
      )}

      {templates.length > 0 && (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
              <thead>
                <tr style={{ background: 'var(--card-2)' }}>
                  <th style={TH}>NAME</th>
                  <th style={TH}>PROFILE PATTERN</th>
                  <th style={TH}>IDLE SHUTDOWN</th>
                  <th style={TH}>EXECUTE</th>
                  <th style={TH}>CREATED</th>
                </tr>
              </thead>
              <tbody>
                {templates.map((tpl, i) => (
                  <tr
                    key={tpl.id}
                    onMouseEnter={() => setHoveredId(tpl.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    style={{
                      borderBottom: i < templates.length - 1 ? '1px solid var(--border)' : 'none',
                      background: hoveredId === tpl.id
                        ? 'color-mix(in srgb, var(--fg) 4%, transparent)'
                        : undefined,
                    }}
                  >
                    <td style={{ ...TD, fontWeight: 500 }}>
                      <Link
                        to={`/templates/${tpl.id}`}
                        style={{ color: 'var(--fg)', textDecoration: 'none' }}
                      >
                        {tpl.name}
                      </Link>
                    </td>
                    <td style={TD_MONO}>{tpl.profile_name_pattern ?? '—'}</td>
                    <td style={TD}>
                      {tpl.idle_shutdown_seconds != null ? `${tpl.idle_shutdown_seconds}s` : '—'}
                    </td>
                    <td style={TD}>
                      <StatusBadge value={tpl.execute_enabled ? 'ENABLED' : 'DISABLED'} />
                    </td>
                    <td style={{ ...TD, color: 'var(--muted-fg)' }}>
                      {new Date(tpl.created_at).toLocaleString()}
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
