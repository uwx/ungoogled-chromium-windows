// @ts-check

const core = require('@actions/core');
const io = require('@actions/io');
const exec = require('@actions/exec');
const artifact = require('@actions/artifact');
const glob = require('@actions/glob');
const path = require('path/win32');

const { extractTar, createTar } = require('./tar');

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function run() {
    // Where the repository is cloned to
    const basedir = process.env.PROJECT_LOCATION || 'C:\\ungoogled-chromium-windows';

    process.on('SIGINT', function() {
    });

    const finished = core.getBooleanInput('finished', {required: true});
    const from_artifact = core.getBooleanInput('from_artifact', {required: true});
    const x86 = core.getBooleanInput('x86', {required: false});
    const override_command = core.getInput('override_command', {required: false});
    const no_build = core.getBooleanInput('no_build', {required: false});

    console.log(`finished: ${finished}, artifact: ${from_artifact}`);
    if (finished) {
        core.setOutput('finished', true);
        return;
    }

    const artifactClient = artifact.create();
    const artifactName = x86 ? 'build-artifact-x86' : 'build-artifact';

    if (from_artifact) {
        await core.group('Downloading and extracting artifact', async () => {
            await artifactClient.downloadArtifact(artifactName, path.join(basedir, 'build'));
            extractTar(path.join(basedir, 'build', 'artifacts.tar.zstd'), 'zstd', path.join(basedir, 'build'));
            await io.rmRF(path.join(basedir, 'build', 'artifacts.tar.zstd'));
        });
    }

    const args = override_command
        ? ['-u', ...override_command.split(' ')]
        : ['-u', 'build.py', '--ci', '--7z-path', await io.which('7z', true), ...(x86 ? ['--x86'] : []), ...(no_build ? ['--no-build'] : [])];
    // -u: unbuffered output

    const retCode = await exec.exec('python', args, {
        cwd: basedir,
        ignoreReturnCode: true
    });
    if (retCode === 0) {
        core.setOutput('finished', true);
        const globber = await glob.create(path.join(basedir, 'build', 'ungoogled-chromium*'), {matchDirectories: false});

        await core.group('Uploading Chromium package', async () => {
            /** @type {string[]} */
            let packageList = [];
            for await (const x of globber.globGenerator()) {
                const newPath = x.slice(0, -4) + (x86 ? '_x86' : '_x64') + x.slice(-4);
                await io.mv(x, newPath);
                packageList.push(newPath);
            }

            const maxRetries = 5;
            for (let i = 0; i < maxRetries; ++i) {
                try {
                    await artifactClient.uploadArtifact(x86 ? 'chromium-x86' : 'chromium', packageList, path.join(basedir, 'build'), {retentionDays: 3});
                    break;
                } catch (e) {
                    console.error(`Upload artifact failed: ${e}. Attempt ${i + 1} of ${maxRetries}`);
                    // Wait 10 seconds between the attempts
                    await delay(10000);
                }
            }
        });
    } else if (retCode !== 124) {
        core.setOutput('finished', false);
        core.setFailed('Build script returned exit code: ' + retCode);
    } else {
        await core.group('Pausing and saving build artifacts for next step', async () => {
            await delay(5000);
            const globbed = await glob.create(path.join(basedir, 'build', 'src'), { matchDirectories: false }).then(e => e.glob());

            await core.group('Tarballing build files', async () => {
                await createTar(path.join(basedir, 'artifacts.tar.zstd'), basedir, globbed, 'zstd');
            });

            const maxRetries = 5;
            for (let i = 0; i < maxRetries; ++i) {
                try {
                    await artifactClient.uploadArtifact(artifactName, [path.join(basedir, 'artifacts.tar.zstd')], basedir, {retentionDays: 3});
                    break;
                } catch (e) {
                    console.error(`Upload artifact failed: ${e}. Attempt ${i + 1} of ${maxRetries}`);
                    // Wait 10 seconds between the attempts
                    await delay(10000);
                }
            }
            core.setOutput('finished', false);
        });
    }
}

run().catch(err => core.setFailed(err.message));