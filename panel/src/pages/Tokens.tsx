import { useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, Check, Copy, KeyRound, Laptop, Monitor, PlusCircle, ShieldCheck, Terminal, Trash2 } from 'lucide-react';
import { api, errorMessage, type EnrollToken } from '../api.ts';
import { Badge, Button, CardHead, ClientLabel, toast } from '../components.tsx';
import { useMe } from '../state.tsx';
import { PlacementFields } from './organize.tsx';
import { dateTime } from '../format.ts';

/** Ważność tokenu — w godzinach, jak oczekuje serwer (maks. rok). */
const TTL_OPTIONS = [
  { hours: 1, label: '1 godzinę' },
  { hours: 8, label: '8 godzin' },
  { hours: 24, label: '1 dzień' },
  { hours: 24 * 7, label: '7 dni' },
  { hours: 24 * 30, label: '30 dni' },
  { hours: 24 * 90, label: '90 dni' },
  { hours: 24 * 365, label: '1 rok' },
];

export function Tokens() {
  const [tokens, setTokens] = useState<EnrollToken[]>([]);
  const [label, setLabel] = useState('');
  const [ttl, setTtl] = useState(24);
  const [maxUses, setMaxUses] = useState('1');
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clientId, setClientId] = useState<number | null>(null);
  const [siteId, setSiteId] = useState<number | null>(null);
  const { me } = useMe();

  const load = () => api.tokens().then(setTokens, () => {});
  useEffect(() => {
    load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.createToken({ label, ttlHours: ttl, maxUses: maxUses.trim() === '' ? null : Number(maxUses), clientId, siteId });
      setCreated(r.token);
      setLabel('');
      load();
    } catch (err) {
      toast(errorMessage(err, 'Nie udało się utworzyć tokenu'), 'err');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (t: EnrollToken) => {
    await api.deleteToken(t.id);
    toast(`Usunięto token „${t.label}”`);
    load();
  };

  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const insecure = location.protocol === 'http:' && !isLocal ? ' --insecure' : '';
  // w trybie dev (vite :5173) agent i tak łączy się z serwerem na :8080
  const server = location.port === '5173' ? location.origin.replace(':5173', ':8080') : location.origin;
  const args = created ? `install --server ${server} --token ${created}${insecure}` : '';

  return (
    <>
      <header className="page-head anim-rise">
        <div>
          <h1>Dodaj komputer</h1>
          <div className="sub">Utwórz token rejestracji i zainstaluj agenta OVERVNC na komputerze</div>
        </div>
      </header>

      <section className="glass-card card anim-rise" style={{ animationDelay: '40ms' }}>
        <CardHead icon={KeyRound} title="1. Utwórz token rejestracji" />
        <form className="form-row" onSubmit={create}>
          <label className="field">
            Opis
            <input className="pole" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="np. Biuro Kraków — recepcja" />
          </label>
          <label className="field">
            Ważny przez
            <select className="pole" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
              {TTL_OPTIONS.map((o) => (
                <option key={o.hours} value={o.hours}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Liczba użyć
            <input className="pole" type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="bez limitu" />
          </label>
          <Button variant="primary" icon={PlusCircle} loading={busy}>
            Utwórz token
          </Button>
        </form>
        <div style={{ marginTop: 14 }}>
          <PlacementFields clientId={clientId} siteId={siteId} allowNone={me.allClients} onChange={(c, s) => (setClientId(c), setSiteId(s))} />
          <div className="field-hint" style={{ marginTop: 6 }}>
            Komputery zarejestrowane tym tokenem trafią od razu do wybranego klienta i lokalizacji.
          </div>
        </div>
        <div className="callout callout-brand" style={{ marginTop: 16 }}>
          <ShieldCheck />
          <span>
            Token służy tylko do pierwszej rejestracji. Każdy komputer dostaje potem własny, osobny klucz, więc token można bezpiecznie usunąć po
            instalacji.
          </span>
        </div>
      </section>

      {created && (
        <section className="glass-card card highlight anim-pop" style={{ display: 'grid', gap: 16 }}>
          <CardHead icon={Terminal} title="2. Zainstaluj agenta na komputerze" />
          <p className="ink-2" style={{ margin: 0 }}>
            Token jest widoczny <strong>tylko teraz</strong>. Wklej polecenie na komputerze — pobierze najnowszego agenta dla jego systemu, sprawdzi sumę kontrolną,
            zainstaluje usługę uruchamianą razem z systemem i zarejestruje komputer. Ponowne uruchomienie na tym samym komputerze tylko zaktualizuje agenta.
          </p>
          <Cmd icon={Monitor} title="Windows — PowerShell jako Administrator" cmd={`$env:OVERVNC_TOKEN='${created}'; irm ${server}/install.ps1 | iex`} />
          <Cmd icon={Laptop} title="macOS / Linux — terminal" cmd={`curl -fsSL ${server}/install.sh | sudo OVERVNC_TOKEN='${created}' sh`} />
          <p className="small muted" style={{ margin: 0 }}>
            Na Macu instalator przeprowadzi przez jednorazowe zgody systemu (nagrywanie ekranu, sterowanie, pliki): otworzy właściwe ustawienia i Findera z plikiem agenta —
            wystarczy przeciągnąć go na listę. Zgód nie da się nadać poleceniem (Apple na to nie pozwala); przetrwają aktualizacje agenta.
          </p>
          <details className="manual-install">
            <summary>Ręcznie — z pobranym plikiem agenta (np. komputer bez dostępu do serwera przy instalacji)</summary>
            <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
              <Cmd icon={Monitor} title="Windows — w katalogu z overvnc-agent.exe" cmd={`.\\overvnc-agent.exe ${args}`} />
              <Cmd icon={Laptop} title="macOS / Linux — w katalogu z overvnc-agent" cmd={`sudo ./overvnc-agent ${args}`} />
            </div>
          </details>
          {insecure && (
            <div className="callout callout-warning">
              <AlertTriangle /> Połączenie bez HTTPS. Używaj tylko do testów w sieci lokalnej.
            </div>
          )}
        </section>
      )}

      <section className="glass-card table-card anim-rise" style={{ animationDelay: '80ms' }}>
        <div className="card" style={{ paddingBottom: 0 }}>
          <CardHead icon={KeyRound} title="Tokeny" />
        </div>
        <div className="table-scroll">
          <table className="table hover stack">
            <thead>
              <tr>
                <th>Opis</th>
                <th>Klient</th>
                <th>Status</th>
                <th>Pozostało użyć</th>
                <th>Wygasa</th>
                <th>Utworzył</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => {
                const expired = t.expiresAt < Date.now();
                const used = t.usesLeft === 0;
                return (
                  <tr key={t.id}>
                    <td className="strong s-main">{t.label}</td>
                    <td className="s-full">
                      <ClientLabel name={t.clientName} site={t.siteName} />
                    </td>
                    <td className="s-meta">{expired ? <Badge>Wygasł</Badge> : used ? <Badge>Wykorzystany</Badge> : <Badge variant="success">Aktywny</Badge>}</td>
                    <td className="s-meta" data-label="Użyć:">{t.usesLeft ?? '∞'}</td>
                    <td className="small ink-2 s-meta" data-label="Wygasa:">{dateTime(t.expiresAt)}</td>
                    <td className="small ink-2 s-meta" data-label="Autor:">{t.createdBy ?? '—'}</td>
                    <td className="right s-end">
                      <Button size="sm" variant="ghost" icon={Trash2} onClick={() => remove(t)} title="Usuń token" />
                    </td>
                  </tr>
                );
              })}
              {tokens.length === 0 && (
                <tr>
                  <td colSpan={7} className="center-text">
                    Brak tokenów.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Cmd({ icon: Icon, title, cmd }: { icon: typeof Monitor; title: string; cmd: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast('Nie udało się skopiować — zaznacz polecenie ręcznie', 'err');
    }
  };
  return (
    <div className="cmd">
      <div className="cmd-title">
        <Icon /> {title}
      </div>
      <div className="cmd-row">
        <code>{cmd}</code>
        <Button size="sm" variant={copied ? 'outline' : 'secondary'} icon={copied ? Check : Copy} onClick={copy}>
          {copied ? 'Skopiowano' : 'Kopiuj'}
        </Button>
      </div>
    </div>
  );
}
