import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Api } from '../api/actions.ts';
import { activeMessage, addMessage, assignMessage, checkEdit, checkForm, downloadReadings, editFormOf, editMessage, emptyForm, getFirefighters, isWithdrawn, postActive, postAssign, postEdit, postFirefighter, postWithdraw, readingsMessage, withdrawMessage, type EditForm, type FirefighterRow, type Form } from '../api/firefighters.ts';
import { realSaveDeps, type SaveDeps } from '../api/shift.ts';
import { useLive } from '../store/live.ts';
import { setWearers } from '../store/wearers.ts';
import { BTN } from './btn.ts';

const FIELD = 'min-h-11 w-full rounded border-2 border-card-border bg-white px-2 text-base';
const pad = (n: number) => String(n).padStart(2, '0');
export const localToday = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
type Load = { kind: 'loading' } | { kind: 'ok' } | { kind: 'failed'; text: string };

// Settings (ADR 0071): who the firefighters are and who wears which jacket. It opens from the top strip like the Sessions list, sits in normal flow and scrolls inside itself.
// The full name is shown on this screen only; the node cards, the alerts and the log carry the alias (FFR-01). Adding a firefighter needs the consent record.
export default function SettingsPanel({ api, onClose, saveDeps }: { api: Api; onClose: () => void; saveDeps?: SaveDeps }) {
  const roster = useLive((s) => s.roster);
  const [load, setLoad] = useState<Load>({ kind: 'loading' }), [rows, setRows] = useState<FirefighterRow[]>([]);
  const [open, setOpen] = useState(false), [form, setForm] = useState<Form>(() => emptyForm(localToday())), [formError, setFormError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ row: FirefighterRow; form: EditForm } | null>(null), [editError, setEditError] = useState<string | null>(null), [confirming, setConfirming] = useState<FirefighterRow | null>(null);
  const [busy, setBusy] = useState(false), [note, setNote] = useState<string | null>(null), [pick, setPick] = useState<Record<number, string>>({});
  const run = useCallback(async () => {
    const r = await getFirefighters(api);
    if (r.kind === 'ok') { setRows(r.body); setWearers(r.body); setLoad({ kind: 'ok' }); }
    else setLoad({ kind: 'failed', text: r.kind === 'auth' ? 'Not signed in. Log in again.' : 'The host did not answer. Try again.' });
  }, [api]);
  useEffect(() => { void run(); }, [run]);
  function set<K extends keyof Form>(k: K, v: Form[K]) { setForm((f) => ({ ...f, [k]: v })); }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const c = checkForm(form, localToday());
    if ('error' in c) { setFormError(c.error); return; }
    setFormError(null); setBusy(true);
    const r = await postFirefighter(api, c.body);
    setBusy(false);
    if (r.kind === 'ok') { setNote(addMessage(r)); setForm(emptyForm(localToday())); setOpen(false); await run(); } else setFormError(addMessage(r));
  };
  const assign = async (nodeId: number, chosen: string) => {
    setBusy(true); setNote(null);
    const r = await postAssign(api, nodeId, chosen === '' ? null : Number(chosen));
    setBusy(false); setNote(assignMessage(r));
    if (r.kind === 'ok') { setPick((p) => { const n = { ...p }; delete n[nodeId]; return n; }); await run(); }
  };
  const toggle = async (r: FirefighterRow) => {
    setBusy(true); setNote(null);
    const res = await postActive(api, r.firefighter_id, !r.active);
    setBusy(false); setNote(activeMessage(res, r.alias));
    if (res.kind === 'ok') await run();
  };
  const startEdit = (r: FirefighterRow) => { setConfirming(null); setEditError(null); setNote(null); setEditing({ row: r, form: editFormOf(r) }); };
  const setEdit = <K extends keyof EditForm>(k: K, v: EditForm[K]) => setEditing((e) => (e ? { ...e, form: { ...e.form, [k]: v } } : e));
  const saveEdit = async (e: FormEvent) => {      // ADR 0074: only the fields that differ are sent
    e.preventDefault(); if (!editing) return;
    const c = checkEdit(editing.form, editing.row);
    if ('error' in c) { setEditError(c.error); return; }
    setEditError(null); setBusy(true);
    const r = await postEdit(api, c.body);
    setBusy(false);
    if (r.kind === 'ok') { setNote(editMessage(r, editing.row.alias)); setEditing(null); await run(); } else setEditError(editMessage(r, editing.row.alias));
  };
  const withdraw = async (r: FirefighterRow) => {      // ADR 0074: asked first; it cannot be undone here
    setBusy(true); setNote(null);
    const res = await postWithdraw(api, r.firefighter_id);
    setBusy(false); setNote(withdrawMessage(res, r.alias));
    if (res.kind === 'ok') { setConfirming(null); setEditing(null); await run(); }
  };
  const download = async () => {      // ADR 0073: the readings of each firefighter, alias only
    setBusy(true); setNote(null);
    const r = await downloadReadings(api, saveDeps ?? realSaveDeps());
    setBusy(false); setNote(readingsMessage(r));
  };
  const nodeAlias = (id: number | null) => (id === null ? 'none' : roster.find((r) => r.node_id === id)?.alias ?? `node ${id}`);
  const active = rows.filter((r) => r.active), nodes = roster.filter((r) => r.active);

  return (
    <section aria-label="Settings" className="max-h-[60dvh] space-y-3 overflow-y-auto border-b-2 border-card-border bg-white p-3">
      <div className="flex items-center justify-between"><h2 className="text-xl font-bold">Settings</h2><button type="button" className={BTN} onClick={onClose}>Close settings</button></div>
      {note && <p role="status" className="text-base font-semibold">{note}</p>}
      {load.kind === 'loading' && <p className="text-base">Loading firefighters...</p>}
      {load.kind === 'failed' && <p role="status" className="text-base font-semibold">{load.text} <button type="button" className={BTN} onClick={() => { void run(); }}>Try again</button></p>}
      {load.kind === 'ok' && (
        <>
          <section aria-label="Firefighters" className="space-y-2">
            <h3 className="text-lg font-bold">Firefighters</h3>
            <p className="text-base">The name is shown on this screen only. Everywhere else the alias is used.</p>
            {rows.length === 0 ? <p className="text-base">No firefighters yet.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-base">
                  <thead><tr><th className="p-1">Alias</th><th className="p-1">Name</th><th className="p-1">Age</th><th className="p-1">Weight (kg)</th><th className="p-1">Resting HR</th><th className="p-1">Smoker</th><th className="p-1">Wears</th><th className="p-1">Status</th><th className="p-1">Profile</th></tr></thead>
                  <tbody>{rows.map((r) => <tr key={r.firefighter_id} className="border-t border-card-border"><td className="p-1">{r.alias}</td><td className="p-1">{r.full_name}</td><td className="p-1">{r.age_years}</td><td className="p-1">{r.weight_kg}</td><td className="p-1">{r.resting_hr}</td><td className="p-1">{r.smoker ? 'Yes' : 'No'}</td><td className="p-1">{isWithdrawn(r) ? 'consent withdrawn' : r.active ? nodeAlias(r.node_id) : 'inactive'}</td><td className="p-1">{isWithdrawn(r) ? 'Consent withdrawn' : <button type="button" className={BTN} disabled={busy} aria-label={r.active ? `Set ${r.alias} inactive` : `Set ${r.alias} active`} onClick={() => { void toggle(r); }}>{r.active ? 'Set inactive' : 'Set active'}</button>}</td><td className="p-1">{isWithdrawn(r) ? '' : <span className="flex flex-wrap gap-1"><button type="button" className={BTN} disabled={busy} aria-label={`Edit ${r.alias}`} onClick={() => startEdit(r)}>Edit</button><button type="button" className={BTN} disabled={busy} aria-label={`Withdraw consent for ${r.alias}`} onClick={() => { setEditing(null); setConfirming(r); }}>Withdraw consent</button></span>}</td></tr>)}</tbody>
                </table>
              </div>
            )}
            {confirming && (
              <div role="alertdialog" aria-label={`Withdraw consent for ${confirming.alias}`} className="space-y-2 rounded border-2 border-card-border p-2">
                <p className="text-base font-semibold">Withdraw consent for {confirming.alias}? {confirming.alias} is set inactive, stops wearing a jacket and is left out of the readings download. The profile stays as the record. This cannot be undone here.</p>
                <div className="flex flex-wrap gap-2"><button type="button" className={BTN} disabled={busy} onClick={() => { void withdraw(confirming); }}>Yes, withdraw consent</button><button type="button" className={BTN} disabled={busy} onClick={() => setConfirming(null)}>Cancel</button></div>
              </div>
            )}
            {editing && (
              <form onSubmit={(e) => { void saveEdit(e); }} className="grid gap-3 md:grid-cols-2" aria-label={`Edit ${editing.row.alias}`}>
                <h4 className="text-base font-bold md:col-span-2">Edit {editing.row.alias}</h4>
                <label className="block text-base">Full name<input className={FIELD} value={editing.form.name} maxLength={80} autoComplete="off" onChange={(e) => setEdit('name', e.target.value)} /></label>
                <label className="block text-base">Age (years)<input className={FIELD} inputMode="numeric" value={editing.form.age} onChange={(e) => setEdit('age', e.target.value)} /></label>
                <label className="block text-base">Height (cm)<input className={FIELD} inputMode="numeric" value={editing.form.height} onChange={(e) => setEdit('height', e.target.value)} /></label>
                <label className="block text-base">Weight (kg)<input className={FIELD} inputMode="decimal" value={editing.form.weight} onChange={(e) => setEdit('weight', e.target.value)} /></label>
                <label className="block text-base">Resting heart rate (bpm)<input className={FIELD} inputMode="numeric" value={editing.form.restingHr} onChange={(e) => setEdit('restingHr', e.target.value)} /></label>
                <label className="block text-base">Maximum heart rate (bpm, optional)<input className={FIELD} inputMode="numeric" value={editing.form.maxHr} onChange={(e) => setEdit('maxHr', e.target.value)} /></label>
                <label className="block text-base">Smoker
                  <select aria-label="Smoker" className={FIELD} value={editing.form.smoker} onChange={(e) => setEdit('smoker', e.target.value as EditForm['smoker'])}><option value="no">Non-smoker</option><option value="yes">Smoker</option></select>
                </label>
                <label className="block text-base">Sex (optional)
                  <select aria-label="Sex (optional)" className={FIELD} value={editing.form.sex} onChange={(e) => setEdit('sex', e.target.value as EditForm['sex'])}><option value="">Not stated</option><option value="F">F</option><option value="M">M</option><option value="X">X</option></select>
                </label>
                <label className="block text-base">Years of service (optional)<input className={FIELD} inputMode="decimal" value={editing.form.years} onChange={(e) => setEdit('years', e.target.value)} /></label>
                <p className="text-base md:col-span-2">The consent record is not edited here. The log records which fields changed, not their values.</p>
                {editError && <p role="alert" className="text-base font-semibold md:col-span-2">{editError}</p>}
                <div className="flex flex-wrap gap-2 md:col-span-2"><button type="submit" className={BTN} disabled={busy}>Save changes</button><button type="button" className={BTN} disabled={busy} onClick={() => { setEditing(null); setEditError(null); }}>Cancel</button></div>
              </form>
            )}
            <div className="space-y-1">
              <button type="button" className={BTN} disabled={busy} onClick={() => { void download(); }}>Download readings by firefighter</button>
              <p className="text-base">One row per reading with the alias of who wore the jacket then. The name is not in the file, and people who withdrew consent are left out.</p>
            </div>
          </section>

          <section aria-label="Who wears the jacket" className="space-y-2">
            <h3 className="text-lg font-bold">Who wears the jacket</h3>
            {nodes.length === 0 ? <p className="text-base">No responders on the roster.</p> : nodes.map((n) => {
              const mine = rows.find((r) => r.node_id === n.node_id)?.firefighter_id, chosen = pick[n.node_id] ?? (mine === undefined ? '' : String(mine));
              return (
                <div key={n.node_id} className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-base"><span className="font-semibold">{n.alias}</span>
                    <select aria-label={`Firefighter for ${n.alias}`} className={FIELD} value={chosen} disabled={busy} onChange={(e) => setPick((p) => ({ ...p, [n.node_id]: e.target.value }))}>
                      <option value="">Nobody</option>
                      {active.filter((r) => r.node_id === null || r.node_id === n.node_id).map((r) => <option key={r.firefighter_id} value={String(r.firefighter_id)}>{r.alias} {r.full_name}</option>)}
                    </select>
                  </label>
                  <button type="button" className={BTN} disabled={busy} aria-label={`Save who wears ${n.alias}`} onClick={() => { void assign(n.node_id, chosen); }}>Save</button>
                </div>
              );
            })}
          </section>

          <section aria-label="Add firefighter" className="space-y-2">
            <button type="button" className={BTN} aria-expanded={open} onClick={() => { setOpen((v) => !v); setFormError(null); }}>Add firefighter</button>
            {open && (
              <form onSubmit={(e) => { void submit(e); }} className="grid gap-3 md:grid-cols-2" aria-label="New firefighter">
                <label className="block text-base">Full name<input className={FIELD} value={form.name} maxLength={80} autoComplete="off" onChange={(e) => set('name', e.target.value)} /></label>
                <label className="block text-base">Age (years)<input className={FIELD} inputMode="numeric" value={form.age} onChange={(e) => set('age', e.target.value)} /></label>
                <label className="block text-base">Height (cm)<input className={FIELD} inputMode="numeric" value={form.height} onChange={(e) => set('height', e.target.value)} /></label>
                <label className="block text-base">Weight (kg)<input className={FIELD} inputMode="decimal" value={form.weight} onChange={(e) => set('weight', e.target.value)} /></label>
                <label className="block text-base">Resting heart rate (bpm)<input className={FIELD} inputMode="numeric" value={form.restingHr} onChange={(e) => set('restingHr', e.target.value)} /></label>
                <label className="block text-base">Maximum heart rate (bpm, optional)<input className={FIELD} inputMode="numeric" value={form.maxHr} onChange={(e) => set('maxHr', e.target.value)} /></label>
                <label className="block text-base">Smoker
                  <select aria-label="Smoker" className={FIELD} value={form.smoker} onChange={(e) => set('smoker', e.target.value as Form['smoker'])}><option value="">Choose</option><option value="no">Non-smoker</option><option value="yes">Smoker</option></select>
                </label>
                <label className="block text-base">Sex (optional)
                  <select aria-label="Sex (optional)" className={FIELD} value={form.sex} onChange={(e) => set('sex', e.target.value as Form['sex'])}><option value="">Not stated</option><option value="F">F</option><option value="M">M</option><option value="X">X</option></select>
                </label>
                <label className="block text-base">Years of service (optional)<input className={FIELD} inputMode="decimal" value={form.years} onChange={(e) => set('years', e.target.value)} /></label>
                <fieldset className="space-y-2 rounded border-2 border-card-border p-2 md:col-span-2">
                  <legend className="px-1 text-base font-bold">Consent</legend>
                  <label className="flex items-center gap-2 text-base"><input type="checkbox" className="size-6" checked={form.consent} onChange={(e) => set('consent', e.target.checked)} />Consent given: the firefighter signed the consent form</label>
                  <div className="grid gap-3 md:grid-cols-3">
                    <label className="block text-base">Consent form version<input className={FIELD} value={form.formVersion} maxLength={40} onChange={(e) => set('formVersion', e.target.value)} /></label>
                    <label className="block text-base">Witness name<input className={FIELD} value={form.witness} maxLength={80} autoComplete="off" onChange={(e) => set('witness', e.target.value)} /></label>
                    <label className="block text-base">Consent date<input type="date" className={FIELD} value={form.date} max={localToday()} onChange={(e) => set('date', e.target.value)} /></label>
                  </div>
                </fieldset>
                {formError && <p role="alert" className="text-base font-semibold md:col-span-2">{formError}</p>}
                <div className="md:col-span-2"><button type="submit" className={BTN} disabled={busy}>Save firefighter</button></div>
              </form>
            )}
          </section>
        </>
      )}
    </section>
  );
}
