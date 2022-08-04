# ungoogled-chromium-windows

Windows packaging for [ungoogled-chromium](//github.com/Eloston/ungoogled-chromium).

**This version contains some customizations (`patches/my`). Please remove those patches or use "update" branch for the vanilla ungoogled-chromium-windows.**

## Official Build, GPO, and ThinLTO

LLVM is upgraded to 13.0.0, otherwise it crashes at the "ThinLTO Bitcode Writer" pass. 

`llvm-pdbutil` and `llvm-undname` have to be manually compiled from source code as they are not shipped with the LLVM distribution. 

To download the PGO profile for Win64:

```cmd
# From a cmd.exe shell, run the command gclient (without arguments).
# On first run, gclient will install all the Windows-specific bits needed to work with the code, including msysgit and python.
set PATH=path\to\depot_tools;%PATH%
python3 build/src/tools/update_pgo_profiles.py --target=win64 update --gs-url-base=chromium-optimization-profiles/pgo_profiles
```

**Note: Please run the PGO update script before domain substitution.**

## Downloads

[Download binaries from the Contributor Binaries website](//ungoogled-software.github.io/ungoogled-chromium-binaries/).

**Source Code**: It is recommended to use a tag via `git checkout` (see building instructions below). You may also use `master`, but it is for development and may not be stable.

## Building

Google only supports [Windows 10 x64 or newer](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/windows_build_instructions.md#system-requirements). These instructions are tested on Windows 10 Pro x64.

NOTE: The default configuration will build 64-bit binaries for maximum security (TODO: Link some explanation). This can be changed to 32-bit by setting `target_cpu` to `"x86"` in `flags.windows.gn`.

## Version Tips

- python
  - 3.9.7 (supported)
  - 3.10.0 (unsupported)
- windows sdk
  - 10.0.19041.0 (supported)
  - 10.0.20348.0 (unsupported)
  - 10.0.22000.0 (unsupported)


### Setting up the build environment

**IMPORTANT**: Please setup only what is referenced below. Do NOT setup other Chromium compilation tools like `depot_tools`, since we have a custom build process which avoids using Google's pre-built binaries.

#### Setting up Visual Studio

[Follow the "Visual Studio" section of the official Windows build instructions](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/windows_build_instructions.md#visual-studio).

* Make sure to read through the entire section and install/configure all the required components.
* If your Visual Studio is installed in a directory other than the default, you'll need to set a few environment variables to point the toolchains to your installation path. (Copied from [instructions for Electron](https://electronjs.org/docs/development/build-instructions-windows))
	* `vs2019_install = DRIVE:\path\to\Microsoft Visual Studio\2019\Community` (replace `2019` and `Community` with your installed versions)
	* `WINDOWSSDKDIR = DRIVE:\path\to\Windows Kits\10`
	* `GYP_MSVS_VERSION = 2019` (replace 2019 with your installed version's year)


#### Other build requirements

**IMPORTANT**: Currently, the `MAX_PATH` path length restriction (which is 260 characters by default) must be lifted in for our Python build scripts. This can be lifted in Windows 10 (Anniversary or newer) with the official installer for Python 3.6 or newer (you will see a button at the end of installation to do this). See [Issue #345](https://github.com/Eloston/ungoogled-chromium/issues/345) for other methods for other Windows versions.

1. Setup the following:

    * 7-zip
    * Python 3.6+ (for build and packaging scripts used below)
        * At the end of the Python installer, click the button to lift the `MAX_PATH` length restriction.
    * Git (to fetch all required ungoogled-chromium scripts)
        * During setup, make sure "Git from the command line and also from 3rd-party software" is selected. This is usually the recommended option.

### Building

NOTE: The commands below assume the `py` command was installed by Python 3 into `PATH`. If this is not the case, then substitute it with `python3`.

Run in `cmd.exe` (as administrator):

```cmd
git clone --recurse-submodules https://github.com/ungoogled-software/ungoogled-chromium-windows.git
# Replace TAG_OR_BRANCH_HERE with a tag or branch name
git checkout --recurse-submodules TAG_OR_BRANCH_HERE
py build.py
py package.py
```

A zip archive and an installer will be created under `build`.

**NOTE**: If the build fails, you must take additional steps before re-running the build:

* If the build fails while downloading the Chromium source code (which is during `build.py`), it can be fixed by removing `build\download_cache` and re-running the build instructions.
* If the build fails at any other point during `build.py`, it can be fixed by removing `build\src` and re-running the build instructions. This will clear out all the code used by the build, and any files generated by the build.

## Developer info

### First-time setup

1. [Setup MSYS2](http://www.msys2.org/)
2. Run the following in a "MSYS2 MSYS" shell:

```sh
pacman -S quilt python3 vim tar
# By default, there doesn't seem to be a vi command for less, quilt edit, etc.
ln -s /usr/bin/vim /usr/bin/vi
```

### Updating patches

**IMPORTANT**: Run the following in a "MSYS2 MSYS" shell:

1. Navigate to the repo path: `cd /path/to/repo/ungoogled-chromium-windows`
    * You can use Git Bash to determine the path to this repo
    * Or, you can find it yourself via `/<drive letter>/<path with forward slashes>`
2. Setup patches and shell to update patches
    1. `./devutils/update_patches.sh merge`
    2. `source devutils/set_quilt_vars.sh`
3. Setup Chromium source
    1. `mkdir -p build/{src,download_cache}`
    2. `./ungoogled-chromium/utils/downloads.py retrieve -i ungoogled-chromium/downloads.ini -c build/download_cache`
    3. `./ungoogled-chromium/utils/downloads.py unpack -i ungoogled-chromium/downloads.ini -c build/download_cache build/src`
4. Go into the source tree: `cd build/src`
5. Use quilt to refresh patches. See ungoogled-chromium's [docs/developing.md](https://github.com/Eloston/ungoogled-chromium/blob/master/docs/developing.md#updating-patches) section "Updating patches" for more details
6. Go back to repo root: `cd ../..`
7. Remove all patches introduced by ungoogled-chromium: `./devutils/update_patches.sh unmerge`
    * Ensure patches/series is formatted correctly, e.g. blank lines
8. Sanity checking for consistency in series file: `./devutils/check_patch_files.sh`
9. Check for esbuild dependency changes in file `build/src/DEPS` and adapt `downloads.ini` accordingly
10. Use git to add changes and commit

## License

See [LICENSE](LICENSE)
