import { createBrowserRouter, Navigate } from 'react-router';
import { AuthLayout } from './routes/auth-layout';
import { LoginPage } from './routes/login';
import { AuthCallback } from './routes/auth-callback';
import { ShellLayout } from './routes/shell-layout';
import { DashboardPage } from './routes/dashboard';
import { SessionsPage } from './routes/sessions';
import { SessionDetailPage } from './routes/session-detail';
import { SessionViewerPage } from './routes/session-viewer';
import { AppsPage } from './routes/apps';
import { AppDetailPage } from './routes/app-detail';
import { AppNewPage } from './routes/app-new';
import { TemplatesPage } from './routes/templates';
import { TemplateDetailPage } from './routes/template-detail';
import { TemplateNewPage } from './routes/template-new';
import { ProfilesPage } from './routes/profiles';
import { ProfileDetailPage } from './routes/profile-detail';
import { TenantsPage } from './routes/tenants';
import { UsersPage } from './routes/users';
import { IdentityProvidersPage } from './routes/identity-providers';
import { AgentClientsPage } from './routes/agent-clients';

export const router = createBrowserRouter([
  {
    element: <AuthLayout />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/auth/callback', element: <AuthCallback /> },
    ],
  },
  {
    element: <ShellLayout />,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: '/dashboard', element: <DashboardPage /> },
      { path: '/sessions', element: <SessionsPage /> },
      { path: '/sessions/:id', element: <SessionDetailPage /> },
      { path: '/sessions/:id/viewer', element: <SessionViewerPage /> },
      { path: '/apps', element: <AppsPage /> },
      { path: '/apps/new', element: <AppNewPage /> },
      { path: '/apps/:id', element: <AppDetailPage /> },
      { path: '/templates', element: <TemplatesPage /> },
      { path: '/templates/new', element: <TemplateNewPage /> },
      { path: '/templates/:id', element: <TemplateDetailPage /> },
      { path: '/profiles', element: <ProfilesPage /> },
      { path: '/profiles/:id', element: <ProfileDetailPage /> },
      { path: '/tenants', element: <TenantsPage /> },
      { path: '/users', element: <UsersPage /> },
      { path: '/identity-providers', element: <IdentityProvidersPage /> },
      { path: '/agent-clients', element: <AgentClientsPage /> },
    ],
  },
]);
