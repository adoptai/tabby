import { useState } from 'react';
import { useLocation } from 'react-router';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { Sun, Moon, Power } from 'lucide-react';

const ROUTE_LABELS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^\/dashboard$/, label: 'Dashboard' },
  { pattern: /^\/sessions\/[^/]+\/viewer/, label: 'Session Viewer' },
  { pattern: /^\/sessions\/[^/]+/, label: 'Session Detail' },
  { pattern: /^\/sessions/, label: 'Sessions' },
  { pattern: /^\/apps\/new/, label: 'New Application' },
  { pattern: /^\/apps\/[^/]+/, label: 'Application' },
  { pattern: /^\/apps/, label: 'Applications' },
  { pattern: /^\/templates\/new/, label: 'New Template' },
  { pattern: /^\/templates\/[^/]+\/edit/, label: 'Edit Template' },
  { pattern: /^\/templates\/[^/]+/, label: 'Template' },
  { pattern: /^\/templates/, label: 'App Templates' },
  { pattern: /^\/profiles\/[^/]+/, label: 'Profile' },
  { pattern: /^\/profiles/, label: 'Profiles' },
  { pattern: /^\/tenants/, label: 'Tenants' },
  { pattern: /^\/users/, label: 'Users' },
  { pattern: /^\/identity-providers/, label: 'Identity Providers' },
  { pattern: /^\/agent-clients/, label: 'Agent Clients' },
];

function getPageLabel(pathname: string): string {
  for (const { pattern, label } of ROUTE_LABELS) {
    if (pattern.test(pathname)) return label;
  }
  return '';
}

const ROLE_BADGE_COLORS: Record<string, string> = {
  Admin: 'var(--primary)',
  Editor: 'var(--violet)',
  Operator: 'var(--info)',
  Viewer: 'var(--neutral)',
};

function RoleBadge({ role }: { role: string }) {
  const color = ROLE_BADGE_COLORS[role] ?? 'var(--neutral)';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 8px',
        borderRadius: 20,
        border: '1px solid var(--border-2)',
        background: 'var(--card-2)',
        fontSize: 12,
        color: 'var(--muted-fg)',
        cursor: 'default',
        userSelect: 'none',
      }}
    >
      <span style={{ fontSize: 11, color: 'var(--faint-fg)' }}>Role</span>
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: '0.02em',
          color,
          textTransform: 'uppercase',
        }}
      >
        {role}
      </span>
    </span>
  );
}

export function Topbar() {
  const { user, logout } = useAuthStore();
  const { theme, toggleTheme } = useUiStore();
  const location = useLocation();
  const [logoutHovered, setLogoutHovered] = useState(false);

  const pageLabel = getPageLabel(location.pathname);

  const displayName = user
    ? (user.sub ?? '').replace(/^(federated:|svc:)/, '')
    : '';

  const avatarLetter = displayName.charAt(0).toUpperCase() || '?';

  return (
    <header
      style={{
        height: 56,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 24px',
        borderBottom: '1px solid var(--border)',
        background: 'color-mix(in srgb, var(--bg) 80%, transparent)',
        backdropFilter: 'blur(8px)',
        flexShrink: 0,
        position: 'sticky',
        top: 0,
        zIndex: 20,
      }}
    >
      {/* Left: breadcrumb */}
      <span
        style={{
          fontSize: 13,
          color: 'var(--muted-fg)',
          fontWeight: 500,
        }}
      >
        {pageLabel}
      </span>

      {/* Right: controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Role badge */}
        {user?.role && <RoleBadge role={user.role} />}

        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            borderRadius: 7,
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--muted-fg)',
            cursor: 'pointer',
          }}
        >
          {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
        </button>

        {/* Separator */}
        <div
          style={{
            width: 1,
            height: 24,
            background: 'var(--border)',
            flexShrink: 0,
          }}
        />

        {/* User info + avatar */}
        {user && (
          <>
            <div style={{ textAlign: 'right', lineHeight: 1.3 }}>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: 'var(--fg)',
                  maxWidth: 200,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {displayName}
              </div>
              <div
                style={{
                  fontSize: 10.5,
                  color: 'var(--faint-fg)',
                  marginTop: 1,
                }}
              >
                {user.role}
              </div>
            </div>

            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: '50%',
                background: 'color-mix(in srgb, var(--primary) 25%, var(--card-2))',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                fontWeight: 700,
                color: 'var(--primary)',
                flexShrink: 0,
                userSelect: 'none',
              }}
            >
              {avatarLetter}
            </div>
          </>
        )}

        {/* Logout */}
        <button
          onClick={logout}
          title="Sign out"
          onMouseEnter={() => setLogoutHovered(true)}
          onMouseLeave={() => setLogoutHovered(false)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            borderRadius: 7,
            border: '1px solid var(--border)',
            background: 'transparent',
            color: logoutHovered ? 'var(--error)' : 'var(--muted-fg)',
            cursor: 'pointer',
            transition: 'color 120ms ease, border-color 120ms ease',
            borderColor: logoutHovered ? 'var(--error)' : 'var(--border)',
          }}
        >
          <Power size={14} />
        </button>
      </div>
    </header>
  );
}
