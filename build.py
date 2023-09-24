#!/usr/bin/env python3
# -*- coding: utf-8 -*-

# Copyright (c) 2019 The ungoogled-chromium Authors. All rights reserved.
# Use of this source code is governed by a BSD-style license that can be
# found in the LICENSE file.
"""
ungoogled-chromium build script for Microsoft Windows
"""

import typed_argparse as tap
from contextlib import contextmanager
from enum import Enum, IntEnum
import logging
from types import SimpleNamespace
from typing import Any, Callable, Generator, Sequence, TypedDict, Union
import typing
import github_action_utils as action

import sys
import time
if sys.version_info.major < 3 or sys.version_info.minor < 6:
    raise RuntimeError('Python 3.6+ is required for this script. You have: {}.{}'.format(
        sys.version_info.major, sys.version_info.minor))

import argparse
import json
import os
import re
import shutil
import subprocess
import urllib.request
import urllib.parse
import ctypes
from pathlib import Path
import requests

_ROOT_DIR = Path(__file__).resolve().parent

sys.path.insert(0, str(_ROOT_DIR / 'ungoogled-chromium' / 'utils'))
import downloads
import domain_substitution
import prune_binaries
import patches
from _common import ENCODING, USE_REGISTRY, ExtractorEnum, get_logger
sys.path.pop(0)

_PATCH_BIN_RELPATH = Path('third_party/git/usr/bin/patch.exe')

log = get_logger()

def _get_vcvars_path(name='64'):
    """
    Returns the path to the corresponding vcvars*.bat path

    As of VS 2017, name can be one of: 32, 64, all, amd64_x86, x86_amd64
    """
    vswhere_exe = '%ProgramFiles(x86)%\\Microsoft Visual Studio\\Installer\\vswhere.exe'
    result = subprocess.run(
        f'"{vswhere_exe}" -prerelease -latest -property installationPath',
        shell=True,
        check=True,
        stdout=subprocess.PIPE,
        universal_newlines=True)
    vcvars_path = Path(result.stdout.strip(), f'VC/Auxiliary/Build/vcvars{name}.bat')
    if not vcvars_path.exists():
        raise RuntimeError(f'Could not find vcvars batch script in expected location: {vcvars_path}')
    return vcvars_path

def _run_build_process(*args: str, **kwargs):
    """
    Runs the subprocess with the correct environment variables for building
    """
    # Add call to set VC variables
    cmd_input = [f'call "{_get_vcvars_path()}" >nul']
    cmd_input.append('set DEPOT_TOOLS_WIN_TOOLCHAIN=0')
    cmd_input.append(' '.join(map(lambda x: f'"{x}"', args)))
    cmd_input.append('exit\n')
    subprocess.run(('cmd.exe', '/k'),
                   input='\n'.join(cmd_input),
                   check=True,
                   encoding=ENCODING,
                   **kwargs)

def _run_build_process_timeout(*args: str, timeout: int, cwd: Union[os.PathLike, None] = None):
    """
    Runs the subprocess with the correct environment variables for building
    """
    # Add call to set VC variables
    cmd_input = [f'call "{_get_vcvars_path()}" >nul']
    cmd_input.append('set DEPOT_TOOLS_WIN_TOOLCHAIN=0')
    cmd_input.append(' '.join(map(lambda x: f'"{x}"', args)))
    cmd_input.append('exit\n')
    with subprocess.Popen(('cmd.exe', '/k'), encoding=ENCODING, stdin=subprocess.PIPE, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP, cwd=cwd) as proc:
        if proc.stdin:
            proc.stdin.write('\n'.join(cmd_input))
            proc.stdin.close()

        try:
            proc.wait(timeout)
            if proc.returncode != 0:
                raise RuntimeError('Build failed!')
        except subprocess.TimeoutExpired:
            log.warn('Sending keyboard interrupt')
            for _ in range(3):
                ctypes.windll.kernel32.GenerateConsoleCtrlEvent(1, proc.pid)
                time.sleep(1)
            try:
                proc.wait(10)
            except:
                proc.kill()
            raise KeyboardInterrupt

def _make_tmp_paths():
    """Creates TMP and TEMP variable dirs so ninja won't fail"""
    tmp_path = Path(os.environ['TMP'])
    if not tmp_path.exists():
        tmp_path.mkdir()
    tmp_path = Path(os.environ['TEMP'])
    if not tmp_path.exists():
        tmp_path.mkdir()

def set_ci_log():
    log.setLevel(logging.NOTSET)
    for x in log.handlers:
        x.setLevel(logging.NOTSET)

    # https://stackoverflow.com/a/56944256
    class CustomFormatter(logging.Formatter):
        grey = "\x1b[38;20m"
        yellow = "\x1b[33;20m"
        red = "\x1b[31;20m"
        bold_red = "\x1b[31;1m"
        reset = "\x1b[0m"
        format_str = "%(asctime)s - %(name)s - %(levelname)s - %(message)s (%(filename)s:%(lineno)d)"

        FORMATS = {
            logging.DEBUG: logging.Formatter(grey + format_str + reset),
            logging.INFO: logging.Formatter(grey + format_str + reset),
            logging.WARNING: logging.Formatter(yellow + format_str + reset),
            logging.ERROR: logging.Formatter(red + format_str + reset),
            logging.CRITICAL: logging.Formatter(bold_red + format_str + reset),
        }

        def format(self, record):
            formatter = self.FORMATS.get(record.levelno) or logging.Formatter(self.format_str)
            return formatter.format(record)
    log.handlers[0].setFormatter(CustomFormatter())


class Step(Enum):
    SETUP_ENVIRONMENT = 'setup-environment'
    DOWNLOAD_PGO_PROFILES = 'download-pgo-profiles'
    CREATE_ARGS_GN = 'create-args-gn'
    BOOTSTRAP_GN = 'bootstrap-gn'
    BUILD = 'build'
    PACKAGE = 'package'

    def __str__(self) -> str:
        return str(self.value)

class Args(tap.TypedArgs):
    ci: bool = tap.arg(help="Set when running through CI", default=False)
    x86: bool = tap.arg(help="Set for 32-bit builds", default=False)
    sevenz_path: str = tap.arg('--7z-path', help=('Command or path to 7-Zip\'s "7z" binary. If "_use_registry" is '
              'specified, determine the path from the registry. Default: %(default)s'), default=USE_REGISTRY)
    winrar_path: str = tap.arg(help=('Command or path to WinRAR\'s "winrar.exe" binary. If "_use_registry" is '
              'specified, determine the path from the registry. Default: %(default)s'), default=USE_REGISTRY)
    disable_ssl_verification: bool = tap.arg(help='Disables SSL verification for downloading', default=False)
    step: Step = tap.arg(help='Build step (when building in CI)', default=Step.SETUP_ENVIRONMENT)
    force: bool = tap.arg(default=False)

def retry_on_fail(msg: str, err: type[BaseException], callback: Callable[[], None]):
    for attempt in range(1, 6):
        try:
            callback()
        except err as exc:
            log.warn(f'{msg} failed; attempt {attempt} of 5: {exc}')
            time.sleep(5)
        else:
            return True
    return False

def main(args: Args):
    @contextmanager
    def group(name: str) -> Generator[Any, None, None]:
        if args.ci:
            action.start_group(name)
        else:
            log.info(name, stacklevel=2)
        yield
        if args.ci:
            action.end_group()

    def error(message: str):
        if args.ci:
            action.error(message, 'ungoogled-chromium build script')
        else:
            log.error(message, stacklevel=2)

    if args.ci:
        set_ci_log()


    # Set common variables
    source_tree = _ROOT_DIR / 'build' / 'src'
    downloads_cache = _ROOT_DIR / 'build' / 'download_cache'
    # domsubcache = _ROOT_DIR / 'build' / 'domsubcache.tar.gz'

    if not args.ci or (args.step == Step.SETUP_ENVIRONMENT and (not (source_tree / 'BUILD.gn').exists() or args.force)):
        # Setup environment
        source_tree.mkdir(parents=True, exist_ok=True)
        downloads_cache.mkdir(parents=True, exist_ok=True)
        _make_tmp_paths()

        # Get download metadata (DownloadInfo)
        download_info = downloads.DownloadInfo([
            _ROOT_DIR / 'downloads.ini',
            _ROOT_DIR / 'ungoogled-chromium' / 'downloads.ini',
        ])

        # Retrieve downloads
        with group('Downloading required files...'):
            if not retry_on_fail(
                'Download',
                subprocess.CalledProcessError,
                lambda: downloads.retrieve_downloads(download_info, downloads_cache, True, args.disable_ssl_verification)
            ):
                error('All download retry attempts exceeded, exiting')
                exit(1)
            try:
                downloads.check_downloads(download_info, downloads_cache)
            except downloads.HashMismatchError as exc:
                error(f'File checksum does not match: {exc}')
                exit(1)

        # Unpack downloads
        with group('Unpacking downloads...'):
            extractors = {
                ExtractorEnum.SEVENZIP: args.sevenz_path,
                ExtractorEnum.WINRAR: args.winrar_path,
            }
            downloads.unpack_downloads(download_info, downloads_cache, source_tree, extractors)

        # Prune binaries
        with group('Prune binaries'):
            unremovable_files = prune_binaries.prune_files(
                source_tree,
                (_ROOT_DIR / 'ungoogled-chromium' / 'pruning.list').read_text(encoding=ENCODING).splitlines()
            )
            if unremovable_files:
                log.error('Files could not be pruned: %s', unremovable_files)
                exit(1)

        # Apply patches
        with group('Apply patches'):
            # First, ungoogled-chromium-patches
            patches.apply_patches(
                patches.generate_patches_from_series(_ROOT_DIR / 'ungoogled-chromium' / 'patches', resolve=True),
                source_tree,
                patch_bin_path=(source_tree / _PATCH_BIN_RELPATH)
            )
            # Then Windows-specific patches
            patches.apply_patches(
                patches.generate_patches_from_series(_ROOT_DIR / 'patches', resolve=True),
                source_tree,
                patch_bin_path=(source_tree / _PATCH_BIN_RELPATH)
            )

        # Substitute domains
        with group('Substitute domains'):
            domain_substitution.apply_substitution(
                _ROOT_DIR / 'ungoogled-chromium' / 'domain_regex.list',
                _ROOT_DIR / 'ungoogled-chromium' / 'domain_substitution.list',
                source_tree,
                None
            )

    if not args.ci or args.step == Step.DOWNLOAD_PGO_PROFILES:
        with group('Retrieving PGO profiles...'):
            # Retrieve PGO profiles manually (not with gclient)
            # https://chromium.googlesource.com/chromium/src/+/master/tools/update_pgo_profiles.py
            pgo_target = 'win32' if args.x86 else 'win64' # https://github.com/chromium/chromium/blob/45530e7cae53c526cd29ad6f12ec26f6cc09c8bf/DEPS#L5551-L5572
            pgo_dir = source_tree / 'chrome' / 'build'
            state_file = pgo_dir / (f'{pgo_target}.pgo.txt')
            profile_name = state_file.read_text(encoding=ENCODING).strip()
            if args.ci:
                action.set_env('PGO_PROFILE_NAME', profile_name)

            pgo_profile_dir = pgo_dir / 'pgo_profiles'
            profile_path = pgo_profile_dir / profile_name
            if not profile_path.is_file():
                with requests.get(f'https://commondatastorage.googleapis.com/chromium-optimization-profiles/pgo_profiles/{profile_name}') as downloaded:
                    profile_path.write_bytes(downloaded.content)
            else:
                action.notice(f'Found existing PGO profile called {profile_name}')
                profile_path.touch()

    if not args.ci or (args.step == Step.CREATE_ARGS_GN and (not (source_tree / 'out/Default').exists() or args.force)):
        # Output args.gn
        with group('Output args.gn'):
            (source_tree / 'out/Default').mkdir(parents=True)
            gn_flags = (_ROOT_DIR / 'ungoogled-chromium' / 'flags.gn').read_text(encoding=ENCODING)
            gn_flags += '\n'
            windows_flags = (_ROOT_DIR / 'flags.windows.gn').read_text(encoding=ENCODING)
            if args.x86:
                windows_flags = windows_flags.replace('x64', 'x86')
            gn_flags += windows_flags
            (source_tree / 'out/Default/args.gn').write_text(gn_flags, encoding=ENCODING)

    # Enter source tree to run build commands
    os.chdir(source_tree)

    if not args.ci or (args.step == Step.BOOTSTRAP_GN and (not os.path.exists('out\\Default\\gn.exe') or args.force)):
        # Run GN bootstrap
        with group('Run gn bootstrap'):
            _run_build_process(
                sys.executable, 'tools\\gn\\bootstrap\\bootstrap.py', '-o', 'out\\Default\\gn.exe',
                '--skip-generate-buildfiles')

        # Run gn gen
        with group('Run gn gen'):
            _run_build_process('out\\Default\\gn.exe', 'gen', 'out\\Default', '--fail-on-unused-args')

    # Run ninja
    if args.ci:
        if args.step == Step.BUILD:
            with group('Run ninja'):
                try:
                    _run_build_process('third_party\\ninja\\ninja.exe', '-C', 'out\\Default', 'chrome',
                                       'chromedriver', 'mini_installer')
                except KeyboardInterrupt:
                    exit(124)
                except RuntimeError:
                    exit(123)

        if args.step == Step.PACKAGE:
            # package
            with group('Package result'):
                os.chdir(_ROOT_DIR)
                subprocess.run([sys.executable, 'package.py'])
    else:
        _run_build_process('third_party\\ninja\\ninja.exe', '-C', 'out\\Default', 'chrome',
                        'chromedriver', 'mini_installer')


if __name__ == '__main__':
    tap.Parser(Args).bind(main).run()
