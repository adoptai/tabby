import { useState } from 'react';
import { useParams, Link } from 'react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { profilesApi } from '@/api/profiles';
import { StatusBadge } from '@/components/shared/status-badge';
import { ConfirmDialog } from '@/components/shared/confirm-dialog';
import { useHasRole } from '@/hooks/use-role';

const LABEL_STYLE: React.CSSProperties = {
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  fontWeight: 500,
  color: 'var(--faint-fg)',
  marginBottom: 4,
};

const FIELD_MONO: React.CSSProperties = {
  fontFamily: 'ui-monospace, Menlo, monospace',
  fontSize: 12,
  color: 'var(--fg)',
  wordBreak: 'break-all',
};

const FIELD_TEXT: React.CSSProperties = { fontSize: 13, color: 'var(--fg)' };

const PRE_STYLE: React.CSSProperties = {
  fontFamily: 'ui-monospace, Menlo, monospace',
  fontSize: 12,
  overflowX: 'auto',
  background: 'var(--card-2)',
  padding: '12px 14px',
  borderRadius: 8,
  margin: 0,
  color: 'var(--fg)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
};

const CARD: React.CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: '20px 24px',
};

const STAT_CARD: React.CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: '16px 20px',
};

export function ProfileDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const canWrite = useHasRole('Admin', 'Editor');

  const [showPromote, setShowPromote] = useState(false);
  const [showRollback, setShowRollback] = useState(false);

  const { data: profile, isLoading } = useQuery({
    queryKey: ['profile', id],
    queryFn: () => profilesApi.get(id!),
    enabled: !!id,
  });

  const promoteMutation = useMutation({
    mutationFn: () => profilesApi.promote(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile', id] });
      qc.invalidateQueries({ queryKey: ['profiles'] });
      setShowPromote(false);
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: () => profilesApi.rollback(id!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile', id] });
      qc.invalidateQueries({ queryKey: ['profiles'] });
      setShowRollback(false);
    },
  });

  if (isLoading || !profile) {
    return <p style={{ color: 'var(--muted-fg)', fontSize: 13 }}>Loading…</p>;
  }

  const canPromote = canWrite && (profile.version_state === 'STAGING' || profile.version_state === 'CANARY');
  const canRollback = canWrite && profile.version_state === 'ACTIVE' && !!profile.parent_version_id;

  const errorRate =
    profile.version_state === 'CANARY' && profile.canary_request_count > 0
      ? ((profile.canary_error_count / profile.canary_request_count) * 100).toFixed(1)
      : null;

  const configSections = [
    { label: 'Login Config', value: profile.login_config },
    { label: 'Credential Types', value: profile.credential_types },
  ];

  return (
    <div>
      <ConfirmDialog
        open={showPromote}
        title="Promote Profile"
        description={
          profile.version_state === 'STAGING'
            ? 'This will move the profile from STAGING to CANARY.'
            : 'This will promote the profile from CANARY to ACTIVE.'
        }
        confirmLabel="Promote"
        onConfirm={async () => { await promoteMutation.mutateAsync(); }}
        onCancel={() => setShowPromote(false)}
      />
      <ConfirmDialog
        open={showRollback}
        title="Rollback Profile"
        description="This will roll back to the parent version. The current ACTIVE profile will be retired."
        confirmLabel="Rollback"
        destructive
        onConfirm={async () => { await rollbackMutation.mutateAsync(); }}
        onCancel={() => setShowRollback(false)}
      />

      {/* Breadcrumb */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <Link to="/profiles" style={{ fontSize: 12.5, color: 'var(--muted-fg)', textDecoration: 'none' }}>
          Profiles
        </Link>
        <span style={{ color: 'var(--faint-fg)', fontSize: 12.5 }}>/</span>
        <span style={{
          fontSize: 12.5, color: 'var(--fg)',
          fontFamily: 'ui-monospace, Menlo, monospace',
        }}>
          {profile.profile_id}
        </span>
      </div>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: '-0.02em', margin: 0, color: 'var(--fg)' }}>
              {profile.profile_id}
            </h1>
            <span style={{
              fontFamily: 'ui-monospace, Menlo, monospace',
              fontSize: 12, color: 'var(--muted-fg)',
              background: 'var(--card-2)', padding: '2px 8px', borderRadius: 6,
            }}>
              v{profile.version}
            </span>
            <StatusBadge value={profile.version_state} />
          </div>
          <p style={{
            fontFamily: 'ui-monospace, Menlo, monospace',
            fontSize: 12, color: 'var(--faint-fg)', marginTop: 4, marginBottom: 0,
          }}>
            {profile.id}
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          {canPromote && (
            <button
              onClick={() => setShowPromote(true)}
              disabled={promoteMutation.isPending}
              style={{
                height: 34, padding: '0 14px', borderRadius: 8,
                background: 'var(--primary)', color: 'var(--primary-fg)',
                fontWeight: 600, fontSize: 12.5, border: 'none',
                cursor: promoteMutation.isPending ? 'default' : 'pointer',
                opacity: promoteMutation.isPending ? 0.6 : 1,
              }}
            >
              {promoteMutation.isPending ? 'Promoting…' : 'Promote'}
            </button>
          )}
          {canRollback && (
            <button
              onClick={() => setShowRollback(true)}
              disabled={rollbackMutation.isPending}
              style={{
                height: 34, padding: '0 14px', borderRadius: 8,
                border: `1px solid color-mix(in srgb, var(--warning) 40%, transparent)`,
                background: 'var(--card)',
                color: 'var(--warning)', fontSize: 12.5,
                cursor: rollbackMutation.isPending ? 'default' : 'pointer',
                opacity: rollbackMutation.isPending ? 0.6 : 1,
              }}
            >
              {rollbackMutation.isPending ? 'Rolling back…' : 'Rollback'}
            </button>
          )}
        </div>
      </div>

      {/* Canary stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        <div style={STAT_CARD}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 500, color: 'var(--faint-fg)', marginBottom: 6 }}>
            State
          </div>
          <StatusBadge value={profile.version_state} />
        </div>
        <div style={STAT_CARD}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 500, color: 'var(--faint-fg)', marginBottom: 6 }}>
            Version
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--fg)' }}>{profile.version}</div>
        </div>
        <div style={STAT_CARD}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 500, color: 'var(--faint-fg)', marginBottom: 6 }}>
            Canary Requests
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>
            {profile.canary_request_count}
          </div>
        </div>
        <div style={STAT_CARD}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 500, color: 'var(--faint-fg)', marginBottom: 6 }}>
            Canary Errors
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: profile.canary_error_count > 0 ? 'var(--error)' : 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>
            {profile.canary_error_count}
          </div>
        </div>
      </div>

      {/* Error rate callout */}
      {errorRate !== null && (
        <div style={{ ...STAT_CARD, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 24 }}>
          <div>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 500, color: 'var(--faint-fg)', marginBottom: 4 }}>
              Canary Error Rate
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, color: Number(errorRate) > 5 ? 'var(--error)' : 'var(--success)' }}>
              {errorRate}%
            </div>
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted-fg)' }}>
            {profile.canary_error_count} errors / {profile.canary_request_count} requests
          </div>
        </div>
      )}

      {/* Details card */}
      <div style={{ ...CARD, marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px 32px' }}>
          {[
            { label: 'Profile ID', value: profile.profile_id, mono: true },
            { label: 'Record ID', value: profile.id, mono: true },
            { label: 'App ID', value: profile.app_id, mono: true },
            { label: 'Tenant ID', value: profile.tenant_id, mono: true },
            { label: 'Parent Version ID', value: profile.parent_version_id ?? '—', mono: true },
            { label: 'Owner User ID', value: profile.owner_user_id ?? '—', mono: true },
            { label: 'Created', value: new Date(profile.created_at).toLocaleString(), mono: false },
            { label: 'Updated', value: new Date(profile.updated_at).toLocaleString(), mono: false },
          ].map(({ label, value, mono }) => (
            <div key={label}>
              <div style={LABEL_STYLE}>{label}</div>
              <div style={mono ? FIELD_MONO : FIELD_TEXT}>{value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Target Domains */}
      <div style={{ ...CARD, marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', marginBottom: 12 }}>Target Domains</div>
        {profile.target_domains.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--muted-fg)', margin: 0 }}>None configured.</p>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {profile.target_domains.map((d) => (
              <li key={d} style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12, color: 'var(--fg)' }}>
                {d}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Config sections */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {configSections.map(({ label, value }) => (
          <div key={label} style={CARD}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--fg)', marginBottom: 12 }}>{label}</div>
            <pre style={PRE_STYLE}>
              {value ? JSON.stringify(value, null, 2) : 'null'}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
