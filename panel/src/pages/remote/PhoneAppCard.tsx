import { useState } from 'react';
import { Smartphone } from 'lucide-react';
import { api, errorMessage, type Agent } from '../../api.ts';
import { Button, CardHead, toast } from '../../components.tsx';
import { useMe } from '../../state.tsx';

/** Kiosk: aplikacja „Zdjęcia z telefonu” — klient kopiuje zdjęcia z telefonu do Pobranych i usuwa je z telefonu. */
export function PhoneAppCard({ agent }: { agent: Agent }) {
  const { can } = useMe();
  const [busy, setBusy] = useState(false);
  const supported = !agent.online || agent.capabilities.includes('agent.profile');
  const toggle = async () => {
    setBusy(true);
    try {
      const r = await api.updateAgent(agent.id, { phoneApp: !agent.phoneApp });
      const base = r.phoneApp ? 'Aplikacja włączona' : 'Aplikacja wyłączona';
      toast(r.profileNote ? `${base}. ${r.profileNote}` : agent.online ? base : `${base} — kiosk zastosuje zmianę po połączeniu.`);
    } catch (e) {
      toast(errorMessage(e), 'err');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="glass-card card anim-rise" style={{ animationDelay: '120ms' }}>
      <CardHead icon={Smartphone} title="Zdjęcia z telefonu">
        {can('agents.manage') && supported && (
          <Button size="sm" variant={agent.phoneApp ? 'secondary' : 'primary'} loading={busy} onClick={toggle}>
            {agent.phoneApp ? 'Wyłącz' : 'Włącz'}
          </Button>
        )}
      </CardHead>
      <p className="small muted" style={{ margin: 0 }}>
        {agent.phoneApp
          ? 'Włączona: gdy klient podłączy telefon kablem USB, na ekranie kiosku otworzy się aplikacja — przegląda zdjęcia, kopiuje je do Pobranych i usuwa z telefonu. Kafelek „Zdjęcia z telefonu” jest też w menu Start.'
          : 'Klient podłącza telefon (Android, iPhone) kablem USB i w prostej aplikacji kopiuje zdjęcia do Pobranych albo usuwa je z telefonu. Włączenie dopisze aplikację do trybu kiosku i doda kafelek w menu Start.'}
        {!supported && ' Wymaga agenta w wersji 0.20.0 lub nowszej — zaktualizuj agenta.'}
      </p>
    </section>
  );
}
