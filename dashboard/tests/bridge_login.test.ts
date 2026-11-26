import { describe, it, expect } from 'vitest';
import { createBridge } from '../src/worker/bridge.ts';
import { postLogin } from '../src/api/login.ts';

const reply = (status: number, body: unknown) => (async () => ({ status, json: async () => body })) as unknown as typeof fetch;

describe('Web Worker bridge (design 3.8)', () => {
  it('posts INIT_AUTH with the token and the tick URL', () => {
    const sent: unknown[] = [];
    createBridge({ postMessage: (m) => sent.push(m) }, 'ws://h/ws/tick').init('tok');
    expect(sent).toEqual([{ type: 'INIT_AUTH', token: 'tok', ws_tick_url: 'ws://h/ws/tick' }]);
  });
  it('sends the same token once and a new token again', () => {
    const sent: unknown[] = [];
    const b = createBridge({ postMessage: (m) => sent.push(m) }, 'u');
    b.init('a'); b.init('a'); b.init('b');
    expect(sent).toHaveLength(2);
  });
});

describe('postLogin (design 3.8 login row)', () => {
  it('200 gives the operator', async () => {
    const r = await postLogin('t', reply(200, { operator_id: 2, display_name: 'Ana', session_id: 4 }));
    expect(r).toEqual({ kind: 'ok', operatorId: 2, displayName: 'Ana', sessionId: 4 });
  });
  it('401 carries retry_after_s', async () => {
    expect(await postLogin('t', reply(401, { error_code: 'UNAUTHENTICATED', detail: 'x', retry_after_s: 2 }))).toEqual({ kind: 'rejected', retryAfterS: 2 });
  });
  it('403 is an origin refusal, 500 is a plain error', async () => {
    expect(await postLogin('t', reply(403, { error_code: 'ORIGIN_REJECTED', detail: 'x', retry_after_s: null }))).toEqual({ kind: 'origin' });
    expect(await postLogin('t', reply(500, {}))).toEqual({ kind: 'error', status: 500 });
  });
  it('a network failure means the host is not reachable', async () => {
    const down = (async () => { throw new TypeError('failed'); }) as unknown as typeof fetch;
    expect(await postLogin('t', down)).toEqual({ kind: 'unreachable' });
  });
});
