import ctypes
import subprocess
import time
from build import _get_vcvars_path, ENCODING, log, set_ci_log, _run_build_process, _ROOT_DIR

set_ci_log()

try:
    _run_build_process('python', 'tools/clang/scripts/build.py', '--bootstrap', '--without-android', '--without-fuchsia', '--disable-asserts', '--thinlto', '--pgo', '--bolt', '--llvm-force-head-revision',
         cwd=(_ROOT_DIR / 'build' / 'src'))
except KeyboardInterrupt:
    exit(124)
except RuntimeError:
    exit(123)
