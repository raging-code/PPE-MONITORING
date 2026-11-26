import { useState } from 'react';
import type { EpisodeBody } from '../gen/ws.ts';
import { REASON_LABEL, RESOLVE_REASONS, resolveMessage, type ActionResult, type ResolveBody, type ResolveReason } from '../api/actions.ts';
import Modal from './Modal.tsx';
import { BTN } from './btn.ts';

export interface ResolveDialogProps {
  alias: string;
  episode: EpisodeBody;
  onResolve: (episodeId: number, reason: ResolveReason) => Promise<ActionResult<ResolveBody>>;
  onDone: (message: string) => void; // the host answered (or refused); the dialog closes and the card shows the words
  onClose: () => void;
}

// Resolve needs the node, the episode ID and a reason (3.3). It replaces the inline form of P22-3. A call that could not reach the host keeps the dialog open.
export default function ResolveDialog({ alias, episode, onResolve, onDone, onClose }: ResolveDialogProps) {
  const [reason, setReason] = useState<ResolveReason | ''>(''), [busy, setBusy] = useState(false), [retryMsg, setRetryMsg] = useState<string | null>(null);
  const submit = async () => {
    if (reason === '') return;
    setBusy(true);
    const r = await onResolve(episode.episode_id, reason);
    setBusy(false);
    if (r.kind === 'retry') setRetryMsg(resolveMessage(r)); else onDone(resolveMessage(r));
  };
  return (
    <Modal label={`Resolve ${alias}, episode ${episode.episode_id}`} onClose={onClose}>
      <h2 className="text-xl font-bold">Resolve {alias}, episode {episode.episode_id}</h2>
      <p className="text-base">{episode.kind === 'MAYDAY' ? 'MAYDAY' : 'MAN-DOWN'} for {alias}. Resolving closes the episode on the host. It does not clear the jacket latch: only the CANCEL button on the jacket does.</p>
      <fieldset className="space-y-2">
        <legend className="text-base font-semibold">Reason</legend>
        {RESOLVE_REASONS.map((r) => (
          <label key={r} className="flex min-h-11 items-center gap-3 text-base">
            <input type="radio" name="resolve-reason" className="h-5 w-5" checked={reason === r} onChange={() => setReason(r)} />{REASON_LABEL[r]}
          </label>
        ))}
      </fieldset>
      {retryMsg !== null && <p role="status" className="text-base font-semibold">{retryMsg}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BTN} disabled={reason === '' || busy} onClick={() => { void submit(); }}>Confirm resolve</button>
        <button type="button" className={BTN} onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
