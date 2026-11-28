"""S8-1 (ADR 0070): firefighter profiles with consent, the node assignment, the roster switch, the one-node simulator."""
import sys
from pathlib import Path
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parent))
from ppe_host import abi, cli
from ppe_host.io.db_writer import connect_db, applied_versions
from ppe_host.services import firefighters as F
from ppe_host.services import simulator as S
from test_simulator import KEY, SYS

NOW = 1_800_000_000_000
GOOD = dict(full_name='Sam Example', age_years=34, height_cm=180, weight_kg=82.5, resting_hr=58, smoker=False, consent=True, consent_form_version='v1', consent_witness='Witness One')

@pytest.fixture
def db(tmp_path):
    p = tmp_path / 'live.db'; assert cli.main(['seed-roster', '--db', str(p)]) == 0; c = connect_db(p); yield c; c.close()

def add(c, **over): return F.add_firefighter(c, NOW, **{**GOOD, **over})
def audit(c): return c.execute('SELECT action, node_id, reason FROM audit_events ORDER BY audit_id').fetchall()

def test_migration_0006_adds_the_tables_and_three_audit_actions(db):
    assert applied_versions(db) == [1, 2, 3, 4, 5, 6]
    names = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type IN ('table','index')")}
    assert {'firefighters', 'firefighter_assignments', 'uq_assignment_open_node', 'uq_assignment_open_firefighter', 'idx_assignment_firefighter'} <= names
    a = {r[0] for r in db.execute('SELECT action FROM audit_actions')}
    assert {'FIREFIGHTER_ADDED', 'FIREFIGHTER_ASSIGNED', 'ROSTER_ACTIVE_SET'} <= a and len(a) == 27

def test_add_gives_ffr_aliases_stores_the_profile_and_audits_without_the_name(db):
    assert add(db) == (1, 'FFR-01') and add(db, full_name='Pat Other', sex='F', max_hr=190, years_service=6.5, smoker=True) == (2, 'FFR-02')
    r = db.execute('SELECT alias, full_name, age_years, height_cm, weight_kg, resting_hr, smoker, consent_form_version, consent_witness, active FROM firefighters WHERE firefighter_id = 1').fetchone()
    assert r == ('FFR-01', 'Sam Example', 34, 180, 82.5, 58, 0, 'v1', 'Witness One', 1)
    rows = audit(db); assert [x[0] for x in rows] == ['FIREFIGHTER_ADDED'] * 2 and not any('Sam' in (x[2] or '') or 'Pat' in (x[2] or '') for x in rows)

@pytest.mark.parametrize('over, word', [(dict(consent=False), 'consent'), (dict(consent=None), 'consent'), (dict(consent_witness=' '), 'witness'), (dict(consent_form_version=''), 'form version'), (dict(full_name=''), 'name'),
    (dict(age_years=15), 'age_years'), (dict(height_cm=300), 'height_cm'), (dict(weight_kg=20), 'weight_kg'), (dict(resting_hr=20), 'resting_hr'), (dict(max_hr=58), 'max_hr'), (dict(sex='Q'), 'sex'),
    (dict(consent_date='2999-01-01'), 'future'), (dict(consent_date='28/11/2026'), 'YYYY-MM-DD'), (dict(age_years=None), 'age_years')])
def test_a_bad_profile_is_refused_and_nothing_is_written(db, over, word):
    with pytest.raises(F.FirefighterError, match=word): add(db, **over)
    assert db.execute('SELECT COUNT(*) FROM firefighters').fetchone()[0] == 0 and audit(db) == []

def test_the_database_itself_refuses_a_profile_without_consent_fields(db):
    with pytest.raises(Exception): db.execute("INSERT INTO firefighters(alias, full_name, age_years, height_cm, weight_kg, resting_hr, smoker, consent_ts, consent_form_version, consent_witness, created_ts) VALUES ('x','n',30,170,70,60,0,1,'',  'w', 1)")

def test_consent_date_is_utc_midnight_and_defaults_to_now(db):
    assert F.consent_ts_of('2026-11-28', NOW) == 1795824000000 and F.consent_ts_of(None, NOW) == NOW

def test_assign_replaces_the_wearer_keeps_history_and_ends(db):
    add(db); add(db, full_name='Pat Other')
    assert F.assign(db, NOW, 1, 1) == 'assigned' and F.assign(db, NOW + 1, 1, 1) == 'unchanged'
    assert F.assign(db, NOW + 2, 1, 2) == 'assigned'
    assert db.execute('SELECT firefighter_id, end_ts IS NULL FROM firefighter_assignments ORDER BY assignment_id').fetchall() == [(1, 0), (2, 1)]
    assert F.assign(db, NOW + 3, 1) == 'ended' and F.assign(db, NOW + 4, 1) == 'unchanged'
    assert db.execute('SELECT COUNT(*) FROM firefighter_assignments WHERE end_ts IS NULL').fetchone()[0] == 0
    acts = [(a, n, r) for a, n, r in audit(db) if a == 'FIREFIGHTER_ASSIGNED']; assert acts == [('FIREFIGHTER_ASSIGNED', 1, 'firefighter_id 1'), ('FIREFIGHTER_ASSIGNED', 1, 'firefighter_id 2'), ('FIREFIGHTER_ASSIGNED', 1, 'ended firefighter_id 2')]

def test_assign_refusals(db):
    add(db); F.assign(db, NOW, 1, 1)
    with pytest.raises(F.FirefighterError, match='already assigned to node 1'): F.assign(db, NOW, 2, 1)
    with pytest.raises(F.FirefighterError, match='no firefighter'): F.assign(db, NOW, 2, 9)
    with pytest.raises(F.FirefighterError, match='not in the roster'): F.assign(db, NOW, 7, 1)
    db.execute('UPDATE firefighters SET active = 0'); F.assign(db, NOW, 1)
    with pytest.raises(F.FirefighterError, match='inactive'): F.assign(db, NOW, 1, 1)

def test_the_database_allows_one_open_assignment_per_node_and_per_firefighter(db):
    add(db); add(db, full_name='B'); ins = "INSERT INTO firefighter_assignments(node_id, firefighter_id, start_ts) VALUES (?, ?, 1)"
    db.execute(ins, (1, 1))
    for args in ((1, 2), (2, 1)):
        with pytest.raises(Exception): db.execute(ins, args)

def test_set_roster_switches_nodes_ends_the_assignment_and_keeps_one_node_on(db):
    add(db); F.assign(db, NOW, 2, 1)
    assert F.set_roster_active(db, NOW, 2, 0) == 'changed' and F.set_roster_active(db, NOW, 2, 0) == 'unchanged'
    assert db.execute('SELECT COUNT(*) FROM firefighter_assignments WHERE node_id = 2 AND end_ts IS NULL').fetchone()[0] == 0
    assert F.set_roster_active(db, NOW, 3, 0) == 'changed'
    with pytest.raises(F.FirefighterError, match='last active'): F.set_roster_active(db, NOW, 1, 0)
    with pytest.raises(F.FirefighterError, match='not in the roster'): F.set_roster_active(db, NOW, 9, 1)
    assert db.execute('SELECT node_id FROM roster WHERE active = 1').fetchall() == [(1,)]
    assert [(a, n, r) for a, n, r in audit(db) if a == 'ROSTER_ACTIVE_SET'] == [('ROSTER_ACTIVE_SET', 2, 'active=0'), ('ROSTER_ACTIVE_SET', 3, 'active=0')]

def test_list_hides_the_name_unless_asked(db):
    add(db); F.assign(db, NOW, 1, 1)
    plain, named = F.list_firefighters(db)[0], F.list_firefighters(db, True)[0]
    assert 'full_name' not in plain and named['full_name'] == 'Sam Example' and plain['alias'] == 'FFR-01' and plain['node_id'] == 1 and plain['smoker'] == 0

def test_cli_round_trip_and_the_name_only_with_show_names(tmp_path, capsys):
    p = tmp_path / 'c.db'; assert cli.main(['seed-roster', '--db', str(p)]) == 0; capsys.readouterr(); a = ['--db', str(p)]
    base = ['add-firefighter', '--name', 'Sam Example', '--age', '34', '--height-cm', '180', '--weight-kg', '82.5', '--resting-hr', '58', '--smoker', 'no', '--consent-form-version', 'v1', '--consent-witness', 'W One']
    assert cli.main(base + a) == 1 and 'consent must be given' in capsys.readouterr().err
    assert cli.main(base + ['--consent'] + a) == 0 and 'FFR-01' in capsys.readouterr().out
    assert cli.main(['assign-firefighter', '--node', '1', '--firefighter-id', '1'] + a) == 0
    assert cli.main(['set-roster', '--node', '2', '--active', '0'] + a) == 0 and cli.main(['set-roster', '--node', '3', '--active', '0'] + a) == 0
    capsys.readouterr(); assert cli.main(['set-roster', '--node', '1', '--active', '0'] + a) == 1 and 'last active' in capsys.readouterr().err
    assert cli.main(['list-firefighters'] + a) == 0; out = capsys.readouterr().out; assert 'FFR-01' in out and 'Sam' not in out and 'node_id=1' in out
    assert cli.main(['list-firefighters', '--show-names'] + a) == 0 and 'Sam Example' in capsys.readouterr().out
    assert cli.main(['assign-firefighter', '--node', '1'] + a) == 0 and 'ended' in capsys.readouterr().out
    assert cli.main(['list-firefighters', '--db', str(tmp_path / 'none.db')]) == 1

def frames_of(sched, until_s, step_ms=500):
    out = []
    for t in range(0, until_s * 1000, step_ms): out += [p for k, p in sched.poll(t) if k == 'frame']
    return out

def test_single_scenario_runs_the_three_events_on_one_node():
    s = S.Schedule('single', 1, KEY, SYS, nodes=(1,))
    assert 'single' in S.SCENARIOS and s.nodes == (1,)
    fl = frames_of(s, 420); assert fl and {f.raw[abi.FRAME_FIELDS['id_mode'][0]] & 0x07 for f in fl} == {1}
    sc = {slot: s.sample(1, slot) for slot in range(0, 210)}; t = lambda slot: slot * 2 + s._offset[1] / 1000.0
    assert any(sc[k] is not None and sc[k]['co_x10'] > 2000 for k in sc if t(k) < 150)                                   # the CO ramp reaches danger
    flags_md = S._bits('flags', mandown=1)
    assert any(sc[k] is not None and sc[k]['flags'] & flags_md for k in sc if 150 <= t(k) < 260)                           # the man-down latch
    assert [k for k in sc if sc[k] is None and 280 <= t(k) < 355] and not [k for k in sc if sc[k] is None and t(k) < 270]   # the silence of the link loss, and none before it

def test_the_schedule_makes_frames_only_for_the_nodes_it_is_given():
    s = S.Schedule('rehearsal', 1, KEY, SYS, nodes=(2,)); assert s.nodes == (2,) and set(s.sent) == {2}
    frames_of(s, 30); assert s.sent[2] > 0 and S.Schedule('rehearsal', 1, KEY, SYS).nodes == (1, 2, 3)

def test_the_simulator_thread_and_the_runtime_pass_the_roster_on():
    import inspect
    from ppe_host import runtime
    assert 'nodes' in inspect.signature(S.SimulatorThread.__init__).parameters and 'nodes=tuple(roster)' in inspect.getsource(runtime.Runtime.__init__)
