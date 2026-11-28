// fetch for every logged-in call (P28-5, ADR 0056). A 401 from the host on an /api call means the stored token or session is no longer
// good: a login session that expired or was ended by Log out, a new PIN, rotate-token or disable-operator. The page is told once and
// shows Login, the same as for close code 4401 on the sockets. The login call itself does not use this, because its 401 means a wrong name, PIN or token.
let lost: (() => void) | null = null;

export function onAuthLost(fn: (() => void) | null): void { lost = fn; }

export function authFetch(...a: Parameters<typeof fetch>): ReturnType<typeof fetch> {
  return fetch(...a).then((res) => {
    if (res.status === 401 && lost) lost();
    return res;
  });
}
