import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertCircle, KeyRound, ShieldCheck } from 'lucide-react';
import { renderSVG } from 'uqr';
import { api, errorMessage } from '../api.ts';
import { Button, Field, SecretBox } from '../components.tsx';

const MIN_PASSWORD = 10;

/** Wskaźnik siły hasła: długość + różnorodność znaków. */
function strength(pw: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (pw.length < MIN_PASSWORD) return { score: 0, label: `min. ${MIN_PASSWORD} znaków` };
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z0-9]/].filter((r) => r.test(pw)).length;
  if (pw.length >= 16 && kinds >= 3) return { score: 3, label: 'silne' };
  if (pw.length >= 12 || kinds >= 3) return { score: 2, label: 'dobre' };
  return { score: 1, label: 'słabe' };
}

export function PasswordForm({ onDone, submitLabel = 'Zmień hasło' }: { onDone: () => void; submitLabel?: string }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const st = strength(next);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (next !== repeat) return setError('Hasła nie są takie same.');
    if (next.length < MIN_PASSWORD) return setError(`Hasło musi mieć co najmniej ${MIN_PASSWORD} znaków.`);
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setRepeat('');
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form-grid" onSubmit={submit}>
      <Field label="Obecne hasło">
        <input className="pole" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </Field>
      <div className="form-2">
        <Field label="Nowe hasło" hint={next && <span className={`pw-strength s${st.score}`}>Siła: {st.label}</span>}>
          <input className="pole" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />
        </Field>
        <Field label="Powtórz nowe hasło">
          <input className="pole" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
        </Field>
      </div>
      {error && (
        <div className="form-error">
          <AlertCircle /> {error}
        </div>
      )}
      <div>
        <Button variant="primary" icon={KeyRound} loading={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

/**
 * Konfiguracja 2FA: kod QR -> potwierdzenie kodem -> kody zapasowe.
 * `onDone` wywoływane dopiero po zapisaniu kodów zapasowych przez użytkownika.
 */
export function MfaSetupFlow({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.mfaSetup().then(setSetup, (err) => setError(errorMessage(err)));
  }, []);

  // QR generowany lokalnie — sekret nie opuszcza przeglądarki
  const qr = useMemo(() => (setup ? renderSVG(setup.otpauthUrl, { border: 0, ecc: 'M' }) : ''), [setup]);

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setCodes((await api.mfaEnable(code)).recoveryCodes);
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  if (codes) {
    return (
      <div className="form-grid">
        <div className="callout callout-brand">
          <ShieldCheck />
          <span>
            Weryfikacja dwuetapowa jest włączona. Zapisz <strong>kody zapasowe</strong> w bezpiecznym miejscu (np. menedżer haseł). Każdy działa
            raz i pozwala zalogować się bez telefonu. Nie zobaczysz ich ponownie.
          </span>
        </div>
        <SecretBox lines={codes} filename="overvnc-kody-zapasowe.txt" />
        <label className="check">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> Kody zapasowe są bezpiecznie zapisane
        </label>
        <div>
          <Button variant="primary" disabled={!saved} onClick={onDone}>
            Gotowe
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form className="form-grid" onSubmit={confirm}>
      <div className="mfa-setup">
        <div className="qr" aria-label="Kod QR do aplikacji uwierzytelniającej" dangerouslySetInnerHTML={{ __html: qr }} />
        <div className="form-grid" style={{ gap: 12 }}>
          <ol className="steps">
            <li>Zainstaluj aplikację uwierzytelniającą (Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden).</li>
            <li>Zeskanuj kod QR.</li>
            <li>Wpisz 6-cyfrowy kod z aplikacji.</li>
          </ol>
          {setup && (
            <div className="small muted">
              Nie możesz zeskanować? Wpisz klucz ręcznie:
              <div className="mono" style={{ color: 'rgb(var(--ink))', marginTop: 4, wordBreak: 'break-all' }}>
                {setup.secret.match(/.{1,4}/g)?.join(' ')}
              </div>
            </div>
          )}
        </div>
      </div>
      <Field label="Kod z aplikacji">
        <input
          className="pole code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="000000"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          required
          autoFocus
        />
      </Field>
      {error && (
        <div className="form-error">
          <AlertCircle /> {error}
        </div>
      )}
      <div className="toolbar">
        <Button variant="primary" icon={ShieldCheck} loading={busy} disabled={code.length !== 6 || !setup}>
          Włącz weryfikację dwuetapową
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Anuluj
          </Button>
        )}
      </div>
    </form>
  );
}
