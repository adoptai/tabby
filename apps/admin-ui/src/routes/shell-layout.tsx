import { useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router';
import { useAuthStore } from '@/stores/auth';
import { useUiStore } from '@/stores/ui';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { ErrorBoundary } from '@/components/shared/error-boundary';

export function ShellLayout() {
  const token = useAuthStore((s) => s.token);
  const navigate = useNavigate();
  const location = useLocation();
  const collapsed = useUiStore((s) => s.sidebarCollapsed);

  useEffect(() => {
    if (!token) navigate('/login', { replace: true });
  }, [token, navigate]);

  if (!token) return null;

  const sidebarWidth = collapsed ? 64 : 240;
  const isViewerPage = location.pathname.includes('/viewer');

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar />

      <div
        style={{
          marginLeft: sidebarWidth,
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          height: '100vh',
          overflow: 'hidden',
          transition: 'margin-left 200ms ease',
        }}
      >
        <Topbar />

        <main style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
          <ErrorBoundary>
            {isViewerPage ? (
              <Outlet />
            ) : (
              <div
                style={{
                  maxWidth: 1200,
                  margin: '0 auto',
                  padding: '26px 30px 60px',
                }}
              >
                <Outlet />
              </div>
            )}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
