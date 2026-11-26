// P21b stub. P22c adds the /ws/tick socket here and the 4 s NO LIVE DATA judgement from server timestamps.
let auth: { token: string; wsTickUrl: string } | null = null;

self.onmessage = (e: MessageEvent) => {
  const m = e.data as { type?: unknown; token?: unknown; ws_tick_url?: unknown } | null;
  if (m && m.type === 'INIT_AUTH' && typeof m.token === 'string' && typeof m.ws_tick_url === 'string') {
    auth = { token: m.token, wsTickUrl: m.ws_tick_url };
    self.postMessage({ type: 'INIT_ACK', ws_tick_url: auth.wsTickUrl });
  }
};

export {};
