// Where the dashboard keeps its login token (ADR 0056, P28-5). There is one token slot with two possible homes: sessionStorage
// (the default: gone when the tab closes) or localStorage (a PIN login with "remember me" ticked). A page that has no
// window or a browser that blocks storage simply finds no token.
import { TOKEN_KEY } from './controller.ts';

function areas(): Storage[] {
  const out: Storage[] = [];
  for (const get of [() => window.sessionStorage, () => window.localStorage]) {
    try { out.push(get()); } catch { /* storage blocked by the browser */ }
  }
  return out;
}

// The stored token, from sessionStorage first and then localStorage; null when there is none.
export function readToken(): string | null {
  for (const a of areas()) {
    try { const v = a.getItem(TOKEN_KEY); if (v) return v; } catch { /* unreadable: try the next one */ }
  }
  return null;
}

// Removes the token from both places (log out, 4401, a 401 from the host).
export function clearToken(): void {
  for (const a of areas()) {
    try { a.removeItem(TOKEN_KEY); } catch { /* nothing more to do */ }
  }
}
