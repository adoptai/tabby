import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useAuthStore } from '@/stores/auth';
import { authApi, type OAuthProvider } from '@/api/auth';
import { env } from '@/env';

export function LoginPage() {
  const navigate = useNavigate();
  const { token, setToken } = useAuthStore();

  const [providers, setProviders] = useState<OAuthProvider[]>([]);
  const [email, setEmail] = useState('admin@browser-hitl.local');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showEmailForm, setShowEmailForm] = useState(false);

  useEffect(() => {
    if (token) navigate('/dashboard', { replace: true });
  }, [token, navigate]);

  useEffect(() => {
    authApi
      .listOAuthProviders()
      .then((list) => {
        setProviders(list);
        // Auto-expand email form when no OAuth options are available
        if (list.length === 0) setShowEmailForm(true);
      })
      .catch(() => {
        setShowEmailForm(true);
      });
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await authApi.login({ email, password });
      setToken(res.token);
      navigate('/dashboard', { replace: true });
    } catch {
      setError('Invalid credentials');
    } finally {
      setLoading(false);
    }
  };

  const handleOAuth = (idpId: string) => {
    const callbackUrl = `${window.location.origin}/auth/callback`;
    window.location.href = `${env.apiUrl()}/auth/oauth/${idpId}/login?redirect_uri=${encodeURIComponent(callbackUrl)}`;
  };

  return (
    <>
      {/* Full-page radial gradient overlay */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background:
            'radial-gradient(1200px 600px at 50% -10%, color-mix(in srgb, var(--primary) 10%, transparent), transparent)',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />

      {/* Content */}
      <div style={{ position: 'relative', zIndex: 1, width: '100%' }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 10,
              marginBottom: 8,
            }}
          >
            <div
              style={{
                width: 30,
                height: 30,
                background: 'var(--primary)',
                borderRadius: 8,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontSize: 14,
                fontWeight: 800,
              }}
            >
              T
            </div>
            <span
              style={{
                fontSize: 22,
                fontWeight: 800,
                letterSpacing: '-0.02em',
                color: 'var(--fg)',
              }}
            >
              Tabby
            </span>
          </div>
          <p
            style={{
              fontSize: 12.5,
              color: 'var(--muted-fg)',
              margin: 0,
            }}
          >
            Browser HITL control plane · sign in to continue
          </p>
        </div>

        {/* Card */}
        <div
          style={{
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          {/* OAuth buttons */}
          {providers.map((p) => (
            <button
              key={p.id}
              onClick={() => handleOAuth(p.id)}
              style={{
                width: '100%',
                height: 40,
                background: 'var(--card-2)',
                border: '1px solid var(--border-2)',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--fg)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'background 120ms ease',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = 'var(--muted)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = 'var(--card-2)';
              }}
            >
              Sign in with {p.name}
            </button>
          ))}

          {/* "or" divider */}
          {providers.length > 0 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                margin: '2px 0',
              }}
            >
              <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
              <span style={{ fontSize: 11, color: 'var(--faint-fg)' }}>or</span>
              <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            </div>
          )}

          {/* Email form toggle */}
          {providers.length > 0 && (
            <button
              onClick={() => setShowEmailForm((v) => !v)}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                fontSize: 12,
                color: 'var(--muted-fg)',
                padding: '2px 0',
                textAlign: 'center',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
              }}
            >
              <span>{showEmailForm ? '▾' : '▸'}</span>
              Sign in with email &amp; password
            </button>
          )}

          {/* Email + password form */}
          {showEmailForm && (
            <form
              onSubmit={handleLogin}
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <div>
                <label
                  style={{
                    display: 'block',
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: 'var(--muted-fg)',
                    marginBottom: 5,
                  }}
                >
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={{
                    width: '100%',
                    height: 36,
                    background: 'var(--card-2)',
                    border: '1px solid var(--border-2)',
                    borderRadius: 8,
                    padding: '0 10px',
                    fontSize: 13,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                    color: 'var(--fg)',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label
                  style={{
                    display: 'block',
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: 'var(--muted-fg)',
                    marginBottom: 5,
                  }}
                >
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••"
                  style={{
                    width: '100%',
                    height: 36,
                    background: 'var(--card-2)',
                    border: '1px solid var(--border-2)',
                    borderRadius: 8,
                    padding: '0 10px',
                    fontSize: 13,
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                    color: 'var(--fg)',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              {error && (
                <p
                  style={{
                    margin: 0,
                    fontSize: 12,
                    color: 'var(--error)',
                  }}
                >
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={loading}
                style={{
                  width: '100%',
                  height: 38,
                  background: 'var(--primary)',
                  border: 'none',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--primary-fg)',
                  cursor: loading ? 'not-allowed' : 'pointer',
                  opacity: loading ? 0.6 : 1,
                  transition: 'opacity 120ms ease',
                  marginTop: 2,
                }}
              >
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          )}
        </div>

        {/* Below-card hint */}
        <p
          style={{
            textAlign: 'center',
            fontSize: 11,
            color: 'var(--faint-fg)',
            marginTop: 16,
            marginBottom: 0,
          }}
        >
          admin@browser-hitl.local · local development
        </p>
      </div>
    </>
  );
}
