import { useEffect, useState, type FormEvent } from 'react';
import { Building2, Check, MapPin, Pencil, Plus, Tag as TagIcon, Trash2, X } from 'lucide-react';
import { api, errorMessage, type Client, type ConsentMode, type Tag } from '../api.ts';
import { Button, ColorPicker, EmptyState, Field, Modal, PALETTE, TagChip, Tabs, toast } from '../components.tsx';
import { orgChanged, useMe, useOrg } from '../state.tsx';
import { plural } from '../format.ts';

type TabKey = 'clients' | 'tags';

const CONSENT_OPTIONS: { value: ConsentMode; label: string; hint: string }[] = [
  { value: 'notify', label: 'Z powiadomieniem', hint: 'Połączenie od razu, użytkownik widzi na ekranie informację, kto się łączy.' },
  { value: 'ask', label: 'Z pytaniem o zgodę', hint: 'Użytkownik musi kliknąć „Tak” (30 s). Dla komputerów biurowych.' },
  { value: 'none', label: 'Bez komunikatu', hint: 'Dla kiosków i komputerów bez obsługi — nic nie wyskakuje na ekranie.' },
];

/** Wspólne opakowanie: wykonaj, odśwież słowniki, pokaż błąd. */
async function mutate(fn: () => Promise<unknown>, okText?: string): Promise<boolean> {
  try {
    await fn();
    orgChanged();
    if (okText) toast(okText);
    return true;
  } catch (err) {
    toast(errorMessage(err), 'err');
    return false;
  }
}

export function Clients() {
  const { me, can } = useMe();
  const { clients, tags } = useOrg();
  const [tab, setTab] = useState<TabKey>('clients');
  const [editClient, setEditClient] = useState<Client | null | undefined>(undefined); // undefined = zamknięte, null = nowy
  const [editTag, setEditTag] = useState<Tag | null | undefined>(undefined);
  const [confirm, setConfirm] = useState<{ title: string; text: string; run: () => Promise<unknown> } | null>(null);
  const manage = can('clients.manage');
  const global = manage && me.allClients;

  return (
    <>
      <header className="page-head anim-rise">
        <div>
          <h1>Klienci</h1>
          <div className="sub">Firmy, ich lokalizacje i tagi porządkujące komputery</div>
        </div>
        <div className="toolbar">
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { value: 'clients', label: `Klienci (${clients.length})` },
              { value: 'tags', label: `Tagi (${tags.length})` },
            ]}
          />
          {global && tab === 'clients' && (
            <Button variant="primary" icon={Plus} onClick={() => setEditClient(null)}>
              Nowy klient
            </Button>
          )}
          {global && tab === 'tags' && (
            <Button variant="primary" icon={Plus} onClick={() => setEditTag(null)}>
              Nowy tag
            </Button>
          )}
        </div>
      </header>

      {tab === 'clients' &&
        (clients.length === 0 ? (
          <EmptyState icon={Building2} title="Brak klientów" text="Dodaj firmy, którym zarządzasz komputerami — potem przypiszesz do nich komputery i członków zespołu.">
            {global && (
              <Button variant="primary" icon={Plus} onClick={() => setEditClient(null)}>
                Dodaj pierwszego klienta
              </Button>
            )}
          </EmptyState>
        ) : (
          <div className="client-grid">
            {clients.map((c, i) => (
              <ClientCard
                key={c.id}
                client={c}
                delay={i * 30}
                manage={manage}
                canDelete={global}
                onEdit={() => setEditClient(c)}
                onDelete={() =>
                  setConfirm({
                    title: `Usunąć klienta „${c.name}”?`,
                    text: `${c.agentCount} ${plural(c.agentCount, 'komputer straci', 'komputery stracą', 'komputerów straci')} przypisanie do klienta, a lokalizacje zostaną usunięte. Komputery pozostaną w panelu.`,
                    run: () => api.deleteClient(c.id),
                  })
                }
                onDeleteSite={(siteId, name) =>
                  setConfirm({ title: `Usunąć lokalizację „${name}”?`, text: 'Komputery z tej lokalizacji pozostaną przypisane do klienta.', run: () => api.deleteSite(siteId) })
                }
              />
            ))}
          </div>
        ))}

      {tab === 'tags' &&
        (tags.length === 0 ? (
          <EmptyState icon={TagIcon} title="Brak tagów" text="Tagi to dowolne etykiety, np. „serwer”, „księgowość”, „VIP” — przydatne w filtrach i automatyzacji.">
            {global && (
              <Button variant="primary" icon={Plus} onClick={() => setEditTag(null)}>
                Dodaj pierwszy tag
              </Button>
            )}
          </EmptyState>
        ) : (
          <div className="glass-card table-card anim-rise">
            <table className="table hover">
              <thead>
                <tr>
                  <th>Tag</th>
                  <th>Komputery</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tags.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <TagChip name={t.name} color={t.color} />
                    </td>
                    <td className="ink-2">{t.agentCount}</td>
                    <td>
                      {global && (
                        <div className="menu-actions">
                          <Button size="sm" variant="ghost" icon={Pencil} title="Edytuj" onClick={() => setEditTag(t)} />
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={Trash2}
                            title="Usuń"
                            onClick={() => setConfirm({ title: `Usunąć tag „${t.name}”?`, text: `Tag zniknie z ${t.agentCount} ${plural(t.agentCount, 'komputera', 'komputerów', 'komputerów')}.`, run: () => api.deleteTag(t.id) })}
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      <ClientModal client={editClient} onClose={() => setEditClient(undefined)} />
      <TagModal tag={editTag} onClose={() => setEditTag(undefined)} />
      <Modal open={!!confirm} onClose={() => setConfirm(null)}>
        {confirm && (
          <>
            <h3>{confirm.title}</h3>
            <p>{confirm.text}</p>
            <div className="okno-actions">
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Anuluj
              </Button>
              <Button variant="danger" icon={Trash2} onClick={async () => (await mutate(confirm.run, 'Usunięto')) && setConfirm(null)}>
                Usuń
              </Button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}

function ClientCard({
  client: c,
  delay,
  manage,
  canDelete,
  onEdit,
  onDelete,
  onDeleteSite,
}: {
  client: Client;
  delay: number;
  manage: boolean;
  canDelete: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onDeleteSite: (id: number, name: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [newSite, setNewSite] = useState('');
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);

  const addSite = async (e: FormEvent) => {
    e.preventDefault();
    if (await mutate(() => api.createSite(c.id, newSite.trim()), 'Dodano lokalizację')) {
      setNewSite('');
      setAdding(false);
    }
  };
  const saveRename = async (e: FormEvent) => {
    e.preventDefault();
    if (renaming && (await mutate(() => api.updateSite(renaming.id, renaming.name.trim())))) setRenaming(null);
  };

  return (
    <div className="glass-card client-card anim-rise" style={{ animationDelay: `${delay}ms` }}>
      <div className="client-card-head">
        <span className="client-avatar" style={{ background: c.color || 'var(--gradient-brand)' }}>
          {c.name.slice(0, 2).toUpperCase()}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3>{c.name}</h3>
          <a className="small" href={`#/?client=${c.id}`}>
            {c.agentCount} {plural(c.agentCount, 'komputer', 'komputery', 'komputerów')} →
          </a>
        </div>
        {manage && (
          <div className="menu-actions">
            <Button size="sm" variant="ghost" icon={Pencil} title="Edytuj" onClick={onEdit} />
            {canDelete && <Button size="sm" variant="ghost" icon={Trash2} title="Usuń" onClick={onDelete} />}
          </div>
        )}
      </div>
      {c.notes && <div className="notes">{c.notes}</div>}

      <div>
        <div className="nav-group-title" style={{ padding: '0 8px', marginBottom: 4 }}>
          Lokalizacje
        </div>
        <div className="site-list">
          {c.sites.length === 0 && !adding && <div className="muted small" style={{ padding: '4px 8px' }}>Brak lokalizacji</div>}
          {c.sites.map((s) =>
            renaming?.id === s.id ? (
              <form key={s.id} className="add-inline" onSubmit={saveRename}>
                <input className="pole" value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} autoFocus required />
                <Button size="sm" variant="primary" icon={Check} title="Zapisz" />
                <Button size="sm" type="button" variant="ghost" icon={X} title="Anuluj" onClick={() => setRenaming(null)} />
              </form>
            ) : (
              <div key={s.id} className="site-row">
                <MapPin size={14} style={{ color: 'rgb(var(--faint))' }} />
                <span className="name">{s.name}</span>
                <span className="muted small">{s.agentCount}</span>
                {manage && (
                  <span className="actions">
                    <Button size="sm" variant="ghost" icon={Pencil} title="Zmień nazwę" onClick={() => setRenaming({ id: s.id, name: s.name })} />
                    <Button size="sm" variant="ghost" icon={Trash2} title="Usuń" onClick={() => onDeleteSite(s.id, s.name)} />
                  </span>
                )}
              </div>
            ),
          )}
          {adding && (
            <form className="add-inline" onSubmit={addSite}>
              <input className="pole" value={newSite} onChange={(e) => setNewSite(e.target.value)} placeholder="np. Biuro Kraków" autoFocus required />
              <Button size="sm" variant="primary" icon={Check} title="Dodaj" />
              <Button size="sm" type="button" variant="ghost" icon={X} title="Anuluj" onClick={() => setAdding(false)} />
            </form>
          )}
        </div>
        {manage && !adding && (
          <button className="link-btn" style={{ padding: '6px 8px' }} onClick={() => setAdding(true)}>
            <Plus size={13} /> Dodaj lokalizację
          </button>
        )}
      </div>
    </div>
  );
}

function ClientModal({ client, onClose }: { client: Client | null | undefined; onClose: () => void }) {
  const open = client !== undefined;
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [color, setColor] = useState(PALETTE[0]);
  const [consent, setConsent] = useState<ConsentMode>('notify');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(client?.name ?? '');
    setNotes(client?.notes ?? '');
    setColor(client?.color || PALETTE[0]);
    setConsent(client?.consentMode ?? 'notify');
  }, [open, client]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const body = { name: name.trim(), notes, color, consentMode: consent };
    const ok = await mutate(() => (client ? api.updateClient(client.id, body) : api.createClient(body)), client ? 'Zapisano' : 'Dodano klienta');
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal open={open} onClose={onClose} wide>
      <form onSubmit={submit}>
        <h3>{client ? 'Edycja klienta' : 'Nowy klient'}</h3>
        <Field label="Nazwa">
          <input className="pole" value={name} onChange={(e) => setName(e.target.value)} placeholder="np. Kowalski sp. z o.o." required autoFocus maxLength={100} />
        </Field>
        <Field label="Kolor">
          <ColorPicker value={color} onChange={setColor} />
        </Field>
        <Field label="Pulpit zdalny — zgoda użytkownika komputera">
          <div className="choice-list">
            {CONSENT_OPTIONS.map((o) => (
              <label key={o.value} className={`choice ${consent === o.value ? 'on' : ''}`}>
                <input type="radio" name="consent" checked={consent === o.value} onChange={() => setConsent(o.value)} />
                <span>
                  {o.label}
                  <small>{o.hint}</small>
                </span>
              </label>
            ))}
          </div>
        </Field>
        <Field label="Notatki" hint="Np. osoba kontaktowa, telefon, godziny pracy.">
          <textarea className="pole" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </Field>
        <div className="okno-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            Anuluj
          </Button>
          <Button variant="primary" loading={busy}>
            {client ? 'Zapisz' : 'Dodaj klienta'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function TagModal({ tag, onClose }: { tag: Tag | null | undefined; onClose: () => void }) {
  const open = tag !== undefined;
  const [name, setName] = useState('');
  const [color, setColor] = useState(PALETTE[2]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(tag?.name ?? '');
    setColor(tag?.color || PALETTE[2]);
  }, [open, tag]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await mutate(() => (tag ? api.updateTag(tag.id, { name: name.trim(), color }) : api.createTag(name.trim(), color)), tag ? 'Zapisano' : 'Dodano tag');
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal open={open} onClose={onClose}>
      <form onSubmit={submit}>
        <h3>{tag ? 'Edycja tagu' : 'Nowy tag'}</h3>
        <Field label="Nazwa">
          <input className="pole" value={name} onChange={(e) => setName(e.target.value)} placeholder="np. serwer" required autoFocus maxLength={40} />
        </Field>
        <Field label="Kolor">
          <ColorPicker value={color} onChange={setColor} />
        </Field>
        <div>
          Podgląd: <TagChip name={name || 'tag'} color={color} />
        </div>
        <div className="okno-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            Anuluj
          </Button>
          <Button variant="primary" loading={busy}>
            {tag ? 'Zapisz' : 'Dodaj tag'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
