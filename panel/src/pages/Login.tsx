import { useState, type FormEvent } from 'react';
import { AlertCircle, LogIn } from 'lucide-react';
import { api, ApiError } from '../api.ts';
import { Button } from '../components.tsx';

export function Login({ onLogin }: { onLogin: (user: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const u = await api.login(username, password);
      onLogin(u.username);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(status === 429 ? 'Zbyt wiele prób. Spróbuj za kilka minut.' : status === 401 ? 'Nieprawidłowy login lub hasło.' : 'Błąd połączenia z serwerem.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="glass-card login anim-pop" onSubmit={submit}>
        <div className="login-head">
          <img src="/logo.png" alt="" />
          <h1 className="gradient-text">OVERVNC</h1>
          <p>Panel zdalnego zarządzania komputerami</p>
        </div>
        <label className="field">
          Login
          <input className="pole" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
        </label>
        <label className="field">
          Hasło
          <input className="pole" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && (
          <div className="form-error">
            <AlertCircle /> {error}
          </div>
        )}
        <Button variant="primary" icon={LogIn} loading={busy}>
          Zaloguj się
        </Button>
        <div className="login-foot">OVERMEDIA</div>
      </form>
    </div>
  );
}
