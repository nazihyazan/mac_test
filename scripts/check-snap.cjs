const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { smokeTest } = require('./smoke-test.cjs');

async function checkSnap(file) {
  assert.ok(file, 'Usage: npm run test:snap -- path/to/FloatBoard.snap');
  const manifest = yaml.load(execFileSync('unsquashfs', ['-cat', file, 'meta/snap.yaml'], { encoding: 'utf8' }));
  const pkg = require('../package.json');
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.confinement, 'strict');
  const app = manifest.apps.floatboard;
  for (const plug of ['browser-support', 'desktop', 'x11', 'network', 'home']) {
    assert.ok(app.plugs.includes(plug), `Built Snap is missing the ${plug} interface`);
  }
  const launcher = execFileSync('unsquashfs', ['-cat', file, app.command], { encoding: 'utf8' });
  assert.match(launcher, /--no-sandbox/, 'Strict Snap relies on snapd confinement');
  const desktop = execFileSync('unsquashfs', ['-cat', file, 'meta/gui/floatboard.desktop'], { encoding: 'utf8' });
  assert.match(desktop, /^Exec=floatboard %U$/m);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'floatboard-package-'));
  try {
    const extracted = path.join(directory, 'app');
    execFileSync('unsquashfs', ['-no-progress', '-d', extracted, file], { stdio: 'pipe' });
    console.log('PASS Snap manifest and launcher; running extracted payload (not a confinement test)');
    await smokeTest({ executablePath: path.join(extracted, 'floatboard'), snap: true });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

checkSnap(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
