// @ts-check

const core = require('@actions/core');
const io = require('@actions/io');
const fs = require('fs/promises');
// const { exec } = require('@actions/exec');
const artifact = require('@actions/artifact');
const glob = require('@actions/glob');
const path = require('path/win32');
const { ToolRunner, argStringToArray } = require('../../../../actions/multistep/execx');
const { generateCtrlBreakAsync } = require('generate-ctrl-c-event');
const util = require('util');
const { glob: glob2 } = require('glob');

const { extractTar, createTar } = require('./tar');
const { ChildProcess } = require('child_process');

/**
 * @typedef {'none' | 'pwsh' | 'cmd' | 'python' | 'node'} Shell
 * @typedef {import('@actions/exec').ExecOptions} ExecOptions
 * @typedef {import('../../../../actions/multistep/execx').ExecPublicState} ExecPublicState
 */

const delayedSymbol = Symbol('delayed');

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<{ timedOut: boolean, result: T | Promise<T> }>}
 */
async function awaitWithTimeout(promise, ms) {
    const { promise: delayPromise, cancel: cancelDelay } = delayCancelable(ms);
    const result = await Promise.race([promise, delayPromise]);
    if (result !== delayedSymbol) { // did not timeout
        cancelDelay();
        return { timedOut: false, result };
    } else { // did timeout
        return { timedOut: true, result: promise };
    }
}

/**
 * @param {ExecPublicState} proc
 */
async function killCleanly(proc) {
    // Wait to see if the process closes itself
    await delay(1000);
    if (proc.processExited) {
        return;
    }

    // if process is still running
    const maxRetries = 3;
    for (let i = 0; i < maxRetries; i++) { // attempt to send ctrl+break
        console.log(`Sending CTRL+BREAK to process ${util.inspect(proc)} attempt ${i+1} of ${maxRetries}`);
        await generateCtrlBreakAsync(proc.pid);
        await delay(3000);

        if (proc.processExited) {
            return;
        }
    }

    await awaitWithTimeout(proc.processClosedPromise, 10_000);
    if (proc.processExited) {
        return;
    }

    console.warn(`Killing process ${util.inspect(proc)}`);
    proc.kill(); // kill it with fire
}

/**
 *
 * @param {string} commandLine
 * @param {string[]} [args]
 * @param {ExecOptions & { timeout?: number }} [options]
 * @returns {Promise<{ timedOut: boolean, exitCode: number }>}
 */
async function exec(commandLine, args, options) {
    const commandArgs = argStringToArray(commandLine);
    if (commandArgs.length === 0) {
        throw new Error(`Parameter 'commandLine' cannot be null or empty.`);
    }
    // Path to tool to execute should be first arg
    const runner = new ToolRunner(commandArgs[0], [...commandArgs.slice(1), ...(args || [])], options);

    /** @type {ExecPublicState} */
    const proc = await runner.exec();

    const timeout = options?.timeout;
    if (timeout == null) {
        return { timedOut: false, exitCode: await proc.processClosedPromise };
    }

    const { timedOut } = await awaitWithTimeout(proc.processClosedPromise, timeout)
    if (!timedOut) { // did not time out
        return { timedOut: false, exitCode: proc.processExitCode };
    }

    proc.unref();
    await killCleanly(proc);
    return { timedOut: true, exitCode: proc.processExitCode };

}

/**
 * @param {number} ms
 * @returns {Promise<typeof delayedSymbol>}
 */
function delay(ms) {
    return new Promise(r => setTimeout(() => r(delayedSymbol), ms));
}

/**
 * @param {number} ms
 * @returns {{ promise: Promise<typeof delayedSymbol>, cancel: () => void }}
 */
function delayCancelable(ms) {
    /** @type {(result: typeof delayedSymbol) => void} */
    let r;
    const promise = new Promise(r1 => r = r1);
    const timeout = setTimeout(() => r(delayedSymbol), ms);
    return { promise, cancel: () => clearTimeout(timeout) };
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
        if (err && typeof err === 'object' && 'message' in err && (err.message === 'Unable to find any artifacts for the associated workflow' || err.message === `Unable to find an artifact with the name: ${artifactName}`)) {
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
    if (/[=\n\r]/.test(key)) {
        throw new Error(`Invalid key: ${key}`)
    }
    if (!process.env.GITHUB_ENV) {
        throw new Error('Not running on GitHub')
    }
    if (value.includes('\n')) {
        // Find longest sequence of string "EOF" followed by amount of $ symbols, add one more to get a unique delimiter nowhere seen in the string
        const delimiter = ((value.match(/EOF\$*/g)?.sort((a,b)=>b.length-a.length)[0]) ?? 'EOF') + '$';

        await fs.appendFile(process.env.GITHUB_ENV, `\n${key}<<${delimiter}\n${value}\n${delimiter}`);
    } else {
        await fs.appendFile(process.env.GITHUB_ENV, `\n${key}=${value}`);
    }
}

async function run() {
    process.on('SIGINT', function () {
    });

    // runs
    const run = getExecutor('run', true);
    const beforeRun = getExecutor('before-run', false);
    const afterRun = getExecutor('after-run', false);

    if (!run) throw 'fuck';

    // paths
    const cwd = path.resolve(core.getInput('cwd', { required: false })) || process.cwd();
    const tarballRoot = path.resolve(cwd, core.getInput('tarball-root', { required: true }));
    const tarballGlob = path.resolve(cwd, core.getInput('tarball-pattern', { required: false }) || tarballRoot);

    // archiving
    const tarballArtifactName = core.getInput('tarball-artifact-name', { required: false });
    const tarballFileName = core.getInput('tarball-file-name', { required: false });
    const loadTarballArtifactIfExists = core.getBooleanInput('load-tarball-artifact-if-exists', { required: false });
    const saveTarballArtifact = core.getBooleanInput('save-tarball-artifact', { required: false });

    // execution
    const shell = /** @type {Shell} */ (core.getInput('shell', { required: false }));
    const input = core.getInput('input', { required: false });
    const inputEncoding = /** @type {BufferEncoding} */ (core.getInput('input-encoding', { required: false }));
    const failOnStdErr = core.getBooleanInput('fail-on-stderr', { required: false });
    const ignoreExitCodes = core.getInput('ignore-exit-codes', { required: false }).split(',').map(e => Number(e.trim())).filter(e => !isNaN(e) && e !== 0);

    // timeout
    const key = core.getInput('key', { required: false });
    const timeout = Number(core.getInput('timeout', { required: false }))

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

    /** @type {number | undefined} */
    let endTime;
    if (key && process.env['STAGE_END_' + key]) {
        endTime = Number(process.env['STAGE_END_' + key]);
        core.info(`This build stage will time out at ${new Date(endTime)}`);
    }

    const isExecutionTimedOut = () => endTime && Date.now() > endTime;
    const calcTimeout = () => endTime ? Math.max(endTime - Date.now(), 1) : 1;

    if (beforeRun) { // run with no timeout
        // If timed out before we execute beforeRun
        if (isExecutionTimedOut()) {
            core.setOutput('results-per-command', []);
            core.setOutput('before-run-outcome', 'timeout');
            core.setOutput('outcome', 'timeout');
            core.setOutput('after-run-outcome', afterRun ? 'timeout' : 'skipped');
            core.notice('Timed out before before-hook execution');
            return;
            // NB: there are no artifacts to save here.
        }

        const { outcome, failCase } = await beforeRun({
            cwd,
            ignoreReturnCode: true,
            failOnStdErr
        }, shell, ignoreExitCodes);

        core.setOutput('before-run-outcome', outcome);
        if (outcome == 'failed') {
            core.setOutput('outcome', 'failed');
            core.setFailed(`Before-run hook failed: ${failCase}`);
        }
    } else {
        core.setOutput('before-run-outcome', 'skipped');
    }

    if (!endTime) {
        endTime = Date.now() + timeout;
        process.env['STAGE_END_' + key] = ''+endTime;
        storeEnvVariable('STAGE_END_' + key, ''+endTime);
        core.info(`This build stage will time out at ${new Date(endTime)}`);
    }

    // If timed out before we execute run
    if (isExecutionTimedOut()) {
        await saveArtifacts(saveTarballArtifact, tarballGlob, tarballFileName, tarballRoot, artifactClient, tarballArtifactName);
        core.setOutput('results-per-command', []);
        core.setOutput('outcome', 'timeout');
        core.setOutput('after-run-outcome', afterRun ? 'timeout' : 'skipped');
        core.notice('Timed out before main command execution');
        return;
    }

    const { outcome, resultsPerCommand, failCase } = await run({
        cwd,
        ignoreReturnCode: true,
        input: input ? Buffer.from(input, inputEncoding) : undefined,
        failOnStdErr,
        timeout: calcTimeout()
    }, shell, ignoreExitCodes);

    console.log(`Command execution completed with outcome: ${outcome} (Fail case: ${failCase})`)

    core.setOutput('results-per-command', resultsPerCommand);

    if (outcome === 'failed') {
        core.setOutput('outcome', 'failed');
        core.setFailed(failCase || new Error('Unknown error'));
    } else if (outcome === 'timeout') {
        await saveArtifacts(saveTarballArtifact, tarballGlob, tarballFileName, tarballRoot, artifactClient, tarballArtifactName);
        core.setOutput('outcome', 'timeout');
        core.notice('Execution has timed out');
    } else {
        if (afterRun) { // run with no timeout
            const { outcome, failCase } = await afterRun({
                cwd,
                ignoreReturnCode: true,
                failOnStdErr
            }, shell, ignoreExitCodes);

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
                console.log(`Using pwsh at path: ${pwshPath}`);
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
                console.log(`Using powershell at path: ${powershellPath}`);
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
                core.info(`Executing command: ${command}`);
                const {timedOut, exitCode} = await exec(command, undefined, execOptions);

                if (timedOut || ignoreReturnCodes.includes(exitCode)) {
                    resultsPerCommand.push('timeout');
                    return {
                        outcome: 'timeout',
                        resultsPerCommand,
                        failCase: timedOut ? `'exec' timed out` : `Return code was in ignore-return-codes list: ${exitCode}`
                    };
                }

                resultsPerCommand.push(exitCode);

                if (exitCode !== 0) {
                    return {
                        outcome: 'failed',
                        resultsPerCommand,
                        failCase: `Command ${command} returned exit code: ${exitCode}`
                    };
                }
            }
        } else {
            core.info(`Executing command with shell ${shell}: ${singleLineRun}`);
            const {timedOut, exitCode} = await exec(...await wrapInShell(singleLineRun, shell), execOptions);

            if (timedOut || ignoreReturnCodes.includes(exitCode)) {
                resultsPerCommand.push('timeout');
                return {
                    outcome: 'timeout',
                    resultsPerCommand,
                    failCase: timedOut ? `'exec' timed out` : `Return code was in ignore-return-codes list: ${exitCode}`
                };
            }

            resultsPerCommand.push(exitCode);

            if (exitCode !== 0) {
                return {
                    outcome: 'failed',
                    resultsPerCommand,
                    failCase: `${shell} command '${singleLineRun}' returned exit code: ${exitCode}`
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
 * @param {boolean} saveTarballArtifact
 * @param {string} tarballGlob
 * @param {string} tarballFileName
 * @param {string} tarballRoot
 * @param {import('@actions/artifact').ArtifactClient} artifactClient
 * @param {string} tarballArtifactName
 */
async function saveArtifacts(saveTarballArtifact, tarballGlob, tarballFileName, tarballRoot, artifactClient, tarballArtifactName) {
    await core.group('Pausing and saving build artifacts for next step', async () => {
        await delay(5000);

        if (saveTarballArtifact) {
            console.time('glob');
            const globbed = await util.promisify(glob2)(path.join(tarballGlob, '**'), {
                windowsPathsNoEscape: true,
                dot: true,
                nobrace: true,
                noext: true,
                nodir: true,
                absolute: true,
            });
            console.timeEnd('glob');
            console.log(`Globbed ${globbed.length} files`);
            //const globbed = await glob.create(tarballGlob, { matchDirectories: false }).then(e => e.glob());

            await core.group('Tarballing build files', async () => {
                await createTar(path.join(tarballRoot, tarballFileName), tarballRoot, globbed, 'zstd');
            });

            await repeatOnFail('Upload artifact', async () => {
                await artifactClient.uploadArtifact(tarballArtifactName, [path.join(tarballRoot, tarballFileName)], tarballRoot, { retentionDays: 3 });
            });
        }
    });
}

