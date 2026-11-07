import { useState } from 'react';
import { LogOut, Smartphone, Store } from 'lucide-react';
import { api, errorMessage, type Agent } from '../../api.ts';
import { Button, CardHead, toast } from '../../components.tsx';
import { useMe } from '../../state.tsx';

type Feature = 'phoneApp' | 'endButton';

const FEATURES: { key: Feature; icon: typeof Smartphone; title: string; on: string; off: string }[] = [
  {
    key: 'phoneApp',
    icon: Smartphone,
    title: 'Zdjęcia z telefonu',
    on: 'Gdy klient podłączy telefon kablem USB, otworzy się aplikacja — przegląda zdjęcia, kopiuje je do Pobranych i usuwa z telefonu. Kafelek jest też w menu Start.',
    off: 'Klient podłącza telefon (Android, iPhone) kablem USB i w prostej aplikacji kopiuje zdjęcia do Pobranych albo usuwa je z telefonu.',
  },
  {
    key: 'endButton',
    icon: LogOut,
    title: 'Przycisk „Zakończ i usuń moje dane”',
    on: 'Klient widzi przycisk w lewym dolnym rogu ekranu (i kafelek w Start). Po potwierdzeniu programy się zamykają, Pobrane są usuwane, a kiosk uruchamia się ponownie — UWF odrzuca wszystkie zmiany.',
    off: 'Klient sam kończy sesję jednym kliknięciem: zamknięcie programów i wylogowanie ze stron, usunięcie Pobranych i restart czyszczący (ok. 1–2 min).',
  },
];

/** Kiosk: funkcje dla klientów — włączenie dopisuje je do trybu kiosku (Assigned Access) i menu Start. */
export function KioskFeaturesCard({ agent }: { agent: Agent }) {
  const { can } = useMe();
  const [busy, setBusy] = useState<Feature | null>(null);
  const supported = !agent.online || agent.capabilities.includes('agent.profile');
  const toggle = async (f: Feature) => {
    setBusy(f);
    try {
      const r = await api.updateAgent(agent.id, { [f]: !agent[f] });
      const name = FEATURES.find((x) => x.key === f)!.title;
      const base = `${name}: ${r[f] ? 'włączone' : 'wyłączone'}`;
      toast(r.profileNote ? `${base}. ${r.profileNote}` : agent.online ? base : `${base} — kiosk zastosuje zmianę po połączeniu.`);
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="glass-card card anim-rise" style={{ animationDelay: '120ms' }}>
      <CardHead icon={Store} title="Funkcje kiosku" />
      <div className="kiosk-features">
        {FEATURES.map((f) => (
          <div key={f.key} className="kiosk-feature">
            <span className={`kiosk-feature-icon ${agent[f.key] ? 'on' : ''}`}>
              <f.icon />
            </span>
            <div className="kiosk-feature-body">
              <strong>{f.title}</strong>
              <div className="small muted">{agent[f.key] ? f.on : f.off}</div>
            </div>
            {can('agents.manage') && supported && (
              <Button size="sm" variant={agent[f.key] ? 'secondary' : 'primary'} loading={busy === f.key} disabled={busy !== null} onClick={() => toggle(f.key)}>
                {agent[f.key] ? 'Wyłącz' : 'Włącz'}
              </Button>
            )}
          </div>
        ))}
      </div>
      {!supported && <p className="small muted">Wymaga agenta w wersji 0.20.0 lub nowszej — zaktualizuj agenta.</p>}
      <p className="small muted" style={{ marginBottom: 0 }}>
        Zmiany w trybie kiosku działają po ponownym zalogowaniu klienta (np. restart kiosku). Przy włączonej ochronie przed zapisem (UWF) zmieniaj je w trybie serwisowym.
      </p>
    </section>
  );
}
