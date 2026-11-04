import { useEffect, useState } from 'react';
import { AlertTriangle, Download, Save } from 'lucide-react';
import { api, errorMessage, type TextFile } from '../../api.ts';
import { Button, Modal, toast } from '../../components.tsx';
import { bytes, dateTime } from '../../format.ts';

/** Podgląd i edycja pliku tekstowego (do 1 MB) z ochroną przed nadpisaniem cudzych zmian. */
export function TextEditorModal({ agentId, path, onClose, onSaved }: { agentId: string; path: string | null; onClose: () => void; onSaved: () => void }) {
  const [file, setFile] = useState<TextFile | null>(null);
  const [content, setContent] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    if (!path) return;
    setFile(null);
    setError('');
    setConflict(false);
    api.fsReadText(agentId, path).then(
      (f) => {
        setFile(f);
        setContent(f.content ?? '');
      },
      (err) => setError(errorMessage(err)),
    );
  }, [agentId, path]);

  const dirty = !!file && file.content !== undefined && content !== file.content;
  const name = path?.split(/[\\/]/).pop() ?? '';

  const save = async (force = false) => {
    if (!file || !path) return;
    setBusy(true);
    setError('');
    try {
      const saved = await api.fsWriteText(agentId, path, content, force ? 0 : file.modified);
      setFile({ ...saved, content });
      setConflict(false);
      toast(`Zapisano ${name}`);
      onSaved();
    } catch (err) {
      if ((err as { code?: string }).code === 'conflict') setConflict(true);
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    if (dirty && !confirm('Porzucić niezapisane zmiany?')) return;
    onClose();
  };

  return (
    <Modal open={!!path} onClose={close} wide>
      <div className="editor-head">
        <div style={{ minWidth: 0 }}>
          <h3 className="ellipsis">
            {name}
            {dirty && <span style={{ color: 'rgb(var(--warning))' }}> •</span>}
          </h3>
          <div className="small muted mono ellipsis">{path}</div>
        </div>
        {file && <span className="small muted nowrap">{bytes(file.size)} · {dateTime(file.modified)}</span>}
      </div>

      {!file && !error && <p>Wczytywanie…</p>}
      {error && <div className="form-error">{error}</div>}
      {file && (file.binary || file.tooLarge) && (
        <div className="callout callout-warning">
          <AlertTriangle />
          {file.binary ? 'To nie jest plik tekstowy — można go tylko pobrać.' : 'Plik jest większy niż 1 MB — można go tylko pobrać.'}
        </div>
      )}
      {file?.content !== undefined && (
        <textarea
          className="pole editor-area"
          value={content}
          spellCheck={false}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
              e.preventDefault();
              if (dirty) void save();
            }
          }}
        />
      )}
      {conflict && (
        <div className="callout callout-warning">
          <AlertTriangle />
          <span>
            Plik został zmieniony na komputerze od chwili otwarcia. Zapis nadpisze tamte zmiany.{' '}
            <button className="link-btn" style={{ display: 'inline', color: 'rgb(var(--danger))' }} onClick={() => void save(true)}>
              Nadpisz mimo to
            </button>
          </span>
        </div>
      )}

      <div className="okno-actions">
        {path && (
          <a className="btn btn-ghost" href={api.downloadUrl(agentId, path)} download>
            <Download /> Pobierz
          </a>
        )}
        <span style={{ flex: 1 }} />
        <Button variant="ghost" onClick={close}>
          Zamknij
        </Button>
        {file?.content !== undefined && (
          <Button variant="primary" icon={Save} loading={busy} disabled={!dirty} onClick={() => void save()}>
            Zapisz
          </Button>
        )}
      </div>
    </Modal>
  );
}
