import { useCallback, useEffect, useState } from 'react';
import { api, type Endpoint, type User } from './api.js';
import { AuthForm } from './AuthForm.js';
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

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    onLogout();
  }

  return (
    <div className="layout">
      <aside>
        <header>
          <strong>Webhook Inspector</strong>
          <div className="muted">{user.email}</div>
          <button className="link" onClick={logout}>
            Log out
          </button>
        </header>
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
          <button type="submit">New endpoint</button>
        </form>
        <ul className="endpoint-list">
          {endpoints.map((ep) => (
            <li
              key={ep.id}
              className={selected?.id === ep.id ? 'active' : ''}
              onClick={() => setSelected(ep)}
            >
              <div>{ep.name ?? ep.slug}</div>
              <div className="muted">
                {ep.slug} · {ep.request_count} req
              </div>
            </li>
          ))}
        </ul>
      </aside>
      <main>
        {selected ? (
          <RequestView endpoint={selected} />
        ) : (
          <p className="muted">Create an endpoint to get your webhook URL.</p>
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
