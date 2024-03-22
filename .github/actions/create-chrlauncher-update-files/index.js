// @ts-check

const fs = require('fs');
const path = require('path');

const projectRoot = './';
const ungoogledChromiumRoot = './ungoogled-chromium';

const version = fs.readFileSync(path.join(ungoogledChromiumRoot, 'chromium_version.txt'), 'utf-8').trim();
const revision = fs.readFileSync(path.join(ungoogledChromiumRoot, 'revision.txt'), 'utf-8').trim();
const packagingRevision = fs.readFileSync(path.join(projectRoot, 'revision.txt'), 'utf-8').trim();

const tags = {
    'x64': {
        'browser': 'chromium',
        'os': 'windows',
        'architecture': '64-bit',
        'timestamp': Math.floor(Date.now() / 1000),
        'editor': 'uwx',
        'channel': 'stable',
        'repository': 'https://github.com/uwx/ungoogled-chromium-windows/releases',
        'download': `https://github.com/uwx/ungoogled-chromium-windows/releases/download/${process.env.RELEASE_TAG}/ungoogled-chromium_${version}-${revision}.${packagingRevision}_windows_x64.zip`,
        'version': version,
        'revision': `${revision}.${packagingRevision}`,
        'commit': process.env.GITHUB_SHA?.trim(),
    },
    'x86': {
        'browser': 'chromium',
        'os': 'windows',
        'architecture': '32-bit',
        'timestamp': Math.floor(Date.now() / 1000),
        'editor': 'uwx',
        'channel': 'stable',
        'repository': 'https://github.com/uwx/ungoogled-chromium-windows/releases',
        'download': `https://github.com/uwx/ungoogled-chromium-windows/releases/download/${process.env.RELEASE_TAG}/ungoogled-chromium_${version}-${revision}.${packagingRevision}_windows_x86.zip`,
        'version': version,
        'revision': revision,
        'commit': process.env.GITHUB_SHA?.trim(),
    }
};

for (const [id, tag] of Object.entries(tags)) {
    const text = Object.entries(tag).map(([k, v]) => `${k}=${v}`).join(';') + '\n';
    fs.writeFileSync(`./chrlauncher_update_${id}.txt`, text);
}
