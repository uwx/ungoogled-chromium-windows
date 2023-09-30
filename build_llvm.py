from build import _run_build_process, _ROOT_DIR

try:
    _run_build_process('python', 'tools/clang/scripts/build.py', '--bootstrap', '--without-android', '--without-fuchsia', '--disable-asserts', '--thinlto', '--pgo', '--bolt', '--pic',
         cwd=(_ROOT_DIR / 'build' / 'src'))
except KeyboardInterrupt:
    exit(124)
except RuntimeError:
    exit(123)
