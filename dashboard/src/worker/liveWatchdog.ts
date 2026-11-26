// Web Worker entry (design 3.7): its own authenticated /ws/tick socket and the 4 s NO LIVE DATA judgement.
// A worker timer is not throttled like a hidden tab's page timers, which is why the judgement lives here.
import { CONSTANTS } from '../gen/constants.ts';
import { LiveSocket } from '../net/socket.ts';
import { createRunner } from './runner.ts';

const runner = createRunner({
  post: (m) => self.postMessage(m),
  makeSocket: (o) => new LiveSocket({
    url: o.url, getToken: () => o.token, noHb: true,
    onMessage: (m) => { if (m.type === 'tick') o.onTick(m.srv_ts); return false; },
    onConnecting: () => {}, onAuthRejected: o.onAuthLost, onForbidden: o.onAuthLost,
  }),
  now: () => performance.now(),
  wall: () => Date.now(),
  every: (fn, ms) => { const h = setInterval(fn, ms); return () => clearInterval(h); },
  staleMs: CONSTANTS.dashboard_stale_s * 1000,
});
self.onmessage = (e: MessageEvent) => runner.handle(e.data);
export {};
