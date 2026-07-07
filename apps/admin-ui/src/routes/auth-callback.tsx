import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useAuthStore } from '@/stores/auth';

export function AuthCallback() {
  const navigate = useNavigate();
  const setToken = useAuthStore((s) => s.setToken);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('_token');
    if (token) {
      setToken(token);
      navigate('/dashboard', { replace: true });
    } else {
      navigate('/login', { replace: true });
    }
  }, [navigate, setToken]);

  return <p className="text-center text-muted-foreground">Authenticating...</p>;
}
