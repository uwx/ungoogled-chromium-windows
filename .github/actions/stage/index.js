// @ts-check

const core = require('@actions/core');
const io = require('@actions/io');
const fs = require('fs/promises');
// const { exec } = require('@actions/exec');
const artifact = require('@actions/artifact');
const glob = require('@actions/glob');
const path = require('path/win32');
const { ToolRunner, argStringToArray } = require('./execx');
const { generateCtrlBreakAsync } = require('generate-ctrl-c-event');

/**
 * @typedef {'none' | 'pwsh' | 'cmd' | 'python' | 'node'} Shell
 * @typedef {import('@actions/exec').ExecOptions} ExecOptions
 */

const delayedSymbol = Symbol('delayed');
class ToolRunnerWithTimeout extends ToolRunner {
    /**
     * @param {string} toolPath
     * @param {string[]} [args]
     * @param {ExecOptions & { timeout?: number }} [options]
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

        if (this.timeout !== undefined) {
            const { timedOut, result } = await awaitWithTimeout(promise, this.timeout)
            if (!timedOut) { // did not time out
                return [false, await result];
            }

            if (proc.exitCode === null && proc.pid !== undefined) { // if process is still running
                for (let i = 0; i < 3; i++) { // attempt to send ctrl+break
                    if (proc.exitCode !== null) {
                        return [true, proc.exitCode];
                    }
                    await generateCtrlBreakAsync(proc.pid);
                    await delay(1000);
                }

                if (proc.exitCode !== null) {
                    return [true, proc.exitCode];
                }

                await awaitWithTimeout(promise, 10_000);
                if (proc.exitCode === null) { // if process is still running AGAIN
                    proc.kill(); // kill it with fire
                }

                return [true, proc.exitCode || NaN];
            }

            return [false, proc.exitCode || NaN];
        } else {
            return [false, await promise];
        }
    }
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<{ timedOut: boolean, result: T | Promise<T> }>}
 */
async function awaitWithTimeout(promise, ms) {
    const delay = delayCancelable(this.timeout);
    const result = await Promise.race([promise, delay]);
    if (result !== delayedSymbol) {
        delay.cancel();
        return { timedOut: false, result };
    }
    return { timedOut: true, result: promise };
}

/**
 *
 * @param {string} commandLine
 * @param {string[]} [args]
 * @param {ExecOptions & { timeout?: number }} [options]
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
 * @param {number} ms
 * @returns {Promise<typeof delayedSymbol> & { cancel: () => void }}
 */
function delayCancelable(ms) {
    /** @type {(result: typeof delayedSymbol) => void} */
    let r;
    const promise = new Promise(r1 => r = r1);
    const timeout = setTimeout(() => r(delayedSymbol), ms);
    return Object.assign(promise, {
        cancel: () => clearTimeout(timeout)
    });
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

/**
 * @param {string} key
 * @param {string} value
 */
async function storeEnvVariable(key, value) {
    if (key.includes('=') || key.includes('\n') || key.includes('\r')) {
        throw new Error(`Invalid key: ${key}`)
    }
    if (value.includes('\n')) {
        // Find longest sequence of string "EOF" followed by amount of $ symbols, add one more to get a unique delimiter nowhere seen in the string
        const delimiter = value.match(/EOF\$*/g).sort((a,b)=>b.length-a.length)[0] + '$';

        await fs.appendFile(process.env.GITHUB_ENV, `\n${key}<<${delimiter}\n${value}\n${delimiter}`);
    } else {
        await fs.appendFile(process.env.GITHUB_ENV, `\n${key}=${value}`);
    }
}

async function run() {
    process.on('SIGINT', function () {
    });

    // Where the repository is cloned to
    const basedir = process.env.PROJECT_LOCATION || 'C:\\ungoogled-chromium-windows';

    const cwd = path.resolve(core.getInput('cwd', { required: false })) || process.cwd();
    const tarballArtifactName = path.resolve(cwd, core.getInput('tarball-artifact-name', { required: false }));
    const tarballRoot = path.resolve(cwd, core.getInput('tarball-root', { required: true }));
    const tarballFileName = core.getInput('tarball-file-name', { required: false });
    const run = getExecutor('run', true);
    const beforeRun = getExecutor('before-run', false);
    const afterRun = getExecutor('after-run', false);
    const input = core.getInput('input', { required: false });
    const inputEncoding = /** @type {BufferEncoding} */ (core.getInput('input-encoding', { required: false }) || 'utf-8');
    const ignoreExitCodes = core.getInput('ignore-exit-codes', { required: false }).split(',').map(e => Number(e.trim())).filter(e => !isNaN(e));
    const failOnStdErr = core.getBooleanInput('fail-on-stderr', { required: false });
    const loadTarballArtifactIfExists = core.getBooleanInput('load-tarball-artifact-if-exists', { required: false });
    const saveTarballArtifact = core.getBooleanInput('save-tarball-artifact', { required: false });
    const tarballGlob = path.resolve(cwd, core.getInput('tarball-pattern', { required: false }) || tarballRoot);
    const timeout = parseFloat(core.getInput('timeout', { required: false }) || ('' + (3.5 * 60 * 60 * 1000)));
    const shell = /** @type {Shell} */ (core.getInput('shell', { required: false }) || 'none');
    const key = core.getInput('key', { required: false });

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

    /** @type {'failed' | 'timeout' | 'success'} */
    let outcome;
    /** @type {(number | 'timeout')[]} */
    let resultsPerCommand;
    /** @type {string | undefined} */
    let failCase;

    const startTime = key && process.env['STAGE_START_' + key] ? Number(process.env['STAGE_START_' + key]) : Date.now();
    const isExecutionTimedOut = () => timeout && startTime + timeout < Date.now();

    if (key && !process.env['STAGE_START_' + key]) {
        process.env['STAGE_START_' + key] = ''+startTime;
        storeEnvVariable('STAGE_START_' + key, ''+startTime);
    }

    if (beforeRun) { // run with no timeout
        // If timed out before we execute beforeRun
        if (isExecutionTimedOut()) {
            core.setOutput('results-per-command', []);
            core.setOutput('before-run-outcome', beforeRun ? 'timeout' : 'skipped');
            core.setOutput('outcome', 'timeout');
            core.setOutput('after-run-outcome', afterRun ? 'timeout' : 'skipped');
            // NB: there are no artifacts to save here.
        }

        ({ outcome, failCase } = await beforeRun({
            cwd,
            ignoreReturnCode: true,
            failOnStdErr
        }, shell, ignoreExitCodes));

        core.setOutput('before-run-outcome', outcome);
        if (outcome == 'failed') {
            core.setOutput('outcome', 'failed');
            core.setFailed(`Before-run hook failed: ${failCase}`);
        }
    } else {
        core.setOutput('before-run-outcome', 'skipped');
    }

    // If timed out before we execute run
    if (isExecutionTimedOut()) {
        await saveArtifacts(saveTarballArtifact, tarballGlob, tarballFileName, tarballRoot, artifactClient, tarballArtifactName);
        core.setOutput('results-per-command', []);
        core.setOutput('outcome', 'timeout');
        core.setOutput('after-run-outcome', afterRun ? 'timeout' : 'skipped');
        return;
    }

    ({ outcome, resultsPerCommand, failCase } = await run({
        cwd,
        ignoreReturnCode: true,
        input: input ? Buffer.from(input, inputEncoding) : undefined,
        failOnStdErr,
        timeout: timeout - (Date.now() - startTime)
    }, shell, ignoreExitCodes));

    core.setOutput('results-per-command', resultsPerCommand);

    if (outcome === 'failed') {
        core.setOutput('outcome', 'failed');
        core.setFailed(failCase);
    } else if (outcome === 'timeout') {
        await saveArtifacts(saveTarballArtifact, tarballGlob, tarballFileName, tarballRoot, artifactClient, tarballArtifactName);
        core.setOutput('outcome', 'timeout');
    } else {
        if (afterRun) { // run with no timeout
            ({ outcome, failCase } = await afterRun({
                cwd,
                ignoreReturnCode: true,
                failOnStdErr
            }, shell, ignoreExitCodes));

            core.setOutput('after-run-outcome', outcome);
            if (outcome == 'failed') {
                core.setOutput('outcome', 'failed');
                core.setFailed(`After-run hook failed: ${failCase}`);
            } else {
                core.setOutput('outcome', 'success');
            }
        } else {
            core.setOutput('after-run-outcome', 'skipped');
            core.setOutput('outcome', 'success');
        }

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
 * @param {Shell} shell
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
/**
 * @param {string} inputName
 */
function getExecutor(inputName, required = false) {
    const multiLineRun = core.getMultilineInput(inputName, { required });
    const singleLineRun = core.getInput(inputName, { required });

    if (!singleLineRun && !required) {
        return undefined;
    }

    /**
     * @param {ExecOptions & { timeout?: number; }} execOptions
     * @param {Shell} shell
     * @param {number[]} ignoreReturnCodes
     * @returns {Promise<{outcome: 'success' | 'failed' | 'timeout', resultsPerCommand: (number | 'timeout')[], failCase?: string}>}
     */
    return async (execOptions, shell, ignoreReturnCodes) => {

        /** @type {(number | 'timeout')[]} */
        const resultsPerCommand = [];

        if (shell === 'none') {
            for (const command of multiLineRun) {
                const [timedOut, returnCode] = await exec(command, undefined, execOptions);

                if (timedOut || ignoreReturnCodes.includes(returnCode)) {
                    resultsPerCommand.push('timeout');
                    return {
                        outcome: 'timeout',
                        resultsPerCommand,
                        failCase: undefined
                    };
                }

                resultsPerCommand.push(returnCode);

                if (returnCode !== 0) {
                    return {
                        outcome: 'failed',
                        resultsPerCommand,
                        failCase: `Command ${command} returned exit code: ${returnCode}`
                    };
                }
            }
        } else {
            const [timedOut, returnCode] = await exec(...await wrapInShell(singleLineRun, shell), execOptions);

            if (timedOut || ignoreReturnCodes.includes(returnCode)) {
                resultsPerCommand.push('timeout');
                return {
                    outcome: 'timeout',
                    resultsPerCommand,
                };
            }

            resultsPerCommand.push(returnCode);

            if (returnCode !== 0) {
                return {
                    outcome: 'failed',
                    resultsPerCommand,
                    failCase: `${shell} command '${singleLineRun}' returned exit code: ${returnCode}`
                };
            }
        }

        return {
            outcome: 'success',
            resultsPerCommand,
        };
    };
}

/**
 * @param {boolean} [saveTarballArtifact]
 * @param {string} [tarballGlob]
 * @param {string} [tarballFileName]
 * @param {string} [tarballRoot]
 * @param {import('@actions/artifact').ArtifactClient} [artifactClient]
 * @param {string} [tarballArtifactName]
 */
async function saveArtifacts(saveTarballArtifact, tarballGlob, tarballFileName, tarballRoot, artifactClient, tarballArtifactName) {
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
}

