"""P19b-2: create-operator, rotate-token and disable-operator (design 2.8, 4, 4.1, 8). Real migrated database and a real secrets.json in a temporary PPE_HOME."""
import json, sqlite3
import pytest
from ppe_host import cli
from ppe_host.api import api_rest as R, security as S
from ppe_host.io.db_writer import connect_db, init_event_seq

@pytest.fixture
def env(tmp_path):
    home, db = tmp_path / 'home', tmp_path / 'ops.db'; return home, db
def run(env, *args, capsys=None):
    home, db = env; return cli.main(list(args) + ['--home', str(home), '--db', str(db)])
def token_of(capsys):
    out = capsys.readouterr().out; assert 'shown once' in out; return out.split('TOKEN (shown once, only its hash is stored): ')[1].strip()
def salt(env): return json.loads((env[0] / 'config' / 'secrets.json').read_text())['server_salt']
def rows(env, sql, *p): c = connect_db(env[1], readonly=True); r = c.execute(sql, p).fetchall(); c.close(); return r
def auth(env, tok): return S.Authenticator(env[1], salt(env), 5).authenticate(tok)

def test_create_operator_prints_the_token_once_and_stores_only_its_hmac(env, capsys):
    assert run(env, 'create-operator', '--name', 'Ana') == 0; tok = token_of(capsys)
    r = rows(env, 'SELECT operator_id, display_name, token_hash, active, created_ts, token_issued_ts FROM operators')
    assert len(r) == 1 and r[0][:2] == (1, 'Ana') and r[0][2] == S.hash_token(salt(env), tok) and tok not in r[0][2] and r[0][3] == 1 and r[0][4] == r[0][5] > 0
    assert tok not in (env[0] / 'config' / 'secrets.json').read_text() and auth(env, tok) == R.Operator(1, 'Ana')
def test_create_operator_audits_operator_added_offline_with_session_null_and_event_seq_0(env, capsys):
    run(env, 'create-operator', '--name', 'Ana'); a = rows(env, 'SELECT session_id, event_seq, operator_id, action, node_id, episode_id, reason FROM audit_events')
    assert a == [(None, 0, None, 'OPERATOR_ADDED', None, None, 'operator_id 1')] and init_event_seq(connect_db(env[1], readonly=True)) == 1      # an offline row never moves the event_seq counter
def test_the_salt_is_created_once_and_shared_by_later_operators(env, capsys):
    run(env, 'create-operator', '--name', 'Ana'); t1 = token_of(capsys); s1 = salt(env)
    run(env, 'create-operator', '--name', 'Ben'); t2 = token_of(capsys)
    assert salt(env) == s1 and t1 != t2 and auth(env, t1).display_name == 'Ana' and auth(env, t2).display_name == 'Ben'
def test_a_duplicate_or_empty_name_fails_and_changes_nothing(env, capsys):
    run(env, 'create-operator', '--name', 'Ana'); capsys.readouterr()
    for name in ('Ana', ' Ana ', '', '   '): assert run(env, 'create-operator', '--name', name) == 1
    err = capsys.readouterr(); assert 'TOKEN' not in err.out and len(rows(env, 'SELECT * FROM operators')) == 1 and len(rows(env, 'SELECT * FROM audit_events')) == 1
def test_the_name_is_stripped(env, capsys):
    run(env, 'create-operator', '--name', '  Ana  '); assert rows(env, 'SELECT display_name FROM operators') == [('Ana',)]
def test_a_missing_salt_while_operators_exist_is_refused_and_no_operator_is_added(env, capsys):
    run(env, 'create-operator', '--name', 'Ana'); capsys.readouterr(); (env[0] / 'config' / 'secrets.json').unlink()
    assert run(env, 'create-operator', '--name', 'Ben') == 1 and 'server_salt is missing' in capsys.readouterr().err
    assert len(rows(env, 'SELECT * FROM operators')) == 1 and not (env[0] / 'config' / 'secrets.json').exists()

def test_rotate_token_replaces_the_hash_audits_it_and_spares_the_others(env, capsys):
    run(env, 'create-operator', '--name', 'Ana'); old = token_of(capsys); run(env, 'create-operator', '--name', 'Ben'); ben = token_of(capsys)
    assert run(env, 'rotate-token', '--operator-id', '1') == 0; new = token_of(capsys)
    assert new != old and auth(env, old) is None and auth(env, new) == R.Operator(1, 'Ana') and auth(env, ben) == R.Operator(2, 'Ben')
    assert rows(env, "SELECT session_id, event_seq, action, reason FROM audit_events WHERE action = 'TOKEN_ROTATED'") == [(None, 0, 'TOKEN_ROTATED', 'operator_id 1')]
def test_rotate_token_refuses_unknown_and_disabled_operators_and_a_missing_database(env, capsys, tmp_path):
    run(env, 'create-operator', '--name', 'Ana'); capsys.readouterr(); before = rows(env, 'SELECT token_hash FROM operators')
    assert run(env, 'rotate-token', '--operator-id', '9') == 1 and 'no operator' in capsys.readouterr().err
    run(env, 'disable-operator', '--operator-id', '1'); capsys.readouterr()
    assert run(env, 'rotate-token', '--operator-id', '1') == 1 and 'disabled' in capsys.readouterr().err and rows(env, 'SELECT token_hash FROM operators') == before
    assert cli.main(['rotate-token', '--operator-id', '1', '--home', str(env[0]), '--db', str(tmp_path / 'none.db')]) == 1 and not (tmp_path / 'none.db').exists()
def test_rotate_token_without_the_salt_is_refused_and_keeps_the_old_token(env, capsys):
    run(env, 'create-operator', '--name', 'Ana'); tok = token_of(capsys); s = salt(env); (env[0] / 'config' / 'secrets.json').unlink()
    assert run(env, 'rotate-token', '--operator-id', '1') == 1 and 'server_salt is missing' in capsys.readouterr().err
    (env[0] / 'config' / 'secrets.json').write_text(json.dumps({'server_salt': s})); assert auth(env, tok) is not None and len(rows(env, 'SELECT * FROM audit_events')) == 1

def test_disable_operator_blocks_the_token_at_once_and_audits_once(env, capsys):
    run(env, 'create-operator', '--name', 'Ana'); a = token_of(capsys); run(env, 'create-operator', '--name', 'Ben'); b = token_of(capsys)
    assert run(env, 'disable-operator', '--operator-id', '1') == 0 and rows(env, 'SELECT active FROM operators ORDER BY operator_id') == [(0,), (1,)]
    assert auth(env, a) is None and auth(env, b) is not None and 'is disabled' in capsys.readouterr().out
    assert run(env, 'disable-operator', '--operator-id', '1') == 0 and 'already disabled' in capsys.readouterr().out      # a repeat changes nothing and adds no second row
    assert rows(env, "SELECT session_id, event_seq, action, reason FROM audit_events WHERE action = 'OPERATOR_DISABLED'") == [(None, 0, 'OPERATOR_DISABLED', 'operator_id 1')]
def test_disable_operator_unknown_id_and_missing_database_fail(env, capsys, tmp_path):
    run(env, 'create-operator', '--name', 'Ana'); capsys.readouterr()
    assert run(env, 'disable-operator', '--operator-id', '5') == 1 and 'no operator' in capsys.readouterr().err
    assert cli.main(['disable-operator', '--operator-id', '1', '--home', str(env[0]), '--db', str(tmp_path / 'none.db')]) == 1
def test_the_operator_id_must_be_an_integer(env):
    with pytest.raises(SystemExit): run(env, 'disable-operator', '--operator-id', 'x')
def test_a_failed_audit_insert_rolls_the_operator_change_back(env, capsys, monkeypatch):
    run(env, 'create-operator', '--name', 'Ana'); capsys.readouterr(); c = connect_db(env[1]); c.execute('DELETE FROM audit_actions WHERE action = ?', ('OPERATOR_DISABLED',)); c.close()
    with pytest.raises(sqlite3.IntegrityError): run(env, 'disable-operator', '--operator-id', '1')
    assert rows(env, 'SELECT active FROM operators') == [(1,)]
def test_default_database_comes_from_the_settings_and_a_new_home_works(tmp_path, capsys):
    assert cli.main(['create-operator', '--name', 'Ana', '--home', str(tmp_path)]) == 0 and (tmp_path / 'data' / 'ppe.db').exists() and (tmp_path / 'config' / 'secrets.json').exists()
