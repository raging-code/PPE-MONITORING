"""services/ack_node.py (P24-5c, ADR 0048): `python -m ppe_host.cli ack --node N`, the CLI stop test of design 8 (Host sound files and CLI stop test).
It acknowledges every open, not yet acknowledged alert of one node through the running host: POST /api/alerts/{id}/ack with the operator token, the same route the dashboard uses.
So the host does the work (the engine, the ACK_ALERT audit row with the operator, the AudioThread feed) and this file only finds the alert ids and calls the route.
The ids are read from the database read-only (the same connection rule as doctor); the host is never touched directly. The token comes from the PPE_TOKEN variable, is sent only as the bearer header and is never printed or logged.
Exit codes: 0 all acknowledged, or nothing was open; 1 nothing could be acknowledged (no token, no database, unknown node, host not reachable, token refused); 2 some were acknowledged and some were not."""
import http.client, json, sqlite3, urllib.error, urllib.request
from pathlib import Path
from .doctor import _ro

TOKEN_VAR = 'PPE_TOKEN'
TIMEOUT_S = 5.0

class Fatal(Exception):
    """Nothing more can be sent: the host is unreachable or refused the token."""

def base_url(settings):
    host, port = settings['bind_host'], settings['bind_port']
    if host in ('', '0.0.0.0', '::'): host = '127.0.0.1'      # a wildcard bind address is not an address to connect to; the Host rule of design 4 accepts 127.0.0.1
    return 'http://%s:%d' % (host, port)

def node_alias(db, node):
    """The roster alias of the node, or None when the node is not in the roster."""
    conn = _ro(db)
    try: r = conn.execute('SELECT alias FROM roster WHERE node_id = ?', (node,)).fetchone()
    finally: conn.close()
    return None if r is None else r[0]

def open_alerts(db, node):
    """[(alert_id, type)] of the node's alerts that are open (not cleared) and not acknowledged, oldest first."""
    conn = _ro(db)
    try: return conn.execute('SELECT alert_id, type FROM alerts WHERE node_id = ? AND cleared_ts IS NULL AND acknowledged_ts IS NULL ORDER BY alert_id', (node,)).fetchall()
    finally: conn.close()

def _opener():
    return urllib.request.build_opener(urllib.request.ProxyHandler({}))      # the host is on this machine: never through a proxy from the environment

def _why(e):
    """One line about an HTTP error: the error_code of the host's envelope when it has one. The body never holds the token."""
    try: code = json.loads(e.read().decode('utf-8', 'replace')).get('error_code')
    except (ValueError, AttributeError, OSError): code = None
    return 'HTTP %d%s' % (e.code, ' ' + code if isinstance(code, str) else '')

def post_ack(base, alert_id, token, timeout=TIMEOUT_S, opener=None):
    """Acknowledge one alert. Returns the acknowledged_ts. Raises Fatal when nothing more can be sent (host unreachable, token refused) and ValueError when the host answered with anything else."""
    req = urllib.request.Request('%s/api/alerts/%d/ack' % (base, alert_id), data=b'{}', method='POST', headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        with (opener or _opener()).open(req, timeout=timeout) as r: return json.loads(r.read().decode('utf-8'))['acknowledged_ts']
    except urllib.error.HTTPError as e:
        if e.code == 401: raise Fatal('the token was refused (missing, wrong or disabled operator)')
        raise ValueError(_why(e))
    except (OSError, http.client.HTTPException) as e:                  # URLError, a timeout, a refused or reset connection, a reply that is not HTTP
        raise Fatal('the host did not answer at %s (%s); is it running? python -m ppe_host.cli doctor' % (base, getattr(e, 'reason', e)))
    except (KeyError, TypeError, ValueError):
        raise ValueError('the answer of the host was not an acknowledgement')

def run_ack(db, node, token, base, timeout=TIMEOUT_S, opener=None):
    """(exit code, stdout lines, stderr lines)."""
    out, err = [], []
    if not token: return 1, out, ['ack: set the %s variable to an operator token (create-operator or rotate-token prints one)' % TOKEN_VAR]
    if not Path(db).exists(): return 1, out, ['ack: database file not found: %s' % db]
    try:
        alias = node_alias(db, node)
        if alias is None: return 1, out, ['ack: node %d is not in the roster' % node]
        alerts = open_alerts(db, node)
    except sqlite3.Error as e: return 1, out, ['ack: cannot read %s: %s' % (db, e)]
    if not alerts: return 0, ['ack: node %d (%s): no open alert to acknowledge' % (node, alias)], err
    done = 0
    for alert_id, typ in alerts:
        try: post_ack(base, alert_id, token, timeout, opener)
        except Fatal as e: err.append('ack: node %d (%s): %s' % (node, alias, e)); break
        except ValueError as e: err.append('ack: node %d (%s): alert %d (%s) was not acknowledged: %s' % (node, alias, alert_id, typ, e)); continue
        done += 1; out.append('ack: node %d (%s): acknowledged alert %d (%s)' % (node, alias, alert_id, typ))
    if done: out.append('ack: node %d (%s): %d of %d alert(s) acknowledged' % (node, alias, done, len(alerts)))
    return (0 if done == len(alerts) else 2 if done else 1), out, err
