import { Outlet } from 'react-router';

export function AuthLayout() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-md p-6">
        <Outlet />
      </div>
    </div>
  );
}
