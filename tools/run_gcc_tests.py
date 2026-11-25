#!/usr/bin/env python3
"""tools/run_gcc_tests.py: builds and runs the firmware unit tests with gcc (no ESP-IDF). Run: python tools/run_gcc_tests.py (exit 1 on a build or test failure).
Needs gcc on PATH. Run python tools/gen_frame_vectors.py first (just gen does it)."""
import os, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TESTS = {'test_frame': ('frame', ['aes128', 'cmac', 'crc8', 'frame']), 'test_rules_fw': ('rules_fw', ['man_down'])}  # P16 adds its machines to rules_fw
def main():
    out = os.path.join(ROOT, 'firmware', 'tests', 'build'); os.makedirs(out, exist_ok=True)
    for name, (comp, parts) in TESTS.items():
        exe = os.path.join(out, name + ('.exe' if os.name == 'nt' else ''))
        cmd = ['gcc', '-std=c11', '-Wall', '-Wextra', '-Werror', '-pedantic', '-I', 'firmware/components/abi', '-I', f'firmware/components/{comp}', '-I', 'firmware/tests',
               *[f'firmware/components/{comp}/{p}.c' for p in parts], f'firmware/tests/{name}.c', '-o', exe]
        if subprocess.run(cmd, cwd=ROOT).returncode: return 1
        if subprocess.run([exe], cwd=ROOT).returncode: return 1
    return 0
if __name__ == '__main__': sys.exit(main())
