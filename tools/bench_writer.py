#!/usr/bin/env python3
"""tools/bench_writer.py — the 130,000-frame write-commit benchmark of CODING_GUIDE.md Section 6:
"decides synchronous=FULL or WAL: keep FULL if commit p99 with antivirus running is 50 ms or less,
otherwise WAL with synchronous=NORMAL". Run on the actual field laptop, with antivirus running as it
normally would during a shift, not in this sandbox or on a developer machine.

This is a standalone script, NOT a host feature. It is not part of ppe_host, not imported by it, and
it is not wired into the CLI, CI, or justfile. It is meant to be run once (or a few times, to compare
disks or settings) and the printed numbers copied into an ADR by a person, per Section 6's own rule
that this decision is "not for chat".

What it does:
  1. Builds a throwaway copy of the real schema with the repo's own migration runner
     (host/ppe_host/io/db_writer.py: connect_db, run_migrations), so the table layout, indexes,
     triggers and CHECK constraints are exactly what the host would write against — not a stand-in.
  2. Seeds the roster (nodes 1-3) the same way `cli seed-roster` does, and opens one session row,
     because the frames table has foreign keys to both.
  3. Inserts 130,000 realistic frame rows one at a time, each in its own BEGIN IMMEDIATE / COMMIT
     (one frame = one unit, matching how DBWriter commits a routine frame), timing each commit with
     a monotonic clock. This is run twice back to back on the same machine and disk:
       - PRAGMA synchronous=FULL   (the current default; host/ppe_host/io/db_writer.py connect_db)
       - PRAGMA journal_mode=WAL, PRAGMA synchronous=NORMAL   (the alternative the guide names)
  4. Prints p50, p95, p99 and max commit time for each, plus a pass/fail line against the 50 ms p99
     gate, and writes the full set of per-commit timings to a .csv next to the script so they can be
     plotted or attached to an ADR.

Usage (from the repo root, with the host package importable — i.e. run from inside host/, or with
host/ on PYTHONPATH):

    cd host
    python ../tools/bench_writer.py
    python ../tools/bench_writer.py --frames 130000 --out bench_results.csv
    python ../tools/bench_writer.py --frames 5000          # a quick smoke run first

Run it with the laptop doing what it will do during a real shift: antivirus on, on battery if that is
how it will be used, with whatever else normally runs in the background. Run it on the real target
disk (internal SSD/HDD), not a RAM disk or network share.

Nothing here touches ppe_test.db, the live database, or any file under PPE_HOME. All work happens in
a fresh temporary directory that is deleted when the script exits (or kept with --keep-db for
inspection).
"""
import argparse, csv, os, random, shutil, sqlite3, sys, tempfile, time

# Make the host package importable whether this is run from host/, from the repo root, or anywhere
# else, by walking up from this file to find a `host/ppe_host` directory and adding `host/` to sys.path.
_HERE = os.path.dirname(os.path.abspath(__file__))
for _base in (os.getcwd(), _HERE, os.path.dirname(_HERE)):
    _candidate = os.path.join(_base, 'host')
    if os.path.isdir(os.path.join(_candidate, 'ppe_host')):
        sys.path.insert(0, _candidate)
        break
    if os.path.isdir(os.path.join(_base, 'ppe_host')):
        sys.path.insert(0, _base)
        break

try:
    from ppe_host.io.db_writer import connect_db, run_migrations
except ImportError as e:
    print("Could not import ppe_host.io.db_writer (%s)." % e, file=sys.stderr)
    print("Run this from inside the host/ folder of the repo, e.g.:", file=sys.stderr)
    print("    cd host && python ../tools/bench_writer.py", file=sys.stderr)
    sys.exit(1)

ROSTER = [(1, 'Alpha'), (2, 'Bravo'), (3, 'Charlie')]

FRAME_COLS = ('event_seq, session_id, node_id, rx_ts, rx_mono, seq, boot_ctr, uptime_s, co_x10, co_over_range, '
              'temp_x100, hum, hr, motion_x100, bat, status2, flags, id_mode, status3, status4, '
              'node_level, backend_level, final_level, reasons, rssi, snr, verify, base_verify, seq_class, '
              'frames_lost, raw_hex, backend_ms')
FRAME_SQL = 'INSERT INTO frames(%s) VALUES (%s)' % (FRAME_COLS, ','.join('?' * 32))


def find_migrations_dir():
    for base in (os.getcwd(), _HERE, os.path.dirname(_HERE)):
        for candidate in (os.path.join(base, 'host', 'migrations'), os.path.join(base, 'migrations')):
            if os.path.isdir(candidate):
                return candidate
    print("Could not find the host/migrations/ folder.", file=sys.stderr)
    sys.exit(1)


def build_schema(db_path, migrations_dir):
    """Fresh database, real schema, via the repo's own migration runner (not a hand-written CREATE TABLE copy)."""
    conn = connect_db(db_path, synchronous='FULL', check_same_thread=False)
    run_migrations(conn, migrations_dir, now_ms=int(time.time() * 1000))
    for node_id, alias in ROSTER:
        conn.execute('INSERT INTO roster(node_id, alias, active) VALUES (?, ?, 1)', (node_id, alias))
    conn.execute("INSERT INTO sessions(session_id, started_ts, mode, host_build, constants_hash, settings_hash, monitoring_active) "
                 "VALUES (1, ?, 'SIMULATOR', 'bench', 'bench', 'bench', 1)", (int(time.time() * 1000),))
    conn.close()


def make_frame_row(event_seq, node_id, rx_ts, rx_mono, seq):
    """One plausible routine frame, close to the Rev-current OK vector shape used elsewhere in the repo's tests."""
    raw_hex = ''.join(random.choice('0123456789abcdef') for _ in range(46))  # 23-byte frame as hex, placeholder payload
    return (event_seq, 1, node_id, rx_ts, rx_mono, seq, 7, seq % 60000, 20, 0,
            2500, 50, 0, 0, 80, 0, 0, node_id | 0x40, 0, 0,
            'NORMAL', 'NORMAL', 'NORMAL', '', -68.5, 9.2, 'OK', 'OK', 'fresh',
            0, raw_hex, 0.4)


def run_pass(migrations_dir, tmp_root, label, synchronous, journal_mode, n_frames):
    """One full pass: fresh database, n_frames single-row commits, each timed. Returns a list of commit seconds."""
    db_path = os.path.join(tmp_root, 'bench_%s.db' % label)
    build_schema(db_path, migrations_dir)

    conn = sqlite3.connect(str(db_path), isolation_level=None)
    conn.execute('PRAGMA foreign_keys=ON')
    conn.execute('PRAGMA busy_timeout=5000')
    if journal_mode:
        conn.execute('PRAGMA journal_mode=%s' % journal_mode)
    conn.execute('PRAGMA synchronous=%s' % synchronous)

    times = []
    t0 = time.time()
    rx_ts = int(t0 * 1000)
    for i in range(n_frames):
        node = (i % 3) + 1
        row = make_frame_row(i + 1, node, rx_ts + i, 1000 + i, i // 3)
        start = time.perf_counter()
        conn.execute('BEGIN IMMEDIATE')
        try:
            conn.execute(FRAME_SQL, row)
            conn.execute('COMMIT')
        except BaseException:
            conn.execute('ROLLBACK')
            raise
        times.append(time.perf_counter() - start)
        if (i + 1) % 10000 == 0:
            print('  %s: %d / %d frames committed' % (label, i + 1, n_frames))
    conn.close()
    elapsed = time.time() - t0
    print('  %s: done, %d frames in %.1f s wall time (%.1f frames/s)' % (label, n_frames, elapsed, n_frames / elapsed))
    return times


def pctile(sorted_vals, p):
    if not sorted_vals:
        return float('nan')
    k = max(0, min(len(sorted_vals) - 1, int(round(p / 100.0 * (len(sorted_vals) - 1)))))
    return sorted_vals[k]


def summarize(label, times_s):
    ms = sorted(t * 1000.0 for t in times_s)
    p50, p95, p99, mx = pctile(ms, 50), pctile(ms, 95), pctile(ms, 99), (ms[-1] if ms else float('nan'))
    print('\n%s commit latency (ms), n=%d' % (label, len(ms)))
    print('  p50 = %7.2f   p95 = %7.2f   p99 = %7.2f   max = %7.2f' % (p50, p95, p99, mx))
    return {'label': label, 'n': len(ms), 'p50_ms': p50, 'p95_ms': p95, 'p99_ms': p99, 'max_ms': mx}


def write_csv(out_path, full_results):
    with open(out_path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(['label', 'frame_index', 'commit_ms'])
        for label, times_s in full_results:
            for i, t in enumerate(times_s):
                w.writerow([label, i, '%.4f' % (t * 1000.0)])


def main():
    ap = argparse.ArgumentParser(description='130,000-frame write-commit benchmark (synchronous=FULL vs WAL+NORMAL).')
    ap.add_argument('--frames', type=int, default=130_000, help='frames per pass (default 130000, the guide\'s figure)')
    ap.add_argument('--out', default='bench_results.csv', help='CSV of every individual commit time (default bench_results.csv)')
    ap.add_argument('--keep-db', action='store_true', help='keep the temporary databases instead of deleting them')
    ap.add_argument('--seed', type=int, default=1, help='random seed for the raw_hex filler (default 1, for repeatability)')
    args = ap.parse_args()

    random.seed(args.seed)
    migrations_dir = find_migrations_dir()
    tmp_root = tempfile.mkdtemp(prefix='ppe_bench_')
    print('Scratch directory: %s%s' % (tmp_root, ' (kept)' if args.keep_db else ' (will be deleted)'))
    print('Migrations: %s' % migrations_dir)
    print('Frames per pass: %d\n' % args.frames)

    try:
        print('Pass 1/2: synchronous=FULL (current default)')
        full_times = run_pass(migrations_dir, tmp_root, 'FULL', synchronous='FULL', journal_mode=None, n_frames=args.frames)

        print('\nPass 2/2: journal_mode=WAL, synchronous=NORMAL')
        wal_times = run_pass(migrations_dir, tmp_root, 'WAL_NORMAL', synchronous='NORMAL', journal_mode='WAL', n_frames=args.frames)

        print('\n' + '=' * 60)
        full_summary = summarize('synchronous=FULL', full_times)
        wal_summary = summarize('WAL + synchronous=NORMAL', wal_times)

        write_csv(args.out, [('FULL', full_times), ('WAL_NORMAL', wal_times)])
        print('\nPer-commit timings written to %s' % os.path.abspath(args.out))

        print('\n' + '=' * 60)
        print('Guide\'s rule (CODING_GUIDE.md Section 6): keep synchronous=FULL if its commit p99 with')
        print('antivirus running is 50 ms or less; otherwise move to WAL with synchronous=NORMAL.\n')
        gate_ms = 50.0
        if full_summary['p99_ms'] <= gate_ms:
            print('RESULT: FULL p99 = %.2f ms <= %.0f ms -> keep synchronous=FULL.' % (full_summary['p99_ms'], gate_ms))
        else:
            print('RESULT: FULL p99 = %.2f ms > %.0f ms -> switch to WAL with synchronous=NORMAL.' % (full_summary['p99_ms'], gate_ms))
            print('        (WAL+NORMAL p99 on this run: %.2f ms, for comparison.)' % wal_summary['p99_ms'])
        print('\nThis was decided on THIS machine and THIS disk, with antivirus state as it was during the run.')
        print('Record which machine, which disk (SSD/HDD, internal/external), and whether antivirus was')
        print('running, in the ADR together with these numbers.')

    finally:
        if not args.keep_db:
            shutil.rmtree(tmp_root, ignore_errors=True)
        else:
            print('\nDatabases kept at: %s' % tmp_root)


if __name__ == '__main__':
    main()
