// patches/part28_1_pin_login_docs.mjs  (run from repo root: node patches/part28_1_pin_login_docs.mjs [--dry] [--force])
// P28 Part 1 (ADR 0056): documents the PIN login, login sessions and "remember me" change. Docs only: no code, wire, setting or migration change.
// New: docs/adr/0056.md.
// Edited (single-line anchors, one change each): docs/design/s04.md (Failed logins row, two new table rows, new section 4.2 appended), docs/design/s03-8.md (login line pointer, PIN login addendum appended),
//   docs/design/s02-3.md (Migration 0003 note after the frozen actions), docs/PROGRESS.md (one bullet appended).
// Safe to run twice (a change that is already there is skipped). CRLF files keep their CRLF. --dry writes nothing.
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd(), DRY = process.argv.includes('--dry'), FORCE = process.argv.includes('--force');
const abs = (p) => path.join(ROOT, p), plan = [];
const put = (p, content) => plan.push({ op: 'put', p, content });
const replace = (p, o, n) => plan.push({ op: 'replace', p, o, n });
const append = (p, text) => plan.push({ op: 'append', p, text });
const eolOf = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
const toEol = (t, e) => t.replace(/\r\n/g, '\n').replace(/\n/g, e);
const lf = (s) => s.replace(/\r\n/g, '\n');
function apply() {
  const state = new Map(), log = [];
  const get = (p) => (state.has(p) ? state.get(p) : fs.existsSync(abs(p)) ? fs.readFileSync(abs(p), 'utf8') : null);
  for (const s of plan) {
    const cur = get(s.p);
    if (s.op === 'put') {
      if (cur !== null && lf(cur) !== lf(s.content) && !FORCE) throw new Error(`EXISTS (use --force): ${s.p}`);
      log.push(`${cur === null ? 'create   ' : lf(cur) === lf(s.content) ? 'unchanged' : 'overwrite'} ${s.p}`);
      state.set(s.p, s.content);
    } else if (cur === null) throw new Error(`MISSING file: ${s.p} (run the earlier parts first, and run from the repo root)`);
    else if (s.op === 'replace') {
      const e = eolOf(cur), o = toEol(s.o, e), n = toEol(s.n, e), c = cur.split(o).length - 1;
      if (cur.includes(n)) log.push(`skip      ${s.p} (already applied)`);
      else if (c === 1) { state.set(s.p, cur.replace(o, () => n)); log.push(`edit      ${s.p}`); }
      else throw new Error(`ANCHOR found ${c} times in ${s.p}: ${s.o.slice(0, 70)}`);
    } else if (s.op === 'append') {
      const e = eolOf(cur), t = toEol(s.text, e);
      if (cur.includes(t.trim())) log.push(`skip      ${s.p} (already appended)`);
      else { state.set(s.p, cur + (cur.endsWith('\n') ? '' : e) + t); log.push(`append    ${s.p}`); }
    }
  }
  if (!DRY) for (const [p, c] of state) { fs.mkdirSync(path.dirname(abs(p)), { recursive: true }); fs.writeFileSync(abs(p), c); }
  console.log(log.join('\n') + (DRY ? '\n(dry run: nothing written)' : '\ndone'));
}

// ---- 1. ADR 0056 (new file)
put('docs/adr/0056.md', `# ADR 0056: PIN login, login sessions and "remember me" (Part 28)

Status: Proposed (the four decisions below are the suggested defaults; confirm them or change them before P28-3).
Design: Rev 3.45 (the .docx) stays frozen. This ADR is a deliberate change to design 4 (operators and security), 3.8 (login endpoint, close codes) and 2.3 (audit actions, operators). The Markdown extracts in docs/design are updated by P28-1; fold the change into the next design revision. Nothing is built by this ADR: P28-2 adds Migration 0003, P28-3 to P28-6 add the code.

- **Problem.** The dashboard asks for the 32-character operator token on every new tab or browser start (sessionStorage, by design). Nobody can memorize it, and copying it each time is slow during a shift.
- **Decision.** A second login form: display name + PIN. A correct PIN returns a random session token with an expiry. The browser keeps that token in sessionStorage (default) or localStorage ("remember me" ticked). The operator token stays as the admin and break-glass login, with no expiry and no lockout.
- **Decision 1, session lifetime.** 12 hours, settings key \`session_hours\` (default 12, allowed 1 to 24). The same expiry with or without "remember me".
- **Decision 2, PIN.** Digits only, 6 to 12 of them. Stored only as a salted scrypt hash (hashlib.scrypt, n=16384, r=8, p=1, 16-byte random salt per operator) in \`operators.pin_hash\` and \`pin_salt\`, compared with hmac.compare_digest. Never in the browser, logs, CSV, audit rows or settings. A login for an unknown name, a wrong PIN, an operator without a PIN and a disabled operator all give the same 401, and the unknown-name case still spends a scrypt verification, so the answer does not reveal which names exist.
- **Decision 3, failed PINs and the s04 rule.** Design 4 says a lockout must not blind the incident commander. So: per operator, \`pin_fails\` counts consecutive failures; the answer carries \`retry_after_s\` with a delay that doubles from 1 s to a cap of 5 s (the same backoff as today); after 5 consecutive failures \`pin_locked_until\` is set 15 minutes ahead and LOGIN_LOCKED is written once; the lock clears itself and a correct PIN resets the count. The lock applies to the PIN form only: the operator token is never locked, so the commander always has a way in. The host listens on 127.0.0.1 only, so only someone on the station can try PINs.
- **Decision 4, remember me.** Off by default and chosen by the operator at each login. The host stores the choice in \`login_sessions.remember\` (audit only); the browser decides the storage. Log out revokes the session on the host and clears both storages.
- **Session token.** secrets.token_urlsafe(24), stored as the HMAC-SHA256 with server_salt (the rule of 4.1) in \`login_sessions.token_hash\`, with created_ts, expires_ts and revoked_ts. The table is called login_sessions because \`sessions\` already means a monitoring shift.
- **Authentication.** \`authenticate()\` accepts an operator token (as today) or a session token whose row is not revoked, not expired and whose operator has active = 1. Every call reads the database, as today. Disabling an operator, rotating its token and setting a new PIN revoke all of its sessions at once.
- **Wire.** POST /api/login keeps the {token} form and gains {display_name, pin, remember}; new POST /api/logout. The WebSocket auth frame and the Authorization header carry a session token exactly like a token. An expired or revoked session closes the socket with 4401, as today. No new error code, no new WS message, no change to the 4401 rule.
- **Audit.** Migration 0003 adds PIN_SET (CLI, session_id NULL), LOGOUT and LOGIN_LOCKED to audit_actions (18 to 21). LOGIN_OK and LOGIN_REJECTED are reused for the PIN form, with the reason \`pin\` or \`token\`.
- **CLI.** \`set-pin --operator-id N\` reads the PIN twice with getpass (no --pin argument, so it never reaches a shell history), never prints it and never logs it. create-operator is unchanged and still issues the long token.
- **Risk.** On a shared station, "remember me" means whoever uses that browser acts as that operator, and audit_events names that operator. Mitigations: off by default, 12 hours, Log out at shift change, and a \`cli doctor\` row for operators without a PIN (P28-6). Expired rows are kept for the audit trail; a purge is left open.
- **Parts.** P28-1 docs and this ADR. P28-2 Migration 0003 (operators gains pin_hash, pin_salt, pin_fails, pin_locked_until, pin_set_ts; table login_sessions; three audit actions). P28-3 PIN and session logic in api/security.py. P28-4 endpoints and the set-pin CLI. P28-5 dashboard login screen, storage choice, Log out. P28-6 Playwright test, doctor row, close-out.
- **Progress.** P28-1 done. P28-2 to P28-6 not done.
- **Checked here.** Nothing is run: this part changes Markdown only.
- **Open, please confirm.** (1) 12 hours. (2) 6 to 12 digits. (3) The self-clearing 15-minute lock with the operator token as break-glass. (4) Remember me off by default.
`);

// ---- 2. design 4 (docs/design/s04.md)
replace('docs/design/s04.md', 'Use a short delay between attempts instead. | Spec (rejection, D8), Proposed (logging, delay) |',
  'Use a short delay between attempts instead (for the PIN form of 4.2 the delay grows per operator and a lock clears itself after 15 minutes; the operator token is never locked, ADR 0056). | Spec (rejection, D8), Proposed (logging, delay) |');
replace('docs/design/s04.md', '| System key | One random 16-byte key',
  `| PIN login | (ADR 0056, Proposed) Display name + a PIN of 6 to 12 digits. The PIN is stored only as a salted scrypt hash in operators.pin_hash; never in the browser, logs, CSV or audit rows. The operator token keeps working as the admin and break-glass login. | Proposed |
| Login session | (ADR 0056, Proposed) A correct PIN returns a random session token (secrets.token_urlsafe(24)), stored as its HMAC-SHA256 in login_sessions with an expiry (default 12 h). Log out, disabling the operator, rotating the token and setting a new PIN revoke it. | Proposed |
| System key | One random 16-byte key`);
append('docs/design/s04.md', `
### 4.2 PIN login and login sessions (ADR 0056, Proposed)

Tier 1 operator tokens still have no expiry (4.1). A login session is different: it is made by a correct PIN and ends at its expiry (session_hours, default 12), at Log out, or when its operator is disabled, gets a new token or a new PIN.

- Login: display name + PIN (digits, 6 to 12). Unknown name, wrong PIN, no PIN set and disabled operator all answer the same 401.
- Failed PINs: the answer carries retry_after_s (1 s doubling to a cap of 5 s). After 5 consecutive failures the operator's PIN login is locked for 15 minutes (LOGIN_LOCKED, once). The lock clears itself. The operator token is never locked, so a lock cannot blind the incident commander (4, Failed logins).
- Remember me: off by default. Ticked, the browser keeps the session token in localStorage; otherwise in sessionStorage as before. The expiry is the same.
- Shared station: whoever uses a browser with a remembered session acts as that operator. Log out at shift change.
- Set a PIN: CLI only (set-pin), written to audit_events as PIN_SET. There is no PIN reset from the dashboard.
`);

// ---- 3. design 3.8 (docs/design/s03-8.md)
replace('docs/design/s03-8.md', '• POST /api/login — Req: {token: str} -> 200 {operator_id, display_name, session_id} (logs LOGIN_OK)',
  '• POST /api/login — Req: {token: str} -> 200 {operator_id, display_name, session_id} (logs LOGIN_OK) (ADR 0056 adds a name + PIN form; see the PIN login addendum at the end of this file)');
append('docs/design/s03-8.md', `
PIN login addendum (ADR 0056, Proposed; Rev 3.45 itself is unchanged)
• PIN form of the login call (POST /api/login) — Req: {display_name: str, pin: str, remember: bool} -> 200 {operator_id, display_name, session_id, session_token, expires_ts} (logs LOGIN_OK, reason pin). The {token} form keeps its answer and returns no session_token. 401 UNAUTHENTICATED for an unknown name, a wrong PIN, an operator without a PIN and a disabled operator, with retry_after_s (1 s doubling to a cap of 5 s); after 5 consecutive failures the PIN form is locked for 15 minutes (logs LOGIN_LOCKED once). The token form is never locked. 403 as before.
• Log out call (POST /api/logout; the frozen endpoint list above is unchanged until P28-4) — Req: none -> 200 {} ; revokes the login session of the bearer (logs LOGOUT). With an operator token there is nothing to revoke and the answer is still 200.
• The session token travels where a token travels: Authorization: Bearer on REST and the first auth frame on /ws and /ws/tick. A session that is expired or revoked, or whose operator is disabled, gives 401 on REST and close 4401 on the sockets, and the dashboard clears sessionStorage and localStorage and shows Login.
• The dashboard keeps the session token in sessionStorage, or in localStorage when "remember me" is ticked (off by default). INIT_AUTH to the Web Worker is unchanged.
• No new error code and no new WebSocket message.
`);

// ---- 4. data model (docs/design/s02-3.md)
replace('docs/design/s02-3.md', 'DB_RESTORED (start-up restore of a verified backup, session_id NULL).',
  `DB_RESTORED (start-up restore of a verified backup, session_id NULL).

- Added after the freeze (Migration 0003, ADR 0056, Proposed): the audit actions PIN_SET (offline set-pin CLI, session_id NULL), LOGOUT and LOGIN_LOCKED (seed 18 to 21); operators gains pin_hash, pin_salt, pin_fails, pin_locked_until and pin_set_ts (all NULL or 0 for an existing operator); a new table login_sessions (login_session_id PK, operator_id FK NOT NULL, token_hash UNIQUE NOT NULL, created_ts, expires_ts, remember, revoked_ts). Migration 0001 is untouched.`);

// ---- 5. progress
append('docs/PROGRESS.md', '- Part 28-1 done (ADR 0056): docs only. PIN login with login sessions and "remember me" is recorded as Proposed in docs/adr/0056.md, docs/design/s04.md (4, new 4.2), s03-8.md (PIN login addendum) and s02-3.md (Migration 0003 note). Decisions to confirm: 12 h session, 6 to 12 digit PIN, self-clearing 15-minute PIN lock with the operator token never locked (keeps the design 4 rule), remember me off by default. Rev 3.45 (.docx) and doc_lint are untouched; no code, wire, setting or migration change yet. P28-2 to P28-6 not done.\n');

apply();
