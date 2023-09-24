// @ts-check

const core = require('@actions/core');
const io = require('@actions/io');
// const { exec } = require('@actions/exec');
const artifact = require('@actions/artifact');
const glob = require('@actions/glob');
const path = require('path/win32');
const { ToolRunner, argStringToArray } = require('./execx');
const { generateCtrlBreakAsync } = require('generate-ctrl-c-event');

const delayedSymbol = Symbol('delayed');
class ToolRunnerWithTimeout extends ToolRunner {
    /**
     * @param {string} toolPath
     * @param {string[]} [args]
     * @param {import('@actions/exec').ExecOptions & { timeout?: number }} [options]
     */
    constructor(toolPath, args, options) {
        super(toolPath, args, options);

        /** @type {number | undefined} */
        this.timeout = options && options.timeout;
    }

    /**
     * @returns {Promise<[timedOut: boolean, exitCode: number]>} number
     */
    async execWithTimeout() {
        const [proc, promise] = await super.exec();

        return new Promise((resolve, reject) => {
            if (this.timeout !== undefined) {
                Promise.race([promise, delay(this.timeout)])
                    .then(async result => {
                        if (result !== delayedSymbol) { // did not time out
                            resolve([false, proc.exitCode || NaN]);
                            return;
                        }

                        if (proc.exitCode === null && proc.pid !== undefined) { // if process is still running
                            for (let i = 0; i < 3; i++) { // attempt to send ctrl+break
                                if (proc.exitCode !== null) {
                                    resolve([true, proc.exitCode]);
                                    return;
                                }
                                await generateCtrlBreakAsync(proc.pid);
                                await delay(1000);
                            }

                            if (proc.exitCode !== null) {
                                resolve([true, proc.exitCode]);
                                return;
                            }

                            await Promise.race([promise, delay(10_000)]);
                            if (proc.exitCode === null) { // if process is still running AGAIN
                                proc.kill(); // kill it with fire
                            }

                            resolve([true, proc.exitCode || NaN]);
                            return;
                        }

                        resolve([false, proc.exitCode || NaN]);
                        return;
                    })
                    .catch(reject);
            } else {
                promise.then(code => resolve([false, code])).catch(reject);
            }
        });
    }
}

/**
 *
 * @param {string} commandLine
 * @param {string[]} [args]
 * @param {import('@actions/exec').ExecOptions & { timeout?: number }} [options]
 * @returns {Promise<[timedOut: boolean, exitCode: number]>}
 */
async function exec(commandLine, args, options) {
    const commandArgs = argStringToArray(commandLine)
    if (commandArgs.length === 0) {
        throw new Error(`Parameter 'commandLine' cannot be null or empty.`)
    }
    // Path to tool to execute should be first arg
    const toolPath = commandArgs[0]
    args = commandArgs.slice(1).concat(args || [])
    const runner = new ToolRunnerWithTimeout(toolPath, args, options)
    return runner.execWithTimeout()
}

const { extractTar, createTar } = require('./tar');

/**
 * @param {number} ms
 * @returns {Promise<typeof delayedSymbol>}
 */
function delay(ms) {
    return new Promise(r => setTimeout(() => r(delayedSymbol), ms));
}

/**
 * @param {artifact.ArtifactClient} artifactClient
 * @param {string} artifactName
 * @param {string} path
 * @param {artifact.DownloadOptions} [options]
 * @returns {Promise<artifact.DownloadResponse | { failed?: true }>}
 */
async function downloadArtifactIfExists(artifactClient, artifactName, path, options) {
    try {
        return await artifactClient.downloadArtifact(artifactName, path, options);
    } catch (err) {
        if (err.message === 'Unable to find any artifacts for the associated workflow' || err.message === `Unable to find an artifact with the name: ${artifactName}`) {
            return { failed: true };
        }
        throw err;
    }
}

async function run() {
    process.on('SIGINT', function () {
    });

    // Where the repository is cloned to
    const basedir = process.env.PROJECT_LOCATION || 'C:\\ungoogled-chromium-windows';

    const tarballArtifactName = core.getInput('tarball-artifact-name', { required: false });
    const tarballFileName = core.getInput('tarball-file-name', { required: false });
    const tarballRoot = core.getInput('tarball-root', { required: true }) // path.join(basedir, 'build');
    const run = core.getMultilineInput('run', { required: true });
    const runRaw = core.getInput('run', { required: true });
    const cwd = core.getInput('cwd', { required: false });
    const input = core.getInput('input', { required: false });
    const inputEncoding = /** @type {BufferEncoding} */ (core.getInput('input-encoding', { required: false }) || 'utf-8');
    const ignoreReturnCodes = core.getInput('ignore-return-codes', { required: false }).split(',').map(e => Number(e.trim())).filter(e => !isNaN(e));
    const failOnStdErr = core.getBooleanInput('fail-on-stderr', { required: false });
    const loadTarballArtifactIfExists = core.getBooleanInput('load-tarball-artifact-if-exists', { required: false });
    const saveTarballArtifact = core.getBooleanInput('save-tarball-artifact', { required: false });
    const tarballGlob = core.getInput('tarball-pattern', { required: false }) || tarballRoot; // path.join(basedir, 'build', 'src')
    const timeout = parseFloat(core.getInput('timeout', { required: false }) || (''+(3.5*60*60*1000)));
    const shell = /** @type {'none' | 'pwsh' | 'cmd' | 'python' | 'node'} */ (core.getInput('shell', { required: false }) || 'none');

    const artifactClient = artifact.create();

    if (loadTarballArtifactIfExists) {
        await core.group('Downloading and extracting artifact', async () => {
            const result = await downloadArtifactIfExists(artifactClient, tarballArtifactName, tarballRoot);
            if (!('failed' in result) || !result.failed) {
                await extractTar(path.join(tarballRoot, tarballFileName), 'zstd', tarballRoot);
                await io.rmRF(path.join(tarballRoot, tarballFileName));
            }
        });
    }

    /** @type {(number | 'timeout')[]} */
    const resultsPerCommand = [];
    let anyTimedOut = false;

    if (shell === 'none') {
        for (const command of run) {
            const [timedOut, returnCode] = await exec(...await wrapInShell(command, shell), {
                cwd,
                ignoreReturnCode: true,
                input: input ? Buffer.from(input, inputEncoding) : undefined,
                failOnStdErr,
                timeout
            });

            if (timedOut || ignoreReturnCodes.includes(returnCode)) {
                resultsPerCommand.push('timeout');
                anyTimedOut = true;
                break;
            }

            resultsPerCommand.push(returnCode);

            if (returnCode !== 0) {
                core.setOutput('results-per-command', resultsPerCommand);
                core.setOutput('outcome', 'failed');
                core.setFailed(`Command ${command} returned exit code: ${returnCode}`);
                return;
            }
        }
    } else {
        const [timedOut, returnCode] = await exec(...await wrapInShell(runRaw, shell), {
            cwd,
            ignoreReturnCode: true,
            input: input ? Buffer.from(input, inputEncoding) : undefined,
            failOnStdErr,
            timeout
        });

        if (timedOut || ignoreReturnCodes.includes(returnCode)) {
            resultsPerCommand.push('timeout');
            anyTimedOut = true;
        } else {
            resultsPerCommand.push(returnCode);

            if (returnCode !== 0) {
                core.setOutput('results-per-command', resultsPerCommand);
                core.setOutput('outcome', 'failed');
                core.setFailed(`${shell} command '${runRaw}' returned exit code: ${returnCode}`);
                return;
            }
        }
    }

    if (anyTimedOut) {
        await core.group('Pausing and saving build artifacts for next step', async () => {
            await delay(5000);

            if (saveTarballArtifact) {
                const globbed = await glob.create(tarballGlob, { matchDirectories: false }).then(e => e.glob());

                await core.group('Tarballing build files', async () => {
                    await createTar(path.join(tarballRoot, tarballFileName), tarballRoot, globbed, 'zstd');
                });

                await repeatOnFail('Upload artifact', async () => {
                    await artifactClient.uploadArtifact(tarballArtifactName, [path.join(tarballRoot, tarballFileName)], tarballRoot, { retentionDays: 3 });
                });
            }
        });

        core.setOutput('outcome', 'timeout');
    } else {
        core.setOutput('outcome', 'success');
    }
}

run().catch(err => core.setFailed(err.message));

/**
 * @param {string} label
 * @param {() => any} action
 */
async function repeatOnFail(label, action, maxRetries = 5) {
    for (let i = 0; i < maxRetries; ++i) {
        try {
            await action();
            break;
        } catch (e) {
            console.error(`${label} failed: ${e}. Attempt ${i + 1} of ${maxRetries}`);
            // Wait 10 seconds between the attempts
            await delay(10000);
        }
    }
}

/**
 * @param {string} command
 * @param {'pwsh' | 'cmd' | 'none' | 'python' | 'node'} shell
 * @returns {Promise<[commandLine: string, args?: string[] | undefined]>}
 */
async function wrapInShell(command, shell) {
    switch (shell) {
        case 'pwsh':
            const pwshPath = await io.which('pwsh', false);
            if (pwshPath) {
                core.debug(`Using pwsh at path: ${pwshPath}`);
                return [pwshPath, [
                    '-NoLogo',
                    '-NoProfile',
                    '-NonInteractive',
                    '-ExecutionPolicy',
                    'Unrestricted',
                    '-Command',
                    command
                ]];
            } else {
                const powershellPath = await io.which('powershell', true);
                core.debug(`Using powershell at path: ${powershellPath}`);
                return [powershellPath, [
                    '-NoLogo',
                    '-Sta',
                    '-NoProfile',
                    '-NonInteractive',
                    '-ExecutionPolicy',
                    'Unrestricted',
                    '-Command',
                    command
                ]];
            }
        case 'python':
            return ['python', ['-u', '-c', command]];
        case 'node':
            return ['node', ['-e', command]]; // aka --eval
        case 'cmd':
            return ['cmd.exe', ['/c', command]];
        case 'none':
        default:
            return [command, undefined];
    }
}
