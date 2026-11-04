import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import {
  ArrowUp,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderPlus,
  HardDrive,
  Link2,
  Pencil,
  Plug,
  RefreshCw,
  Search,
  Star,
  Trash2,
  Upload,
  X,
  type LucideIcon,
  FolderOpen,
  MoreHorizontal,
} from 'lucide-react';
import { api, errorMessage, type Agent, type DirListing, type FileEntry, type FsRoot } from '../../api.ts';
import { Button, Checkbox, Dropdown, EmptyState, Field, Modal, toast } from '../../components.tsx';
import { bytes, dateTime, plural } from '../../format.ts';
import { useUploads } from './useUploads.ts';
import { TextEditorModal } from './TextEditorModal.tsx';

const TEXT_EXT = /\.(txt|log|ini|conf|cfg|config|json|ya?ml|xml|md|csv|sh|bash|zsh|ps1|bat|cmd|reg|env|properties|toml|service|plist|hosts|js|ts|py|php|html?|css|sql)$/i;

function iconFor(e: FileEntry): LucideIcon {
  if (e.type === 'dir') return Folder;
  if (e.link) return Link2;
  const ext = e.name.split('.').pop()?.toLowerCase() ?? '';
  if (/^(png|jpe?g|gif|webp|bmp|svg|heic|ico|tiff?)$/.test(ext)) return FileImage;
  if (/^(zip|rar|7z|tar|gz|tgz|bz2|xz|iso|dmg)$/.test(ext)) return FileArchive;
  if (/^(mp4|mov|avi|mkv|webm|wmv)$/.test(ext)) return FileVideo;
  if (/^(mp3|wav|flac|ogg|m4a|aac)$/.test(ext)) return FileAudio;
  if (/^(xlsx?|ods|csv|numbers)$/.test(ext)) return FileSpreadsheet;
  if (/^(js|ts|tsx|py|go|php|java|c|cpp|cs|rb|sh|ps1|bat|sql|json|ya?ml|xml|html?|css)$/.test(ext)) return FileCode;
  if (TEXT_EXT.test(e.name) || /^(pdf|docx?|odt|rtf)$/.test(ext)) return FileText;
  return File;
}

/** Ścieżka -> okruszki: "C:\Users\a" -> [C:\, Users, a]; "/var/log" -> [/, var, log]. */
function crumbs(path: string, win: boolean): { label: string; path: string }[] {
  const sep = win ? '\\' : '/';
  const out: { label: string; path: string }[] = [];
  if (win) {
    const m = /^([A-Za-z]:)\\?(.*)$/.exec(path);
    if (!m) return [{ label: path, path }];
    let acc = m[1] + '\\';
    out.push({ label: acc, path: acc });
    for (const part of m[2].split(sep).filter(Boolean)) {
      acc = acc.endsWith(sep) ? acc + part : acc + sep + part;
      out.push({ label: part, path: acc });
    }
    return out;
  }
  let acc = '';
  out.push({ label: '/', path: '/' });
  for (const part of path.split('/').filter(Boolean)) {
    acc += '/' + part;
    out.push({ label: part, path: acc });
  }
  return out;
}

export function FilesView({ agent, initialPath }: { agent: Agent; initialPath: string | null }) {
  const win = agent.os === 'windows';
  const sep = win ? '\\' : '/';
  const join = (dir: string, name: string) => (dir.endsWith(sep) ? dir + name : dir + sep + name);

  const [roots, setRoots] = useState<FsRoot[]>([]);
  const [path, setPath] = useState<string | null>(initialPath);
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [dialog, setDialog] = useState<null | { kind: 'mkdir' } | { kind: 'rename'; entry: FileEntry } | { kind: 'delete'; entries: FileEntry[] }>(null);
  const [editor, setEditor] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const load = useCallback(
    async (p: string) => {
      setLoading(true);
      try {
        const l = await api.fsList(agent.id, p);
        setListing(l);
        setError('');
        setSelected(new Set());
        // ścieżka w adresie — link do konkretnego folderu można wysłać innemu technikowi
        history.replaceState(null, '', `#/m/${agent.id}/files?path=${encodeURIComponent(l.path)}`);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setLoading(false);
      }
    },
    [agent.id],
  );

  const uploads = useUploads(agent.id, (dir) => {
    if (dir === listing?.path) void load(dir);
  });

  useEffect(() => {
    if (!agent.online) return;
    api.fsRoots(agent.id).then(
      (r) => {
        setRoots(r);
        // start: ścieżka z adresu, inaczej profil zalogowanego użytkownika, inaczej pierwszy dysk
        setPath((p) => p ?? r.find((x) => x.kind === 'shortcut')?.path ?? r[0]?.path ?? (win ? 'C:\\' : '/'));
      },
      (err) => setError(errorMessage(err)),
    );
  }, [agent.id, agent.online, win]);

  useEffect(() => {
    if (path && agent.online) void load(path);
  }, [path, agent.online, load]);

  const go = (p: string) => {
    setQ('');
    setEditingPath(false);
    if (p === path) void load(p);
    else setPath(p);
  };

  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (listing?.entries ?? []).filter((e) => (showHidden || !e.hidden) && (!n || e.name.toLowerCase().includes(n)));
  }, [listing, q, showHidden]);
  const hiddenCount = (listing?.entries ?? []).filter((e) => e.hidden).length;

  const open = (e: FileEntry) => {
    if (e.type === 'dir') return go(e.path);
    if (TEXT_EXT.test(e.name) && e.size <= 1024 * 1024) return setEditor(e.path);
    download(e);
  };
  const download = (e: FileEntry) => {
    const a = Object.assign(document.createElement('a'), { href: api.downloadUrl(agent.id, e.path, e.type === 'dir'), download: '' });
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const onDrop = (ev: DragEvent) => {
    ev.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    if (!listing) return;
    const files: File[] = [];
    let dirs = 0;
    for (const item of [...ev.dataTransfer.items]) {
      const entry = item.webkitGetAsEntry?.();
      if (entry?.isDirectory) dirs++;
      else if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (dirs) toast('Foldery nie są jeszcze obsługiwane — przeciągnij pliki albo spakuj folder do ZIP', 'err');
    if (files.length) uploads.add(files, listing.path);
  };

  if (!agent.online) return <EmptyState icon={Plug} title="Komputer jest offline" text="Pliki są dostępne, gdy komputer jest włączony." />;

  const sel = rows.filter((r) => selected.has(r.path));
  const allSel = rows.length > 0 && sel.length === rows.length;
  const toggle = (p: string, v: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (v) n.add(p);
      else n.delete(p);
      return n;
    });

  return (
    <div className="files-layout">
      <aside className="glass-card files-side">
        <div className="nav-group-title">Dyski</div>
        {roots
          .filter((r) => r.kind === 'drive')
          .map((r) => (
            <button key={r.path} className={`files-root ${listing?.path.startsWith(r.path) ? 'on' : ''}`} onClick={() => go(r.path)}>
              <HardDrive />
              <span className="files-root-body">
                <span className="ellipsis">{r.label}</span>
                {r.total ? (
                  <>
                    <span className="meter-track" style={{ height: 4 }}>
                      <span className="meter-fill ok" style={{ width: `${((r.total - (r.free ?? 0)) / r.total) * 100}%`, display: 'block' }} />
                    </span>
                    <span className="muted" style={{ fontSize: 11 }}>
                      wolne {bytes(r.free)} z {bytes(r.total, 0)}
                    </span>
                  </>
                ) : null}
              </span>
            </button>
          ))}
        {roots.some((r) => r.kind === 'shortcut') && (
          <>
            <div className="nav-group-title" style={{ marginTop: 14 }}>
              Skróty
            </div>
            {roots
              .filter((r) => r.kind === 'shortcut')
              .map((r) => (
                <button key={r.path} className={`files-root ${listing?.path === r.path ? 'on' : ''}`} onClick={() => go(r.path)}>
                  <Star />
                  <span className="ellipsis">{r.label}</span>
                </button>
              ))}
          </>
        )}
      </aside>

      <section className="files-main">
        <div className="files-bar">
          <Button size="sm" variant="ghost" icon={ArrowUp} title="Katalog wyżej" disabled={!listing?.parent} onClick={() => listing?.parent && go(listing.parent)} />
          {editingPath ? (
            <form
              className="files-path-form"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                if (pathInput.trim()) go(pathInput.trim());
              }}
            >
              <input
                className="pole mono"
                value={pathInput}
                onChange={(e) => setPathInput(e.target.value)}
                onBlur={() => setEditingPath(false)}
                onKeyDown={(e) => e.key === 'Escape' && setEditingPath(false)}
                autoFocus
              />
            </form>
          ) : (
            <div
              className="crumbs"
              title="Kliknij, aby wpisać ścieżkę"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('button')) return;
                setPathInput(listing?.path ?? '');
                setEditingPath(true);
              }}
            >
              {listing &&
                crumbs(listing.path, win).map((c, i, all) => (
                  <span key={c.path} className="crumb">
                    <button onClick={() => go(c.path)} className={i === all.length - 1 ? 'last' : ''}>
                      {c.label}
                    </button>
                    {i < all.length - 1 && <ChevronRight />}
                  </span>
                ))}
            </div>
          )}
          <Button size="sm" variant="ghost" icon={RefreshCw} title="Odśwież" loading={loading} onClick={() => listing && void load(listing.path)} />
        </div>

        <div className="filters">
          <div className="search">
            <Search />
            <input className="pole" placeholder="Filtruj w tym folderze…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {hiddenCount > 0 && (
            <Button size="sm" variant="ghost" icon={showHidden ? EyeOff : Eye} onClick={() => setShowHidden((v) => !v)}>
              {showHidden ? 'Ukryj ukryte' : `Pokaż ukryte (${hiddenCount})`}
            </Button>
          )}
          <div className="toolbar" style={{ marginLeft: 'auto' }}>
            {sel.length > 0 && (
              <Button size="sm" variant="danger" icon={Trash2} onClick={() => setDialog({ kind: 'delete', entries: sel })}>
                Usuń ({sel.length})
              </Button>
            )}
            <Button size="sm" icon={FolderPlus} disabled={!listing} onClick={() => setDialog({ kind: 'mkdir' })}>
              Nowy folder
            </Button>
            <Button size="sm" variant="primary" icon={Upload} disabled={!listing} onClick={() => fileInput.current?.click()}>
              Wyślij pliki
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (listing && e.target.files?.length) uploads.add([...e.target.files], listing.path);
                e.target.value = '';
              }}
            />
          </div>
        </div>

        {error && <div className="callout callout-warning">{error}</div>}

        <div
          className={`glass-card table-card dropzone ${dragOver ? 'over' : ''}`}
          onDragEnter={(e) => {
            if (![...e.dataTransfer.types].includes('Files')) return;
            dragDepth.current++;
            setDragOver(true);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragOver(false);
          }}
          onDrop={onDrop}
        >
          {dragOver && (
            <div className="drop-hint">
              <Upload /> Upuść, aby wysłać do <span className="mono">{listing?.path}</span>
            </div>
          )}
          {rows.length > 0 && (
            <label className="only-mobile mobile-selectall">
              <Checkbox label="Zaznacz wszystkie" checked={allSel} indeterminate={sel.length > 0 && !allSel} onChange={(v) => setSelected(v ? new Set(rows.map((r) => r.path)) : new Set())} /> Zaznacz wszystkie ({rows.length})
            </label>
          )}
          <div className="table-scroll scroll" style={{ maxHeight: 'calc(100vh - 360px)', minHeight: 320 }}>
            <table className="table hover compact-rows stack">
              <thead className="sticky">
                <tr>
                  <th className="cb-cell">
                    <Checkbox label="Zaznacz wszystkie" checked={allSel} indeterminate={sel.length > 0 && !allSel} onChange={(v) => setSelected(v ? new Set(rows.map((r) => r.path)) : new Set())} />
                  </th>
                  <th>Nazwa</th>
                  <th className="right">Rozmiar</th>
                  <th>Zmodyfikowano</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => {
                  const Icon = iconFor(e);
                  return (
                    <tr key={e.path} className={selected.has(e.path) ? 'row-selected' : ''} onDoubleClick={() => open(e)}>
                      <td className="cb-cell">
                        <Checkbox label={`Zaznacz ${e.name}`} checked={selected.has(e.path)} onChange={(v) => toggle(e.path, v)} />
                      </td>
                      <td className="s-main" style={{ maxWidth: 520 }}>
                        <button className={`file-name ${e.type === 'dir' ? 'dir' : ''} ${e.hidden ? 'hidden-file' : ''}`} onClick={() => open(e)} title={e.path}>
                          <Icon />
                          <span className="ellipsis">{e.name}</span>
                        </button>
                      </td>
                      <td className={`right mono ${e.type === 'dir' ? 's-hide' : 's-meta'}`}>{e.type === 'dir' ? '—' : bytes(e.size)}</td>
                      <td className="small ink-2 nowrap s-meta">{dateTime(e.modified)}</td>
                      <td className="s-end">
                        <span className="only-mobile">
                          <Dropdown
                            icon={MoreHorizontal}
                            title={`Akcje: ${e.name}`}
                            items={[
                              ...(e.type === 'dir' ? [{ key: 'open', label: 'Otwórz folder', icon: FolderOpen, onClick: () => open(e) }] : []),
                              ...(e.type === 'file' && TEXT_EXT.test(e.name) ? [{ key: 'edit', label: 'Podgląd / edycja', icon: FileText, onClick: () => setEditor(e.path) }] : []),
                              { key: 'dl', label: e.type === 'dir' ? 'Pobierz jako ZIP' : 'Pobierz', icon: Download, onClick: () => download(e) },
                              { key: 'ren', label: 'Zmień nazwę', icon: Pencil, onClick: () => setDialog({ kind: 'rename', entry: e }) },
                              { key: 'del', label: 'Usuń', icon: Trash2, danger: true, onClick: () => setDialog({ kind: 'delete', entries: [e] }) },
                            ]}
                          />
                        </span>
                        <div className="menu-actions row-actions only-desktop">
                          {e.type === 'file' && TEXT_EXT.test(e.name) && <Button size="sm" variant="ghost" icon={FileText} title="Podgląd / edycja" onClick={() => setEditor(e.path)} />}
                          <Button size="sm" variant="ghost" icon={Download} title={e.type === 'dir' ? 'Pobierz jako ZIP' : 'Pobierz'} onClick={() => download(e)} />
                          <Button size="sm" variant="ghost" icon={Pencil} title="Zmień nazwę" onClick={() => setDialog({ kind: 'rename', entry: e })} />
                          <Button size="sm" variant="ghost" icon={Trash2} title="Usuń" onClick={() => setDialog({ kind: 'delete', entries: [e] })} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {listing && rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="center-text">
                      {q ? 'Brak pasujących elementów.' : 'Pusty folder — przeciągnij tu pliki albo użyj „Wyślij pliki”.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {listing && (
            <div className="files-foot small muted">
              {rows.filter((r) => r.type === 'dir').length} {plural(rows.filter((r) => r.type === 'dir').length, 'folder', 'foldery', 'folderów')} ·{' '}
              {rows.filter((r) => r.type !== 'dir').length} {plural(rows.filter((r) => r.type !== 'dir').length, 'plik', 'pliki', 'plików')}
              {listing.truncated && ' · wyświetlono pierwsze 5000 elementów'}
            </div>
          )}
        </div>
      </section>

      <UploadPanel uploads={uploads} />

      <MkdirModal
        open={dialog?.kind === 'mkdir'}
        onClose={() => setDialog(null)}
        onSubmit={async (name) => {
          await api.fsMkdir(agent.id, join(listing!.path, name));
          void load(listing!.path);
        }}
      />
      <RenameModal
        entry={dialog?.kind === 'rename' ? dialog.entry : null}
        onClose={() => setDialog(null)}
        onSubmit={async (entry, name) => {
          await api.fsRename(agent.id, entry.path, join(listing!.path, name));
          void load(listing!.path);
        }}
      />
      <DeleteModal
        entries={dialog?.kind === 'delete' ? dialog.entries : null}
        onClose={() => setDialog(null)}
        onConfirm={async (entries) => {
          const r = await api.fsDelete(
            agent.id,
            entries.map((e) => e.path),
          );
          toast(`Usunięto ${r.deleted} ${plural(r.deleted, 'element', 'elementy', 'elementów')}`);
          void load(listing!.path);
        }}
      />
      <TextEditorModal agentId={agent.id} path={editor} onClose={() => setEditor(null)} onSaved={() => listing && void load(listing.path)} />
    </div>
  );
}

function UploadPanel({ uploads }: { uploads: ReturnType<typeof useUploads> }) {
  const { items, cancel, overwrite, clearFinished } = uploads;
  if (items.length === 0) return null;
  const active = items.filter((x) => x.status === 'queued' || x.status === 'uploading').length;
  return (
    <div className="upload-panel anim-rise">
      <div className="upload-head">
        <strong>{active ? `Wysyłanie (${active})` : 'Wysyłanie zakończone'}</strong>
        {!active && <Button size="sm" variant="ghost" icon={X} title="Wyczyść" onClick={clearFinished} />}
      </div>
      <div className="upload-list">
        {items.map((x) => {
          const pct = x.file.size ? Math.round((x.loaded / x.file.size) * 100) : 100;
          return (
            <div key={x.id} className="upload-item">
              <div className="upload-row">
                <span className="ellipsis" title={x.file.name}>
                  {x.file.name}
                </span>
                <span className="muted small nowrap">
                  {x.status === 'uploading' ? `${pct}%` : x.status === 'queued' ? 'w kolejce' : x.status === 'done' ? bytes(x.file.size) : ''}
                </span>
                {(x.status === 'queued' || x.status === 'uploading') && <Button size="sm" variant="ghost" icon={X} title="Anuluj" onClick={() => cancel(x.id)} />}
              </div>
              {x.status === 'uploading' && (
                <div className="meter-track" style={{ height: 4 }}>
                  <div className="meter-fill ok" style={{ width: `${pct}%` }} />
                </div>
              )}
              {x.status === 'done' && <div className="small" style={{ color: 'rgb(var(--success))' }}>Wysłano</div>}
              {x.status === 'cancelled' && <div className="small muted">Anulowano</div>}
              {x.status === 'error' && <div className="small" style={{ color: 'rgb(var(--danger))' }}>{x.error}</div>}
              {x.status === 'exists' && (
                <div className="upload-row small" style={{ color: 'rgb(var(--warning))' }}>
                  Plik już istnieje.
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                    <Button size="sm" onClick={() => overwrite(x.id)}>
                      Nadpisz
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => cancel(x.id)}>
                      Pomiń
                    </Button>
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NameModal({ open, title, initial, action, onClose, onSubmit }: { open: boolean; title: string; initial: string; action: string; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (open) {
      setName(initial);
      setError('');
    }
  }, [open, initial]);
  const invalid = !name.trim() || /[\\/]/.test(name) || name === '.' || name === '..';
  return (
    <Modal open={open} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError('');
          try {
            await onSubmit(name.trim());
            onClose();
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <h3>{title}</h3>
        <Field label="Nazwa" hint={invalid && name ? 'Nazwa nie może zawierać / ani \\.' : undefined}>
          <input
            className="pole"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            onFocus={(e) => {
              // zaznacz nazwę bez rozszerzenia — jak w Eksploratorze/Finderze
              const dot = e.target.value.lastIndexOf('.');
              e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
            }}
          />
        </Field>
        {error && <div className="form-error">{error}</div>}
        <div className="okno-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            Anuluj
          </Button>
          <Button variant="primary" loading={busy} disabled={invalid}>
            {action}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function MkdirModal(p: { open: boolean; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  return <NameModal {...p} title="Nowy folder" initial="Nowy folder" action="Utwórz" />;
}

function RenameModal({ entry, onClose, onSubmit }: { entry: FileEntry | null; onClose: () => void; onSubmit: (e: FileEntry, name: string) => Promise<void> }) {
  return <NameModal open={!!entry} title="Zmień nazwę" initial={entry?.name ?? ''} action="Zmień nazwę" onClose={onClose} onSubmit={(name) => onSubmit(entry!, name)} />;
}

function DeleteModal({ entries, onClose, onConfirm }: { entries: FileEntry[] | null; onClose: () => void; onConfirm: (e: FileEntry[]) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const dirs = entries?.filter((e) => e.type === 'dir').length ?? 0;
  return (
    <Modal open={!!entries} onClose={onClose}>
      {entries && (
        <>
          <h3>Usunąć {entries.length === 1 ? `„${entries[0].name}”` : `${entries.length} ${plural(entries.length, 'element', 'elementy', 'elementów')}`}?</h3>
          <p>
            Pliki zostaną usunięte trwale (bez kosza).
            {dirs > 0 && ' Foldery zostaną usunięte razem z całą zawartością.'}
          </p>
          {entries.length > 1 && (
            <div className="check-list" style={{ maxHeight: 160 }}>
              {entries.map((e) => (
                <div key={e.path} className="small mono ellipsis" style={{ padding: '3px 8px' }}>
                  {e.name}
                  {e.type === 'dir' ? '/' : ''}
                </div>
              ))}
            </div>
          )}
          <div className="okno-actions">
            <Button variant="ghost" onClick={onClose}>
              Anuluj
            </Button>
            <Button
              variant="danger"
              icon={Trash2}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm(entries);
                  onClose();
                } catch (err) {
                  toast(errorMessage(err), 'err');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Usuń trwale
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
