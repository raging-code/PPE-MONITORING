import { useState } from 'react';
import type { Api } from '../api/actions.ts';
import { assignMessage, getFirefighters, postAssign } from '../api/firefighters.ts';
import { useLive } from '../store/live.ts';
import { confirmWearers, optionsFor, planConfirm, setWearers, startBlocked, useWearers } from '../store/wearers.ts';

const SEL = 'min-h-11 rounded border-2 border-slate-400 bg-white px-2 text-base text-slate-900';
// Start monitoring step (ADR 0072): before the shift starts, the operator says who wears each jacket today, so the readings are stored against the right person.
// The choice starts as what the host has, one press confirms it, and a change made by anyone else after that asks again. Alias only: the name is on the Settings screen.
// It shows nothing when the host has no firefighters yet or did not answer, so Start monitoring never waits for a host that is down.
export default function WearerConfirm({ api }: { api: Api }) {
  const roster = useLive((s) => s.roster), people = useWearers((s) => s.people), blocked = useWearers(startBlocked);
  const [pick, setPick] = useState<Record<number, string>>({}), [busy, setBusy] = useState(false), [msg, setMsg] = useState<string | null>(null);
  if (people === null) return null;
  const nodes = roster.filter((r) => r.active);
  if (people.length === 0) return <p className="w-full text-base">No firefighters are set up, so the readings are not linked to a person. Add one in Settings.</p>;
  if (!blocked) return <p className="w-full text-base font-semibold">Jackets confirmed: {nodes.map((n) => `${n.alias} ${people.find((p) => p.node_id === n.node_id)?.alias ?? 'nobody'}`).join(', ')}</p>;
  const ids = nodes.map((n) => n.node_id), mine = (n: number) => people.find((p) => p.node_id === n)?.firefighter_id;
  const chosen = (n: number) => pick[n] ?? (mine(n) === undefined ? '' : String(mine(n)));
  const confirm = async () => {
    const plan = planConfirm(ids, people, pick);
    if (plan === null) { setMsg('One firefighter cannot wear two jackets.'); return; }
    setBusy(true); setMsg(null);
    for (const c of plan) {
      const r = await postAssign(api, c.node_id, c.firefighter_id);
      if (r.kind !== 'ok') { setMsg(assignMessage(r)); setBusy(false); const l = await getFirefighters(api); if (l.kind === 'ok') setWearers(l.body); return; }
    }
    const l = await getFirefighters(api); setBusy(false);
    if (l.kind !== 'ok') { setMsg('The host did not answer. Nothing was confirmed. Try again.'); return; }
    setWearers(l.body); setPick({}); confirmWearers();
  };
  return (
    <div role="group" aria-label="Who wears the jackets today" className="w-full space-y-2">
      <p className="font-semibold">Who wears each jacket today? Confirm before Start monitoring.</p>
      <div className="flex flex-wrap items-center gap-3">
        {nodes.map((n) => (
          <label key={n.node_id} className="flex items-center gap-2"><span className="font-semibold">{n.alias}</span>
            <select aria-label={`Firefighter for ${n.alias}`} className={SEL} value={chosen(n.node_id)} disabled={busy} onChange={(e) => setPick((p) => ({ ...p, [n.node_id]: e.target.value }))}>
              <option value="">Nobody</option>
              {optionsFor(n.node_id, ids, people, pick).map((p) => <option key={p.firefighter_id} value={String(p.firefighter_id)}>{p.alias}</option>)}
            </select>
          </label>
        ))}
        <button type="button" className="min-h-11 rounded-lg bg-slate-900 px-4 text-base font-bold text-white disabled:opacity-50" disabled={busy} onClick={() => { void confirm(); }}>Confirm who wears the jackets</button>
      </div>
      {msg && <p role="alert">{msg}</p>}
    </div>
  );
}
