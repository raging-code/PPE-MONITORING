#!/usr/bin/env python3
"""doc_lint.py: consistency checks for the PPE Software Design .docx (Rev 3.45).
Usage: python tools/doc_lint.py PPE_Software_Design_Compact_Rev3_45.docx [0001.sql] [Technical_Summary.docx] [frames.json]
(with no arguments it lints the files of this repository: docs/, host/migrations/0001.sql, shared/vectors/frames.json)
Exit code 0 = all checks pass, 1 = at least one failure. Standard library only (+ lxml-free)."""
import re, sys, json, sqlite3, zipfile
import xml.etree.ElementTree as ET
W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
def paragraphs(path):
    root=ET.fromstring(zipfile.ZipFile(path).read('word/document.xml'))
    out=[]
    for p in root.iter(W+'p'):
        s=[]
        for e in p.iter():
            if e.tag==W+'t': s.append(e.text or '')
            elif e.tag in (W+'br',W+'cr'): s.append('\n')
        out.append(''.join(s))
    return out
def norm(s): return s.replace('“','"').replace('”','"').replace('’',"'").replace('—','---').replace('–','--')
def main(path,sqlpath=None,summarypath=None,framespath=None):
    ps=[norm(x) for x in paragraphs(path)]
    fails=[]
    def fail(msg): fails.append(msg)
    idx=lambda start:next((i for i,p in enumerate(ps) if p.startswith(start)),None)
    h10,h11=idx('10. Consolidated Audit'),idx('11. Frozen Base')
    if None in (h10,h11): fail('section headings 10 or 11 not found'); h10=h11=10**9
    # Rev 3.37: Section 15 was merged into Sections 1 to 14; no Section 15 heading and no dangling 15.n reference may return outside Section 10 (history keeps the old numbers)
    for i,p in enumerate(ps):
        if re.match(r'15\.\d+ [A-Z]|15\. [A-Z]',p): fail(f'Section 15 heading returned in paragraph {i}: {p[:50]}')
        if i<3 or h10<=i<h11 or '"heat_rise_clear_c"' in p: continue  # i<3 = title block and revision history line
        for m in re.finditer(r'Section 15|(?<![\d.])15\.(?:[1-9]|1\d|2[0-2])(?!\d)',p): fail(f'dangling Section 15 reference {m.group()!r} in paragraph {i}: ...{p[max(0,m.start()-40):m.end()+30]}...')
    # 1) stale terms outside history (Section 10) unless the paragraph says it is removed/deleted/replaced
    ok_words=('errata','Deleted','removed','REMOVED','Removed','deleted','replaced')
    # exact known sentences that name a stale term only to say it is gone (no loose waiver words)
    allow=('there is no priority or low-priority lane','so there is no token_expires_ts column','-- Migration 0001 (rewritten in Rev 3.27','a CARRIED_OVER episode state are rejected','Applied: Migration 0001 rewritten (lookup tables')
    stale=['CARRIED_OVER','carried_from_alert_id','audio_unlocked','ALARMS SILENT','Alarms are silent','token_expires_ts','token_grace_h','expired_incident','priority lane','low-priority lane','82 keys','shift+4','shift + 4','AudioWatchdogThread','zero_socket_alarm_s','/api/admin','{id}/ack','full shift replay','full replay from row 1','checkpoints bound','incident exception','checkpoint replay','60 s checkpoint writer','the 6 banners','alerts CHECK constraint','database CHECK constraint','Technical Summary Table 10','false CONFIG_CHANGED full replays','or CONFIG_CHANGED, state rebuilds','and the checkpoint (2.3)','logs CONFIG_CHANGED on the next resume','changing it logs CONFIG_CHANGED','restored from the latest valid checkpoint','Corrupt/missing checkpoint or changed constants_hash','full-width banner until acknowledged','restored into ppe.db']
    for i,p in enumerate(ps):
        if h10<=i<h11: continue
        sents=re.split(r'(?<=[.;])\s+|\n',p)
        for t in stale:
            if t in p and any(t in s_ and not any(w in s_ for w in ok_words) and not any(al in s_ for al in allow) for s_ in sents):
                fail(f'stale term {t!r} in paragraph {i}: ...{p[max(0,p.find(t)-60):p.find(t)+60]}...')
    # 1b) Rev 3.33 completeness checks
    gv={p for p in ps if re.fullmatch(r'GV-\d\d',p)}
    miss=[f'GV-{n:02d}' for n in range(1,28) if f'GV-{n:02d}' not in gv]
    if miss: fail(f'golden vectors missing from 14.4: {miss}')
    if sum(1 for p in ps if p.startswith('Firmware') and '(D-FW' in p)<4: fail('fewer than 4 D-FW rows in Section 8')
    for k in ('advisory_heartbeat_s','audio_check_interval_s','host_chime_interval_min','host_volume_min_pct'):
        if ps.count(k)<1: fail(f'settings key {k} has no settings-table row')
    # 1c) Rev 3.33 checks
    if not any(p.startswith('API endpoint status-code test') for p in ps): fail('API endpoint status-code test row missing')
    for need in ('corrupt stored latch','erased flash','power cut before the write commits','nvs_fault','cancel_no_motion' if False else 'CANCEL with a motionless chest','SCBA prompt deferred' if False else 'an SCBA prompt deferred'):
        if not any(need in p and p.startswith('Pass:') for p in ps): fail(f'D-FW case missing: {need}')
    _cb=[p for p in ps if '"shadow_grace_s"' in p]
    if len(_cb)==1:
        _c=json.loads(_cb[0][_cb[0].find('{'):_cb[0].rfind('}')+1]); _T='\n'.join(ps)
        for k,u in (('co_warn_ppm',' ppm'),('co_warn_clear_ppm',' ppm'),('co_danger_ppm',' ppm'),('co_danger_clear_ppm',' ppm'),('co_warmup_s',' s')):
            if f'{_c[k]:g}{u}' not in _T: fail(f'constants.json {k}={_c[k]:g} no longer appears in the prose as "{_c[k]:g}{u}"')
    if not any(p.startswith('S1b Node firmware') for p in ps): fail('build slice S1b missing')
    if not any(p.startswith('Cut line:') and 'S1b' in p for p in ps): fail('cut line does not include S1b')
    if not any('cleared_ts equal to raised_ts' in p for p in ps): fail('one-shot notice rule missing')
    if not any(p.startswith('One-shot notice test') for p in ps): fail('one-shot notice test row missing')
    # 1d) Rev 3.35 checks
    if not any(p.startswith('10.9 Rev 3.35') for p in ps): fail('10.9 Rev 3.35 log missing')
    if not any(p.startswith('S1b Node firmware') and 'fw_scenarios.json' in p for p in ps): fail('S1b does not name shared/vectors/fw_scenarios.json')
    # 1e) Rev 3.36 checks
    _T2='\n'.join(ps)
    _logs=[(int(m.group(1)),m.group(2)) for p in ps for m in [re.match(r'10\.(\d+) Rev (3\.\d+) application log',p)] if m]
    _rv=[re.search(r'Compact --- Rev (3\.\d+)',ps[0]),re.search(r'Baseline status \(Rev (3\.\d+)',_T2)]
    _last=max(_logs)[1] if _logs else None
    if not all(_rv) or len({m.group(1) for m in _rv}|{_last})!=1: fail('revision strings disagree (title, baseline status, last Section 10 application log): '+str([m.group(1) if m else None for m in _rv]+[_last]))
    if not any(p.startswith('10.10 Rev 3.36') for p in ps): fail('10.10 Rev 3.36 log missing')
    if _T2.count('write_rejected')<3: fail('write_rejected rule missing or incomplete')
    if 'DROP TRIGGER trg_frames_roster; create the new roster table' not in _T2: fail('Tier 2 roster rebuild order missing')
    if 'aborts at insert (trg_frames_roster)' not in _T2: fail('roster trigger test text missing from the D1 row')
    if 'an injected constraint failure at the head of the queue' not in _T2: fail('write-failure test text missing from the D8 row')
    # 1f) Rev 3.38 checks
    if 'Per-node state saved every 60 s' in _T2: fail('stale per-node 60 s state wording returned (checkpoints are dormant in Tier 1)')
    if 'Token expiry or login failure' in _T2: fail('hazard H20 names token expiry again')
    if not any(p.startswith('10.12 Rev 3.38') for p in ps): fail('10.12 Rev 3.38 log missing')
    if summarypath:
        _sp=[norm(x) for x in paragraphs(summarypath)]; _ST='\n'.join(_sp)
        for _bad in ('watermark checkpoint','replays from the latest valid','Token expiry or login failure','A token expires during a long incident','every 60 s for'):
            if _bad in _ST: fail(f'Technical Summary still contains stale text: {_bad!r}')
        if not re.search(r'REVISION \d\.\d\.\d+',_ST): fail('Technical Summary revision line not found')
    # 1g) Rev 3.39 checks
    if 'Rev 3.26 is the last design revision before code' in _T2: fail('stale freeze sentence returned in 13.1')
    if 'Humidity byte when the SHT40 fails' not in _T2: fail('humidity-byte open decision missing from 9.1')
    # 1h) Rev 3.40 checks
    for need in ('10.14 Rev 3.40','test_db_path','Rebuild rule (Rev 3.40)','Rebuild mode (Rev 3.40)','GET /api/events','host_power,audio_fault}','"audio_fault":false','(g) raises co_threshold at DANGER','tzdata'):
        if need not in _T2: fail(f'Rev 3.40 text missing: {need!r}')
    _kb=[p for p in ps if '"shadow_grace_s"' in p]
    if len(_kb)==1:
        _kc=json.loads(_kb[0][_kb[0].find('{'):_kb[0].rfind('}')+1])
        for k in ('scba_confirm_s','scba_confirm_high_co_s','scba_response_s','resend_wait_ms','node_min_send_gap_ms','evt_slot_ms','evt_jit_ms','beacon_period_s','lbt_backoff_min_ms','lbt_backoff_max_ms','unresolved_pulse_s','unresolved_label_s','host_alarm_budget_ms','counters_interval_s'):
            if k not in _kc: fail(f'constants.json block lacks {k}')
    if 'carries only the constants the dashboard needs' in _T2: fail('snapshot constants contradiction returned (12.1)')
    if 'at http://localhost. TLS' in _T2: fail('3.7 dashboard URL lost its port')
    _bo=re.search(r'co_threshold \(DANGER, badge_order=(\d+)\)',_T2)
    # 1i) Rev 3.41 checks
    for need in ('10.15 Rev 3.41','F-23 (GV-18g)','CREATE VIEW v_events','config_hash_changed','stale_30min','db_restored','serial_port, db_path, test_db_path','passing all 28 frame and beacon test vectors','24 frames and 4 beacons','F-01 to F-24','the selected database file','SIMULATOR and REPLAY use the same lockfile','EXPLAIN QUERY PLAN of the GET /api/events query'):
        if need not in _T2: fail(f'Rev 3.41 text missing: {need!r}')
    if framespath:
        _fj=json.load(open(framespath,encoding='utf8'))
        _docline={m.group(1):(m.group(2),m.group(3)) for p in ps for m in [re.match(r'([FB]-\d\d)(?: \(([^)]*)\))? ([0-9a-f]+)',p)] if m}
        for _e in _fj['frames']+_fj['beacons']:
            _d=_docline.get(_e['id'])
            if not _d: fail(f"{_e['id']} is in frames.json but has no line in 14.4")
            elif _d[1]!=_e['hex']: fail(f"{_e['id']} hex differs between 14.4 and frames.json")
            elif _e['id'].startswith('F-') and _d[0]!=_e.get('gv'): fail(f"{_e['id']} label {_d[0]!r} differs from frames.json gv {_e.get('gv')!r}")
        for _k in _docline:
            if _k not in {e['id'] for e in _fj['frames']+_fj['beacons']}: fail(f'{_k} is in 14.4 but not in frames.json')
        if len(_fj['frames'])!=24 or len(_fj['beacons'])!=4: fail(f"frames.json holds {len(_fj['frames'])} frames and {len(_fj['beacons'])} beacons (design says 24 and 4)")
    # 1k) Rev 3.43 checks (portability and packaging)
    for need in ('10.17 Rev 3.43','PPE_HOME','config/settings.local.json','Release bundle and doctor (Rev 3.43','ppe_host.cli doctor','core/ imports nothing from io/','serial_port may be the value auto'):
        if need not in _T2: fail(f'Rev 3.43 text missing: {need!r}')
    if 'serial_baud' in _T2 and 'serial_port, db_path, test_db_path' not in _T2: fail('hash exclusion list changed unexpectedly')
    # 1l) Rev 3.44 checks (consistency fixes to the Rev 3.43 text)
    for need in ('10.18 Rev 3.44','host/migrations/ (0001.sql, 0002.sql)','(1) resolve PPE_HOME, load config/settings.json, apply the config/settings.local.json override','copied to dashboard/dist/ inside the release folder','dashboard/dist/index.html present'):
        if need not in _T2: fail(f'Rev 3.44 text missing: {need!r}')
    _T3='\n'.join(p for i,p in enumerate(ps) if not (h10<=i<h11 or i<3))  # outside the history entries, which may name the old file names
    for bad in ('0001_init','0002_tier2_ml','(1) load settings.json & secrets.json'):
        if bad in _T3: fail(f'stale Rev 3.43 text returned: {bad!r}')
    for _m in re.finditer(r'\b000\d\w*\.sql\b',_T3):
        if _m.group() not in ('0001.sql','0002.sql'): fail(f'migration file name {_m.group()!r} is not 0001.sql or 0002.sql')
    # 1m) Rev 3.45 checks (signed temperature, F-24, freeze wording)
    for need in ('10.19 Rev 3.45','temp_x100 is a signed 16-bit little-endian value','Raw degrees C x100 (signed, may be negative)','F-24 (D1)','Spec freeze: Rev 3.45 is the last design revision before code'):
        if need not in _T2: fail(f'Rev 3.45 text missing: {need!r}')
    if 'Spec freeze: Rev 3.43 is' in _T2: fail('stale Rev 3.43 freeze sentence returned in 13.1')
    if framespath:
        _t24=[e for e in _fj['frames'] if e['id']=='F-24']
        if not _t24 or _t24[0]['expect']['decoded']['temp_x100']>=0: fail('frames.json lacks a vector with a negative temp_x100 (F-24)')
    # 1j) Rev 3.42 checks
    for need in ('10.16 Rev 3.42','anchor_ts','Accepted over-alarm (Rev 3.42','Not in settings_hash','defined once, in shared/constants.json','the first-seen rules of the Sequence classifier above and of 14.1'):
        if need not in _T2: fail(f'Rev 3.42 text missing: {need!r}')
    for bad in ('constants_hash on resume, is ignored','first-seen rules of 2.3','serial_baud (115200), db_path'):
        if bad in _T2: fail(f'stale Rev 3.41 text returned: {bad!r}')
    _mv=re.search(r'Host-only, moved to settings\.json: ([a-z0-9_, ]+)\.',_T2)
    _nohash=('host_alarm_budget_ms','checkpoint_interval_s','checkpoint_max_bytes','host_budget_ms','dashboard_budget_ms','recovering_target_s','host_bat_warn_pct','host_disk_min_gb','supervisor_restart_target_s')
    if not _mv: fail('move list (Host-only, moved to settings.json) not found in 12.1')
    else:
        for _k in [k.strip() for k in _mv.group(1).split(',')]+['checkpoint_interval_s']:
            _ix=[i for i,p in enumerate(ps) if p==_k]
            if len(_ix)!=1: fail(f'settings key {_k} needs exactly one settings-table row (found {len(_ix)})'); continue
            _used=ps[_ix[0]+2] if _ix[0]+2<len(ps) else ''
            if (_k in _nohash)!=('Not in settings_hash' in _used): fail(f'settings row {_k}: Not in settings_hash marker is wrong for its hash scope')
        _c1=[json.loads(p[p.find('{'):p.rfind('}')+1]) for p in ps if '"shadow_grace_s"' in p]
        if _c1 and 'serial_baud' in ' '.join(p for p in ps if p.startswith('One settings file')): fail('serial_baud is listed in the settings file keys and in constants.json')
    # 2) every host alarm time budget is 300 ms
    for i,p in enumerate(ps):
        if h10<=i<h11: continue
        for m in re.finditer(r'host alarm[^.;()]{0,80}?within (\d+) ?ms',p):
            if m.group(1)!='300': fail(f'host alarm budget {m.group(1)} ms (want 300) in paragraph {i}')
    # 3) constants block
    cp=[p for p in ps if '"shadow_grace_s"' in p]
    if len(cp)!=1: fail('constants JSON block not found exactly once')
    else:
        t=cp[0]; c=json.loads(t[t.find('{'):t.rfind('}')+1])
        for k in ('shift_duration_h','retry_buffer_max','token_grace_h','token_expiry_warn_min','sound_check_interval_min','sound_check_amber_min','no_audio_alarm_s'):
            if k in c: fail(f'constants block still has deleted key {k}')
    # 4) alert catalog
    ap=[p for p in ps if '"type":"host_power"' in p]
    if len(ap)!=1: fail('alert catalog block not found exactly once'); cat=[]
    else:
        t=ap[0]; cat=json.loads(t[t.find('[{'):t.rfind(']')+1])
        owners=[e['owner'] for e in cat]
        if owners.count('alerts')!=25 or owners.count('system_banner')!=7: fail(f'catalog has {owners.count("alerts")} alerts and {owners.count("system_banner")} banners (want 25 and 7)')
        if len({e['badge_order'] for e in cat})!=len(cat): fail('duplicate badge_order in catalog')
        for e in cat:
            if not set(e['allowed_levels'])<=set(e['sound_by_level']): fail(f"catalog {e['type']}: a level has no sound")
        files={v for e in cat for v in e['sound_by_level'].values()}-{'none','siren_60s_silence'}
        print('host sound files needed:',sorted(files))
        if _bo and int(_bo.group(1))!={e['type']:e['badge_order'] for e in cat}['co_threshold']: fail('badge test row names a co_threshold badge_order that differs from the catalog')
    # 5) DDL
    dp=[p for p in ps if p.startswith('-- Migration 0001')]
    if len(dp)!=1: fail('DDL block not found exactly once')
    else:
        db=sqlite3.connect(':memory:'); db.execute('PRAGMA foreign_keys=ON')
        try:
            db.executescript(dp[0])
            _ix=db.execute("select sql from sqlite_master where name='idx_alerts_one_open_per_node_type'").fetchone()[0]
            for _t in ('wrist_open','button_stuck','missed_event','co_warmup'):
                if f"'{_t}'" not in _ix: fail(f'unique open index does not cover {_t}')
            seeds=[db.execute(f'select count(*) from {t}').fetchone()[0] for t in ('alert_types','audit_actions','system_event_types')]
            if seeds!=[25,18,29]: fail(f'lookup seeds {seeds} (want 25, 18, 29)')
            if db.execute('PRAGMA foreign_key_check').fetchall(): fail('foreign_key_check not empty')
            db.execute('select * from v_full_log').fetchall()
            _vs=db.execute("select sql from sqlite_master where name='v_events'").fetchone()
            if not _vs: fail('view v_events missing')
            else:
                if re.search(r'FROM\s+frames',_vs[0]): fail('v_events reads the frames table')
                if 'ORDER BY' in _vs[0]: fail('v_events has an ORDER BY (the API query adds it)')
                _pl=' '.join(str(r[3]) for r in db.execute('explain query plan select * from v_events where event_seq>1000 order by event_seq, log_ts limit 200'))
                if 'frames' in _pl: fail('GET /api/events query plan touches frames: '+_pl)
                if len(db.execute('select * from v_events').description)!=9: fail('v_events must have 9 columns')
            _tr=db.execute("select sql from sqlite_master where type='trigger' and name='trg_frames_roster'").fetchone()
            if not _tr: fail('trigger trg_frames_roster missing')
            else:
                _d=sqlite3.connect(':memory:'); _d.execute('PRAGMA foreign_keys=ON'); _d.executescript(dp[0])
                _d.execute("insert into roster values(1,'A',1)")
                _d.execute("insert into sessions(session_id,started_ts,mode,host_build,constants_hash,settings_hash) values(1,0,'LIVE','b','c','s')")
                def _ins(n,v,i): _d.execute("insert into frames(event_seq,session_id,node_id,rx_ts,rx_mono,verify,base_verify,seq_class,raw_hex,backend_ms) values(?,1,?,0,0,?,'OK','fresh','00',0)",(i,n,v))
                _ins(1,'OK',1)
                for _n in (0,2):
                    try: _ins(_n,'OK',10+_n); fail(f'trigger let an OK frame with node_id {_n} (not in roster) in')
                    except sqlite3.IntegrityError: pass
                try: _ins(0,'BAD_MAC',20); _ins(9,'BAD_CRC',21)
                except Exception as e: fail(f'trigger blocks a diagnostic frame: {e}')
            # Rev 3.40: every kind and action the prose writes must exist, and the close_session transactions must run
            _k={r[0] for r in db.execute('select kind from system_event_types')}; _a={r[0] for r in db.execute('select action from audit_actions')}
            for _x in ('HOST_START','RECOVERING_ENTER','RECOVERING_EXIT','HOST_GAP','CONFIG_CHANGED','INTEGRITY_FAIL','LOGGING_FAULT','AUDIO_FAULT','AUDIO_OK','SESSION_ABANDONED','CLEAN_SHUTDOWN','CLIENT_DROPPED','COUNTERS'):
                if _x not in _k: fail(f'system_event_types lacks {_x}')
            for _x in ('END_SHIFT','SESSION_PURGED','DB_RESTORED','BANNER_ACK','SCBA_CORRECTION','EPISODE_ESCALATED'):
                if _x not in _a: fail(f'audit_actions lacks {_x}')
            _c=sqlite3.connect(':memory:'); _c.execute('PRAGMA foreign_keys=ON'); _c.executescript(dp[0])
            _c.execute("insert into sessions(session_id,started_ts,mode,host_build,constants_hash,settings_hash) values(1,0,'LIVE','b','c','s')")
            try:
                for _kind in ('CLEAN_SHUTDOWN','SESSION_ABANDONED'):
                    _c.execute("insert into system_events(session_id,event_seq,ts,kind) values(1,?,0,?)",(1 if _kind=='CLEAN_SHUTDOWN' else 2,_kind))
                _c.execute("update sessions set ended_ts=9,end_kind='CLEAN_SHUTDOWN' where session_id=1")
            except Exception as e: fail(f'close_session probe failed: {e}')
            _e=sqlite3.connect(':memory:'); _e.execute('PRAGMA foreign_keys=ON'); _e.executescript(dp[0])
            _e.execute("insert into roster values(1,'A',1)"); _e.execute("insert into operators values(1,'o','h',1,0,0)")
            _e.execute("insert into sessions(session_id,started_ts,mode,host_build,constants_hash,settings_hash) values(1,0,'LIVE','b','c','s')")
            def _bad(sql,what):
                try: _e.execute(sql); fail(what+' was accepted')
                except sqlite3.IntegrityError: pass
            _bad("update sessions set ended_ts=5 where session_id=1",'a session with ended_ts but no end_kind')
            _bad("update sessions set end_kind='ENDED' where session_id=1",'a session with end_kind but no ended_ts')
            _e.execute("update sessions set ended_ts=5,end_kind='ENDED' where session_id=1")
            _e.execute("insert into episodes(session_id,node_id,kind,opened_ts,state) values(1,1,'MAYDAY',0,'OPEN')")
            _bad("update episodes set state='RESOLVED',resolve_reason='rescued',resolved_by=1",'a RESOLVED episode with no resolved_ts')
            _bad("update episodes set resolved_ts=9",'an OPEN episode with resolved_ts')
            _e.execute("update episodes set state='RESOLVED',resolve_reason='rescued',resolved_by=1,resolved_ts=9")
            if sqlpath:
                _n=lambda s:re.sub(r'\s+','',s)
                if _n(dp[0])!=_n(open(sqlpath,encoding='utf8').read()): fail('DDL in the document differs from '+sqlpath)
            if cat and {r[0] for r in db.execute('select type from alert_types')}!={e['type'] for e in cat if e['owner']=='alerts'}: fail('alert_types differs from alert_catalog.json')
        except Exception as e: fail(f'DDL error: {e}')
    for f in fails: print('FAIL:',f)
    print('doc_lint:', 'FAILED (%d)'%len(fails) if fails else 'all checks passed')
    return 1 if fails else 0
if __name__=='__main__':
    _a=sys.argv[1:5]
    if not _a:  # repo default (P1): no arguments lints this repository's own files
        import os; _r=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        _a=[os.path.join(_r,'docs','PPE_Software_Design_Compact_Rev3_45.docx'),os.path.join(_r,'host','migrations','0001.sql'),os.path.join(_r,'docs','PPE_Monitoring_System_Compact_Technical_Summary_Rev2_9_11.docx'),os.path.join(_r,'shared','vectors','frames.json')]
    sys.exit(main(*(_a+[None]*(4-len(_a)))))
