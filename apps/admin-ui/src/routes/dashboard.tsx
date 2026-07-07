import { useQuery } from '@tanstack/react-query';
import { sessionsApi } from '@/api/sessions';
import { appsApi } from '@/api/apps';
import { StatusBadge } from '@/components/shared/status-badge';

const STATE_CARDS: Array<{ state: string; color: string }> = [
  { state: 'HEALTHY', color: 'var(--success)' },
  { state: 'STARTING', color: 'var(--info)' },
  { state: 'LOGIN_NEEDED', color: 'var(--warning)' },
  { state: 'LOGIN_IN_PROGRESS', color: 'var(--violet)' },
  { state: 'UNHEALTHY', color: 'var(--warning)' },
  { state: 'FAILED', color: 'var(--error)' },
  { state: 'TERMINATED', color: 'var(--neutral)' },
];

const ATTENTION_STATES = new Set([
  'LOGIN_NEEDED',
  'UNHEALTHY',
  'FAILED',
  'AUTH_FAIL',
  'TRANSIENT_FAIL',
]);

export function DashboardPage() {
  const { data: sessionsData } = useQuery({
    queryKey: ['sessions', { limit: 200 }],
    queryFn: () => sessionsApi.list({ limit: 200 }),
    refetchInterval: 10_000,
  });

  const { data: appsData } = useQuery({
    queryKey: ['apps', {}],
    queryFn: () => appsApi.list({}),
    refetchInterval: 10_000,
  });

  const sessions = sessionsData?.data ?? [];
  const counts: Record<string, number> = {};
  for (const s of sessions) {
    counts[s.state] = (counts[s.state] ?? 0) + 1;
  }

  const needsAttention = sessions.filter((s) => ATTENTION_STATES.has(s.state)).length;
  const appCount = appsData?.total ?? 0;

  return (
    <div>
      {/* Title row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          marginBottom: '20px',
        }}
      >
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
            Dashboard
          </h1>
          <p style={{ fontSize: '12.5px', color: 'var(--muted-fg)', marginTop: '4px' }}>
            Session health across all applications · refreshes every 10s
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '7px', paddingTop: '4px' }}>
          <span
            style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: 'var(--success)',
              display: 'inline-block',
              animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
            }}
          />
          <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--success)' }}>Live</span>
        </div>
      </div>

      {/* Health cards grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(7, 1fr)',
          gap: '10px',
          marginBottom: '14px',
        }}
      >
        {STATE_CARDS.map(({ state, color }) => (
          <div
            key={state}
            style={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: '12px',
              padding: '16px 18px',
            }}
          >
            <StatusBadge value={state} />
            <p
              style={{
                fontSize: '30px',
                fontWeight: 800,
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: '-0.02em',
                color: 'var(--fg)',
                margin: '10px 0 12px',
                lineHeight: 1,
              }}
            >
              {counts[state] ?? 0}
            </p>
            <div
              style={{
                height: '3px',
                borderRadius: '2px',
                backgroundColor: color,
                opacity: 0.7,
              }}
            />
          </div>
        ))}
      </div>

      {/* Summary row */}
      <div style={{ display: 'flex', gap: '14px' }}>
        {/* Stats card */}
        <div
          style={{
            flex: 1,
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: '12px',
            padding: '16px 18px',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <div style={{ flex: 1, textAlign: 'center' }}>
            <p
              style={{
                fontSize: '11px',
                fontWeight: 500,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: 'var(--faint-fg)',
                marginBottom: '6px',
              }}
            >
              Total Sessions
            </p>
            <p
              style={{
                fontSize: '26px',
                fontWeight: 800,
                color: 'var(--fg)',
                lineHeight: 1,
                margin: 0,
              }}
            >
              {sessions.length}
            </p>
          </div>

          <div style={{ width: '1px', height: '40px', background: 'var(--border)' }} />

          <div style={{ flex: 1, textAlign: 'center' }}>
            <p
              style={{
                fontSize: '11px',
                fontWeight: 500,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: 'var(--faint-fg)',
                marginBottom: '6px',
              }}
            >
              Needs Attention
            </p>
            <p
              style={{
                fontSize: '26px',
                fontWeight: 800,
                color: needsAttention > 0 ? 'var(--warning)' : 'var(--fg)',
                lineHeight: 1,
                margin: 0,
              }}
            >
              {needsAttention}
            </p>
          </div>

          <div style={{ width: '1px', height: '40px', background: 'var(--border)' }} />

          <div style={{ flex: 1, textAlign: 'center' }}>
            <p
              style={{
                fontSize: '11px',
                fontWeight: 500,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                color: 'var(--faint-fg)',
                marginBottom: '6px',
              }}
            >
              Applications
            </p>
            <p
              style={{
                fontSize: '26px',
                fontWeight: 800,
                color: 'var(--fg)',
                lineHeight: 1,
                margin: 0,
              }}
            >
              {appCount}
            </p>
          </div>
        </div>

        {/* Recent activity card */}
        <div
          style={{
            width: '340px',
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
              marginBottom: '12px',
            }}
          >
            Recent Activity
          </p>
          <p style={{ fontSize: '13px', color: 'var(--muted-fg)', margin: 0 }}>
            No recent activity.
          </p>
        </div>
      </div>
    </div>
  );
}
