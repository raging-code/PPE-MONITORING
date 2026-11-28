// REST calls and form checks of the Settings screen (ADR 0071, design 3.8 FIREFIGHTER addendum): the firefighter list, Add firefighter and who wears which jacket.
// Same outcomes as api/actions.ts; nothing here throws. The ranges are the host's (services/firefighters.py RANGES), checked here only to save a round trip: the host decides.
import { request, type ActionResult, type Api } from './actions.ts';
import { realSaveDeps, type SaveDeps } from './shift.ts';

export type Sex = 'F' | 'M' | 'X';
export interface FirefighterRow {
  firefighter_id: number; alias: string; full_name: string; sex: Sex | null; age_years: number; height_cm: number; weight_kg: number; resting_hr: number; max_hr: number | null;
  smoker: boolean; years_service: number | null; consent_ts: number; consent_form_version: string; active: boolean; node_id: number | null;
}
export interface AddBody {
  full_name: string; sex: Sex | null; age_years: number; height_cm: number; weight_kg: number; resting_hr: number; max_hr: number | null; smoker: boolean; years_service: number | null;
  consent: boolean; consent_form_version: string; consent_witness: string; consent_date: string | null;
}
export interface AddedBody { firefighter_id: number; alias: string }
export interface AssignBody { node_id: number; firefighter_id: number | null; alias: string | null; result: 'assigned' | 'ended' | 'unchanged' }

export interface ActiveBody { firefighter_id: number; alias: string; active: boolean; result: 'changed' | 'unchanged' }
export const getFirefighters = (api: Api): Promise<ActionResult<FirefighterRow[]>> => request<FirefighterRow[]>(api, 'GET', '/api/firefighters');
export const postFirefighter = (api: Api, body: AddBody): Promise<ActionResult<AddedBody>> => request<AddedBody>(api, 'POST', '/api/firefighters', body);
export const postAssign = (api: Api, nodeId: number, firefighterId: number | null): Promise<ActionResult<AssignBody>> => request<AssignBody>(api, 'POST', '/api/firefighters/assign', { node_id: nodeId, firefighter_id: firefighterId });

export const postActive = (api: Api, firefighterId: number, active: boolean): Promise<ActionResult<ActiveBody>> => request<ActiveBody>(api, 'POST', '/api/firefighters/active', { firefighter_id: firefighterId, active });
const recovering = (r: { retryAfterS?: number | null }) => `The host is recovering. Try again${r.retryAfterS ? ` in ${Math.ceil(r.retryAfterS)} s` : ' in a moment'}.`;
export function addMessage(r: ActionResult<AddedBody>): string {
  switch (r.kind) {
    case 'ok': return `Saved as ${r.body.alias}.`;
    case 'conflict': return r.code === 'RECOVERING' ? recovering(r) : 'The host refused the change.';
    case 'auth': return 'Not signed in. Log in again.';
    case 'retry': return 'The host did not answer. Nothing was saved. Try again.';
    case 'gone': return 'The host does not know this request.';
    case 'bad': return `Not accepted: ${r.detail}`;
  }
}
export function assignMessage(r: ActionResult<AssignBody>): string {
  switch (r.kind) {
    case 'ok': return r.body.result === 'assigned' ? `${r.body.alias} now wears this jacket.` : r.body.result === 'ended' ? 'Nobody is assigned to this jacket now.' : 'No change.';
    case 'conflict': return r.code === 'RECOVERING' ? recovering(r) : 'That firefighter cannot be assigned: inactive, or already on another jacket.';
    case 'auth': return 'Not signed in. Log in again.';
    case 'retry': return 'The host did not answer. Nothing was changed. Try again.';
    case 'gone': return 'The host has no such jacket or firefighter.';
    case 'bad': return `Not accepted: ${r.detail}`;
  }
}
// ADR 0072: set inactive (the jacket they wear is ended) or active again. alias is the one the person pressed, so no name is needed here.
export function activeMessage(r: ActionResult<ActiveBody>, alias: string): string {
  switch (r.kind) {
    case 'ok': return r.body.result === 'unchanged' ? 'No change.' : r.body.active ? `${alias} is active again.` : `${alias} is inactive now and no longer wears a jacket.`;
    case 'conflict': return r.code === 'RECOVERING' ? recovering(r) : 'The host refused the change.';
    case 'auth': return 'Not signed in. Log in again.';
    case 'retry': return 'The host did not answer. Nothing was changed. Try again.';
    case 'gone': return 'The host does not know this firefighter.';
    case 'bad': return `Not accepted: ${r.detail}`;
  }
}
// The alias of the firefighter who wears each node now (active profiles only). No name leaves this function: the node card shows the alias.
export function wearersOf(rows: FirefighterRow[]): Record<number, string> {
  const out: Record<number, string> = {};
  for (const r of rows) if (r.active && r.node_id !== null) out[r.node_id] = r.alias;
  return out;
}

// ---- the Add firefighter form ----
export interface Form {
  name: string; age: string; height: string; weight: string; restingHr: string; maxHr: string; sex: '' | Sex; smoker: '' | 'yes' | 'no'; years: string;
  consent: boolean; formVersion: string; witness: string; date: string;
}
export const emptyForm = (today: string): Form => ({ name: '', age: '', height: '', weight: '', restingHr: '', maxHr: '', sex: '', smoker: '', years: '', consent: false, formVersion: '', witness: '', date: today });
export const RANGES = { age: [16, 80], height: [120, 230], weight: [30, 250], restingHr: [30, 120], maxHr: [100, 230], years: [0, 60] } as const;

function num(label: string, text: string, [lo, hi]: readonly [number, number], integer: boolean, required: boolean): { error: string } | { value: number | null } {
  const t = text.trim();
  if (t === '') return required ? { error: `${label} is required.` } : { value: null };
  if (!/^\d+(\.\d+)?$/.test(t) || (integer && t.includes('.'))) return { error: `${label} must be a ${integer ? 'whole ' : ''}number.` };
  const v = Number(t);
  return v >= lo && v <= hi ? { value: v } : { error: `${label} must be ${lo} to ${hi}.` };
}
// The first problem as one sentence, or the body to send. today is YYYY-MM-DD in this screen's local date.
export function checkForm(f: Form, today: string): { error: string } | { body: AddBody } {
  const name = f.name.trim(), form = f.formVersion.trim(), witness = f.witness.trim();
  if (!name) return { error: 'Full name is required.' };
  if (name.length > 80) return { error: 'Full name is at most 80 characters.' };
  const age = num('Age', f.age, RANGES.age, true, true), height = num('Height', f.height, RANGES.height, true, true), weight = num('Weight', f.weight, RANGES.weight, false, true);
  const rhr = num('Resting heart rate', f.restingHr, RANGES.restingHr, true, true), mhr = num('Maximum heart rate', f.maxHr, RANGES.maxHr, true, false), ys = num('Years of service', f.years, RANGES.years, false, false);
  for (const n of [age, height, weight, rhr, mhr, ys]) if ('error' in n) return { error: n.error };
  if (f.smoker === '') return { error: 'Say whether the firefighter smokes.' };
  const a = age as { value: number }, h = height as { value: number }, w = weight as { value: number }, r = rhr as { value: number }, m = mhr as { value: number | null }, y = ys as { value: number | null };
  if (m.value !== null && m.value <= r.value) return { error: 'Maximum heart rate must be above the resting heart rate.' };
  if (!f.consent) return { error: 'Tick the consent box: a profile is saved only with consent.' };
  if (!form) return { error: 'The consent form version is required.' };
  if (!witness) return { error: 'The consent witness is required.' };
  if (f.date && !/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return { error: 'The consent date must be a date.' };
  if (f.date > today) return { error: 'The consent date cannot be in the future.' };
  return { body: { full_name: name, sex: f.sex === '' ? null : f.sex, age_years: a.value, height_cm: h.value, weight_kg: w.value, resting_hr: r.value, max_hr: m.value, smoker: f.smoker === 'yes', years_service: y.value,
    consent: true, consent_form_version: form, consent_witness: witness, consent_date: f.date === '' ? null : f.date } };
}
// ADR 0073: the readings of each firefighter as a CSV. The same authenticated fetch, blob and object URL as the other CSV files (a plain link carries no Authorization header); the file holds the alias, never the name.
export async function downloadReadings(api: Api, deps: SaveDeps = realSaveDeps()): Promise<'saved' | 'auth' | 'failed'> {
  let res: Response;
  try { res = await api.fetchFn('/api/firefighters/readings.csv', { method: 'GET', headers: { Authorization: `Bearer ${api.getToken() ?? ''}` } }); } catch { return 'failed'; }
  if (res.status === 401 || res.status === 403) return 'auth';
  if (res.status !== 200) return 'failed';
  let blob: Blob;
  try { blob = await res.blob(); } catch { return 'failed'; }
  const url = deps.createObjectURL(blob);
  deps.click(url, 'firefighter-readings.csv');
  deps.revokeObjectURL(url);
  return 'saved';
}
export const readingsMessage = (r: 'saved' | 'auth' | 'failed'): string => (r === 'saved' ? 'Saved firefighter-readings.csv. It shows the alias, not the name.' : r === 'auth' ? 'Not signed in. Log in again.' : 'The host did not send the file. Try again.');
