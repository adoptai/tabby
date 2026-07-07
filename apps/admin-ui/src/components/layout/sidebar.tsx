import { useState } from 'react';
import { NavLink } from 'react-router';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { useQuery } from '@tanstack/react-query';
import { sessionsApi } from '@/api/sessions';
import {
  LayoutDashboard,
  Monitor,
  AppWindow,
  FileCode2,
  Layers,
  Building2,
  Users,
  Shield,
  KeyRound,
} from 'lucide-react';

interface NavItem {
  label: string;
  to: string;
  icon: React.ElementType;
  roles?: string[];
  showBadge?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard },
  { label: 'Sessions', to: '/sessions', icon: Monitor, showBadge: true },
  { label: 'Applications', to: '/apps', icon: AppWindow, roles: ['Admin', 'Editor', 'Operator'] },
  { label: 'App Templates', to: '/templates', icon: FileCode2, roles: ['Admin', 'Editor', 'Operator'] },
  { label: 'Profiles', to: '/profiles', icon: Layers },
  { label: 'Tenants', to: '/tenants', icon: Building2, roles: ['Admin'] },
  { label: 'Users', to: '/users', icon: Users, roles: ['Admin'] },
  { label: 'Identity Providers', to: '/identity-providers', icon: Shield, roles: ['Admin'] },
  { label: 'Agent Clients', to: '/agent-clients', icon: KeyRound, roles: ['Admin'] },
];

interface NavItemProps {
  item: NavItem;
  collapsed: boolean;
  sessionCount: number;
}

function SidebarNavItem({ item, collapsed, sessionCount }: NavItemProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <NavLink
      to={item.to}
      style={({ isActive }) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        height: 34,
        padding: collapsed ? '0 8px' : '0 10px',
        borderRadius: 8,
        textDecoration: 'none',
        fontSize: 13,
        fontWeight: isActive ? 600 : 400,
        justifyContent: collapsed ? 'center' : 'flex-start',
        transition: 'background 120ms ease, color 120ms ease',
        background: isActive
          ? 'color-mix(in srgb, var(--primary) 18%, transparent)'
          : hovered
          ? 'var(--card-2)'
          : 'transparent',
        color: isActive ? 'var(--primary)' : hovered ? 'var(--fg)' : 'var(--muted-fg)',
      })}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <item.icon size={18} style={{ flexShrink: 0 }} />
      {!collapsed && (
        <>
          <span
            style={{
              flex: 1,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {item.label}
          </span>
          {item.showBadge && sessionCount > 0 && (
            <span
              style={{
                background: 'var(--primary)',
                color: 'var(--primary-fg)',
                fontSize: 10,
                fontWeight: 700,
                lineHeight: 1,
                padding: '2px 6px',
                borderRadius: 20,
                minWidth: 18,
                textAlign: 'center',
              }}
            >
              {sessionCount > 999 ? '999+' : sessionCount}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

export function Sidebar() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggle = useUiStore((s) => s.toggleSidebar);
  const role = useAuthStore((s) => s.user?.role);

  const { data: sessionsData } = useQuery({
    queryKey: ['sessions-count'],
    queryFn: () => sessionsApi.list({ limit: 1 }),
    refetchInterval: 30_000,
  });

  const sessionCount = sessionsData?.total ?? 0;

  const visible = NAV_ITEMS.filter(
    (item) => !item.roles || (role && item.roles.includes(role)),
  );

  return (
    <aside
      style={{
        width: collapsed ? 64 : 240,
        transition: 'width 200ms ease',
        position: 'fixed',
        top: 0,
        left: 0,
        bottom: 0,
        zIndex: 30,
        display: 'flex',
        flexDirection: 'column',
        borderRight: '1px solid var(--border)',
        background: 'var(--card)',
      }}
    >
      {/* Header */}
      <div
        style={{
          height: 56,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 10px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <div
            style={{
              width: 26,
              height: 26,
              background: 'var(--primary)',
              borderRadius: 7,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontSize: 13,
              fontWeight: 800,
              flexShrink: 0,
            }}
          >
            T
          </div>
          {!collapsed && (
            <span
              style={{
                fontSize: 15,
                fontWeight: 800,
                letterSpacing: '-0.02em',
                color: 'var(--fg)',
                whiteSpace: 'nowrap',
              }}
            >
              Tabby
            </span>
          )}
        </div>

        <button
          onClick={toggle}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--muted-fg)',
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 700,
            flexShrink: 0,
            lineHeight: 1,
          }}
        >
          {collapsed ? '»' : '«'}
        </button>
      </div>

      {/* Nav */}
      <nav
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        {visible.map((item) => (
          <SidebarNavItem
            key={item.to}
            item={item}
            collapsed={collapsed}
            sessionCount={sessionCount}
          />
        ))}
      </nav>

      {/* Environment indicator */}
      <div
        style={{
          padding: collapsed ? '12px 0' : '11px 14px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: collapsed ? 'center' : 'flex-start',
          gap: 8,
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: 'var(--success)',
            flexShrink: 0,
            boxShadow: '0 0 6px var(--success)',
          }}
        />
        {!collapsed && (
          <span style={{ fontSize: 11, color: 'var(--muted-fg)', letterSpacing: '0.01em' }}>
            api · us-east-1
          </span>
        )}
      </div>
    </aside>
  );
}
