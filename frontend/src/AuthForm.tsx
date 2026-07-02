import { useEffect, useState } from 'react';
import { api, ApiError, type User } from './api.js';

export function AuthForm({ onLogin }: { onLogin: (user: User) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [githubEnabled, setGithubEnabled] = useState(false);

  useEffect(() => {
    api<{ github: boolean }>('/api/auth/providers').then(
      (p) => setGithubEnabled(p.github),
      () => setGithubEnabled(false),
    );
  }, []);

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const user = await api<User>(`/api/auth/${mode}`, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      onLogin(user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-card">
      <h1>Webhook Inspector</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          type="email"
          placeholder="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="password (min 8 chars)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
        />
        <button type="submit" disabled={busy}>
          {mode === 'login' ? 'Log in' : 'Create account'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {githubEnabled && (
        <a className="github-btn" href="/api/auth/github">
          Continue with GitHub
        </a>
      )}
      <button
        className="link"
        onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
      >
        {mode === 'login'
          ? 'No account? Register'
          : 'Have an account? Log in'}
      </button>
    </div>
  );
}
