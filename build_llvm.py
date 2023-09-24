import ctypes
import subprocess
import time
from .build import _get_vcvars_path, ENCODING, log, set_ci_log, _run_build_process_timeout, _ROOT_DIR

set_ci_log()

try:
    _run_build_process_timeout('python', 'tools/clang/scripts/build.py', '--bootstrap', '--without-android', '--without-fuchsia', '--disable-asserts', '--thinlto', '--pgo', '--bolt', '--llvm-force-head-revision',
         timeout=3.5*60*60,
         cwd=(_ROOT_DIR / 'ungoogled-chromium'))
except KeyboardInterrupt:
    exit(124)
except RuntimeError:
    exit(123)

_run_build_process_timeout