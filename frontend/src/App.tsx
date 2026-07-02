import { useCallback, useEffect, useState } from 'react';
import { api, type Endpoint, type User } from './api.js';
import { AuthForm } from './AuthForm.js';
import { Logo } from './Logo.js';
import { RequestView } from './RequestView.js';

function Dashboard({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [selected, setSelected] = useState<Endpoint | null>(null);
  const [newName, setNewName] = useState('');

  const refresh = useCallback(async () => {
    const list = await api<Endpoint[]>('/api/endpoints');
    setEndpoints(list);
    return list;
  }, []);

  useEffect(() => {
    refresh().then((list) => setSelected(list[0] ?? null));
  }, [refresh]);

  async function createEndpoint() {
    const created = await api<Endpoint>('/api/endpoints', {
      method: 'POST',
      body: JSON.stringify({ name: newName || undefined }),
    });
    setNewName('');
    const list = await refresh();
    setSelected(list.find((ep) => ep.id === created.id) ?? null);
  }

  // Keeps the sidebar count badges in step with what RequestView shows live.
  const bumpCount = useCallback((endpointId: string) => {
    setEndpoints((prev) =>
      prev.map((ep) =>
        ep.id === endpointId
          ? { ...ep, request_count: ep.request_count + 1 }
          : ep,
      ),
    );
  }, []);

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    onLogout();
  }

  return (
    <div className="layout">
      <aside>
        <div className="brand">
          <Logo />
          Webhook Inspector
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void createEndpoint();
          }}
          className="new-endpoint"
        >
          <input
            placeholder="endpoint name (optional)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={100}
          />
          <button type="submit" className="primary">
            New endpoint
          </button>
        </form>
        <ul className="endpoint-list">
          {endpoints.map((ep) => (
            <li
              key={ep.id}
              className={selected?.id === ep.id ? 'active' : ''}
              onClick={() => setSelected(ep)}
            >
              <div className="endpoint-name">{ep.name ?? ep.slug}</div>
              <div className="endpoint-meta">
                <span className="endpoint-slug">{ep.slug}</span>
                <span className="count-badge">{ep.request_count}</span>
              </div>
            </li>
          ))}
        </ul>
        <div className="sidebar-footer">
          <span className="email" title={user.email}>
            {user.email}
          </span>
          <button className="link" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </aside>
      <main>
        {selected ? (
          <RequestView endpoint={selected} onRequest={bumpCount} />
        ) : (
          <div className="hero-empty">
            <Logo size={44} />
            <h2>No endpoints yet</h2>
            <p className="muted">
              Create an endpoint to get a unique URL that captures every
              request sent to it — live.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}

export function App() {
  const [user, setUser] = useState<User | null | 'loading'>('loading');

  useEffect(() => {
    api<User>('/api/auth/me').then(setUser, () => setUser(null));
  }, []);

  if (user === 'loading') return null;
  if (!user) return <AuthForm onLogin={setUser} />;
  return <Dashboard user={user} onLogout={() => setUser(null)} />;
}
