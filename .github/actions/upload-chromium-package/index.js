// @ts-check

const core = require('@actions/core');
const io = require('@actions/io');
const exec = require('@actions/exec');
const artifact = require('@actions/artifact');
const glob = require('@actions/glob');
const path = require('path/win32');

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function run() {
    // Where the repository is cloned to
    const basedir = core.getInput('project-location', { required: true });
    const x86 = core.getBooleanInput('x86', { required: false });

    const artifactClient = artifact.create();

    await core.group('Uploading Chromium package', async () => {
        /** @type {string[]} */
        let packageList = [];

        const globber = await glob.create(path.join(basedir, 'build', 'ungoogled-chromium*'), { matchDirectories: false });
        for await (const x of globber.globGenerator()) {
            const newPath = x.slice(0, -4) + (x86 ? '_x86' : '_x64') + x.slice(-4);
            await io.mv(x, newPath);
            packageList.push(newPath);
        }

        await repeatOnFail('Upload artifact', async () => {
            await artifactClient.uploadArtifact(x86 ? 'chromium-x86' : 'chromium', packageList, path.join(basedir, 'build'), { retentionDays: 3 });
        });
    });
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