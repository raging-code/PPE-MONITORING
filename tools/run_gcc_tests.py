#!/usr/bin/env python3
"""tools/run_gcc_tests.py: builds and runs the firmware unit tests with gcc (no ESP-IDF). Run: python tools/run_gcc_tests.py (exit 1 on a build or test failure).
Needs gcc on PATH. Run python tools/gen_frame_vectors.py first (just gen does it)."""
import os, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRAME = ['aes128', 'cmac', 'crc8', 'frame']
TESTS = {'test_frame': FRAME}
def main():
    out = os.path.join(ROOT, 'firmware', 'tests', 'build'); os.makedirs(out, exist_ok=True)
    for name, parts in TESTS.items():
        exe = os.path.join(out, name + ('.exe' if os.name == 'nt' else ''))
        cmd = ['gcc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-pedantic', '-I', 'firmware/components/abi', '-I', 'firmware/components/frame', '-I', 'firmware/tests',
               *[f'firmware/components/frame/{p}.c' for p in parts], f'firmware/tests/{name}.c', '-o', exe]
        if subprocess.run(cmd, cwd=ROOT).returncode: return 1
        if subprocess.run([exe], cwd=ROOT).returncode: return 1
    return 0
if __name__ == '__main__': sys.exit(main())
