// @ts-check

const io = require('@actions/io');
const fs = require('fs');
const path = require('path');
const {exec} = require('@actions/exec');

/*!
https://github.com/actions/cache/blob/75cd46ec0c4d8108ee45f7507e2bca5517988d31/src/tar.ts

The MIT License (MIT)

Copyright (c) 2018 GitHub, Inc. and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/
/**
 * @param {string[]} args
 * @returns {Promise<string>}
 */
async function getTarPath(args) {
    return await io.which("tar", true);
}

/**
 *
 * @param {string[]} args
 * @param {string} [cwd]
 * @returns {Promise<void>}
 */
async function execTar(args, cwd) {
    try {
        await exec(`"${await getTarPath(args)}"`, args, { cwd: cwd });
    } catch (error) {
        // @ts-ignore
        throw new Error(`Tar failed with error: ${error?.message}`);
    }
}

/**
 * @returns {string}
 */
function getWorkingDirectory() {
    return process.env["GITHUB_WORKSPACE"] ?? process.cwd();
}

/**
 *
 * @param {string} archivePath
 * @param {'zstd' | 'gzip'} compressionMethod
 * @param {string} [destination]
 * @returns {Promise<void>}
 */
exports.extractTar = async function extractTar(archivePath, compressionMethod, destination) {
    await exec('7z', ['x', '-y', archivePath], { cwd: destination})
}

const pathSepRegex = new RegExp("\\" + path.sep, "g");

/**
 * @param {string} tarFileName
 * @param {string} archiveFolder
 * @param {string[]} sourceDirectories
 * @param {'zstd' | 'gzip'} compressionMethod
 * @returns {Promise<void>}
 */
exports.createTar = async function createTar(tarFileName, archiveFolder, sourceDirectories, compressionMethod) {
    // Write source directories to manifest.txt to avoid command length limits
    const manifestFilename = "manifest.txt";
    await fs.promises.writeFile(
        path.join(archiveFolder, manifestFilename),
        sourceDirectories.join("\n")
    );
    // -T#: Compress using # working thread. If # is 0, attempt to detect and use the number of physical CPU cores.
    // --long=#: Enables long distance matching with # bits. Maximum is 30 (1GB) on 32-bit OS and 31 (2GB) on 64-bit.
    // Using 30 here because we also support 32-bit self-hosted runners.
    await exec('7z', ['a', tarFileName, '-m0=zstd', '-mx2', '@' + manifestFilename, '-x!' + tarFileName, '-x!' + manifestFilename], { cwd: archiveFolder });
    await fs.promises.unlink(path.join(archiveFolder, manifestFilename));
}