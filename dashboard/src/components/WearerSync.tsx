import { useEffect } from 'react';
import { authFetch } from '../api/authfetch.ts';
import { useLive } from '../store/live.ts';
import { loadWearers } from '../store/wearers.ts';
import { readToken } from '../store/token.ts';

// Reads who wears which jacket once the screen is live and every 30 s after, so a change made on another screen shows on the node card (ADR 0071). It renders nothing and
// is mounted by App only: the Shell and its tests never send this request.
export const WEARER_POLL_MS = 30_000;
export default function WearerSync() {
  const live = useLive((s) => s.conn === 'LIVE');
  useEffect(() => {
    if (!live) return;
    const api = { fetchFn: authFetch, getToken: readToken };
    void loadWearers(api);
    const h = setInterval(() => { void loadWearers(api); }, WEARER_POLL_MS);
    return () => clearInterval(h);
  }, [live]);
  return null;
}
