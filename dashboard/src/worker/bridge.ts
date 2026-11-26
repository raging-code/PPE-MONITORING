// A Web Worker cannot read sessionStorage, so the main thread hands it the token (design 3.8):
// {type:'INIT_AUTH', token, ws_tick_url} on login and on reload. The same token is sent once.
export interface WorkerLike { postMessage(message: unknown): void }
export interface Bridge { init(token: string): void }

export function createBridge(worker: WorkerLike, wsTickUrl: string): Bridge {
  let sent: string | null = null;
  return {
    init(token) {
      if (token === sent) return;
      sent = token;
      worker.postMessage({ type: 'INIT_AUTH', token, ws_tick_url: wsTickUrl });
    },
  };
}
