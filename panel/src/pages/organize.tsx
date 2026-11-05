import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage, type Agent } from '../api.ts';
import { Button, Field, Modal, TagChip, toast } from '../components.tsx';
import { useMe, useOrg } from '../state.tsx';
import { plural } from '../format.ts';

/** Wybór klienta i lokalizacji (lokalizacje filtrowane do wybranego klienta). */
export function PlacementFields({
  clientId,
  siteId,
  onChange,
  allowNone,
}: {
  clientId: number | null;
  siteId: number | null;
  onChange: (clientId: number | null, siteId: number | null) => void;
  allowNone: boolean;
}) {
  const { clients } = useOrg();
  const sites = clients.find((c) => c.id === clientId)?.sites ?? [];
  // konto przypisane do jednego klienta (np. konto firmy) — wybieramy go od razu
  const only = !allowNone && clientId === null && clients.length === 1 ? clients[0].id : null;
  useEffect(() => {
    if (only !== null) onChange(only, null);
  }, [only]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="form-2">
      <Field label="Klient">
        <select className="pole" value={clientId ?? ''} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null, null)}>
          {allowNone && <option value="">— bez klienta —</option>}
          {!allowNone && clientId === null && <option value="">wybierz…</option>}
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Lokalizacja">
        <select className="pole" value={siteId ?? ''} disabled={!clientId || sites.length === 0} onChange={(e) => onChange(clientId, e.target.value ? Number(e.target.value) : null)}>
          <option value="">{clientId && sites.length === 0 ? 'brak lokalizacji' : '— dowolna —'}</option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

/** Przełączniki tagów (kliknięcie włącza/wyłącza). */
export function TagPicker({ value, onChange }: { value: number[]; onChange: (ids: number[]) => void }) {
  const { tags } = useOrg();
  if (tags.length === 0) return <span className="muted small">Brak tagów — dodasz je w zakładce Klienci → Tagi.</span>;
  return (
    <div className="tag-picker">
      {tags.map((t) => {
        const on = value.includes(t.id);
        return (
          <button
            key={t.id}
            type="button"
            className={`tag-toggle ${on ? 'on' : ''}`}
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== t.id) : [...value, t.id])}
          >
            <TagChip name={t.name} color={t.color} />
          </button>
        );
      })}
    </div>
  );
}

/** Edycja przypisania jednego komputera: nazwa, klient, lokalizacja, tagi, notatki. */
export function OrganizeModal({ agent, open, onClose }: { agent: Agent; open: boolean; onClose: () => void }) {
  const { me } = useMe();
  const [label, setLabel] = useState('');
  const [clientId, setClientId] = useState<number | null>(null);
  const [siteId, setSiteId] = useState<number | null>(null);
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setLabel(agent.label);
    setClientId(agent.clientId);
    setSiteId(agent.siteId);
    setTagIds(agent.tags.map((t) => t.id));
    setNotes(agent.notes);
    setError('');
    // tylko przy otwarciu: dane komputera odświeżają się na żywo (metryki co kilka sekund)
    // i nadpisywałyby to, co ktoś właśnie wpisuje
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agent.id]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.updateAgent(agent.id, { label: label.trim(), clientId, siteId, tagIds, notes });
      toast('Zapisano');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} wide>
      <form onSubmit={submit}>
        <h3>Edycja komputera</h3>
        <Field label="Własna nazwa" hint={`Pozostaw puste, aby używać nazwy hosta (${agent.hostname}).`}>
          <input className="pole" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={agent.hostname} maxLength={100} autoFocus />
        </Field>
        <PlacementFields clientId={clientId} siteId={siteId} allowNone={me.allClients} onChange={(c, s) => (setClientId(c), setSiteId(s))} />
        <Field label="Tagi" group>
          <TagPicker value={tagIds} onChange={setTagIds} />
        </Field>
        <Field label="Notatki" hint="Widoczne dla całego zespołu, np. lokalizacja w biurze, użytkownik, numer inwentarzowy.">
          <textarea className="pole" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} />
        </Field>
        {error && <div className="form-error">{error}</div>}
        <div className="okno-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            Anuluj
          </Button>
          <Button variant="primary" loading={busy}>
            Zapisz
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export type BulkMode = 'place' | 'addTags' | 'removeTags';

/** Operacja zbiorcza na zaznaczonych komputerach. */
export function BulkModal({ mode, ids, onClose, onDone }: { mode: BulkMode | null; ids: string[]; onClose: () => void; onDone: () => void }) {
  const { me } = useMe();
  const [clientId, setClientId] = useState<number | null>(null);
  const [siteId, setSiteId] = useState<number | null>(null);
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!mode) return;
    setClientId(null);
    setSiteId(null);
    setTagIds([]);
    setError('');
  }, [mode]);

  const title = mode === 'place' ? 'Przypisz do klienta' : mode === 'addTags' ? 'Dodaj tagi' : 'Usuń tagi';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mode !== 'place' && tagIds.length === 0) return setError('Wybierz co najmniej jeden tag.');
    if (mode === 'place' && clientId === null && !me.allClients) return setError('Wybierz klienta.');
    setBusy(true);
    setError('');
    try {
      const body =
        mode === 'place' ? { ids, clientId, siteId } : mode === 'addTags' ? { ids, addTagIds: tagIds } : { ids, removeTagIds: tagIds };
      const { updated } = await api.bulkUpdate(body);
      toast(`Zaktualizowano ${updated} ${plural(updated, 'komputer', 'komputery', 'komputerów')}`);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={!!mode} onClose={onClose} wide={mode === 'place'}>
      <form onSubmit={submit}>
        <h3>
          {title} <span className="muted">({ids.length})</span>
        </h3>
        {mode === 'place' ? (
          <PlacementFields clientId={clientId} siteId={siteId} allowNone={me.allClients} onChange={(c, s) => (setClientId(c), setSiteId(s))} />
        ) : (
          <TagPicker value={tagIds} onChange={setTagIds} />
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="okno-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            Anuluj
          </Button>
          <Button variant={mode === 'removeTags' ? 'danger' : 'primary'} loading={busy}>
            {title}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
