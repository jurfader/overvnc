import { useState, type FormEvent } from 'react';
import { AlertCircle, ArrowLeft, LogIn, ShieldCheck } from 'lucide-react';
import { api, errorMessage } from '../api.ts';
import { Button } from '../components.tsx';

export function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api.login(username, password);
      if (r.mfaRequired) {
        setTicket(r.ticket);
        setCode('');
      } else onLogin();
    });
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      try {
        await api.loginMfa(ticket!, code);
        onLogin();
      } catch (err) {
        setCode('');
        // bilet wygasł lub wyczerpano próby — wróć do hasła
        if ((err as { code?: string }).code === 'ticket_expired') setTicket(null);
        throw err;
      }
    });
  };

  return (
    <div className="login-wrap">
      {!ticket ? (
        <form className="glass-card login anim-pop" onSubmit={submitPassword}>
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
      ) : (
        <form className="glass-card login anim-pop" onSubmit={submitCode} key="mfa">
          <div className="login-head">
            <div className="empty-icon" style={{ margin: 0 }}>
              <ShieldCheck />
            </div>
            <h1 style={{ fontSize: 20 }}>Weryfikacja dwuetapowa</h1>
            <p>{useRecovery ? 'Wpisz jeden z kodów zapasowych.' : 'Wpisz 6-cyfrowy kod z aplikacji uwierzytelniającej.'}</p>
          </div>
          {useRecovery ? (
            <input
              className="pole code-input"
              style={{ letterSpacing: '0.1em', fontSize: '18px' }}
              placeholder="xxxxx-xxxxx"
              autoComplete="off"
              value={code}
              onChange={(e) => setCode(e.target.value.trim())}
              autoFocus
              required
            />
          ) : (
            <input
              className="pole code-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '');
                setCode(v);
              }}
              autoFocus
              required
            />
          )}
          {error && (
            <div className="form-error">
              <AlertCircle /> {error}
            </div>
          )}
          <Button variant="primary" icon={ShieldCheck} loading={busy} disabled={useRecovery ? code.length < 10 : code.length !== 6}>
            Potwierdź
          </Button>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <button type="button" className="link-btn" onClick={() => (setTicket(null), setError(''))}>
              <ArrowLeft size={13} /> Wróć
            </button>
            <button type="button" className="link-btn" onClick={() => (setUseRecovery(!useRecovery), setCode(''), setError(''))}>
              {useRecovery ? 'Użyj kodu z aplikacji' : 'Nie mam telefonu — kod zapasowy'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
