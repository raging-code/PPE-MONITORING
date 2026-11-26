import { useState } from 'react';
import type { Api } from '../api/actions.ts';
import { endMessage, postSessionEnd, type EndBody } from '../api/shift.ts';
import { nothingOpen, type OpenItems } from '../alerts/shift.ts';
import Modal from './Modal.tsx';
import { BTN } from './btn.ts';

export interface EndShiftDialogProps { api: Api; sessionId: number | null; items: OpenItems; onEnded: (b: EndBody) => void; onClose: () => void }

function List({ title, rows }: { title: string; rows: string[] }) {
  return rows.length === 0 ? null : (
    <section aria-label={title}>
      <h3 className="text-base font-bold">{title} ({rows.length})</h3>
      <ul className="list-disc pl-6 text-base">{rows.map((r, i) => <li key={i}>{r}</li>)}</ul>
    </section>
  );
}

// End shift (3.7): never blocked, never silences or hides anything. It lists every open item and the operator types END.
export default function EndShiftDialog({ api, sessionId, items, onEnded, onClose }: EndShiftDialogProps) {
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [msg, setMsg] = useState<string | null>(null);
  const ready = text.trim() === 'END' && sessionId !== null && !busy;
  const submit = async () => {
    if (sessionId === null) return;
    setBusy(true); setMsg(null);
    const r = await postSessionEnd(api, sessionId);
    setBusy(false);
    if (r.kind === 'ok') onEnded(r.body); else setMsg(endMessage(r));
  };
  return (
    <Modal label="End shift" onClose={onClose}>
      <h2 className="text-xl font-bold">End shift</h2>
      <p className="text-base">Ending the shift does not silence or hide anything. The host closes this session, saves a backup and opens a new session at once. Frames, alerts and sound continue, and open alerts and episodes carry over.</p>
      {nothingOpen(items) ? <p className="text-base font-semibold">Nothing is open right now.</p> : (
        <div className="space-y-2">
          <List title="Open alerts" rows={items.alerts} />
          <List title="Open episodes" rows={items.episodes} />
          <List title="Latched jackets" rows={items.latched} />
        </div>
      )}
      <label className="block text-base font-semibold">Type END to confirm
        <input type="text" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" className="mt-1 block min-h-11 w-40 rounded-lg border-2 border-card-border px-3 text-base font-normal" />
      </label>
      {msg !== null && <p role="status" className="text-base font-semibold">{msg}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN} disabled={!ready} onClick={() => { void submit(); }}>End shift</button>
        <button type="button" className={BTN} onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
