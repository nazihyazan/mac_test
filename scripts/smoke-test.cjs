const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

const project = path.resolve(__dirname, '..');

async function smokeTest({ executablePath, snap = false } = {}) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'floatboard-smoke-'));
  const sample = 'Clipboard <example> & "quotes"\n</textarea><span id="clipboard-markup">literal text</span>';
  const logs = [];
  let app;

  async function launch() {
    const env = { ...process.env, XDG_CONFIG_HOME: path.join(profile, 'config') };
    delete env.ELECTRON_RUN_AS_NODE;
    if (snap) env.SNAP = path.dirname(executablePath);
    else delete env.SNAP;
    app = await electron.launch({
      executablePath,
      args: [
        ...(executablePath ? [] : [project]),
        '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`
      ],
      env,
      timeout: 20000
    });
    app.process().stderr.on('data', chunk => logs.push(chunk.toString()));
    const page = await app.firstWindow({ timeout: 15000 });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => window.floatingBoard && document.querySelector('#board'));
    await page.waitForFunction(async () => (await window.floatingBoard.getWindowState()).visible);
    assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);
    const onScreen = await app.evaluate(({ BrowserWindow, screen }) => {
      const bounds = BrowserWindow.getAllWindows()[0].getBounds();
      return screen.getAllDisplays().some(({ workArea: area }) =>
        bounds.x >= area.x && bounds.y >= area.y &&
        bounds.x + bounds.width <= area.x + area.width &&
        bounds.y + bounds.height <= area.y + area.height
      );
    });
    assert.ok(onScreen, 'The main window must open inside a connected display');
    return { page, errors };
  }

  try {
    let { page, errors } = await launch();
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), sample);
    await page.locator('#board').focus();
    await page.keyboard.press('Control+v');
    const editor = page.locator('.text-card-editor').first();
    await editor.waitFor();
    assert.equal(await editor.inputValue(), sample, 'Pasted text must round-trip literally');
    assert.equal(await page.locator('#clipboard-markup').count(), 0, 'Clipboard HTML must not create elements');
    await page.waitForFunction(async text => {
      const board = await window.floatingBoard.loadBoard();
      return board.sections.some(section => section.items.some(item => item.text === text));
    }, sample);
    await app.evaluate(({ clipboard }) => clipboard.clear());
    await page.locator('.text-card .copy-btn').first().click();
    assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), sample);

    const beforeTheme = await page.locator('html').getAttribute('data-theme');
    await page.locator('#theme-toggle-btn').click();
    const theme = await page.locator('html').getAttribute('data-theme');
    assert.notEqual(theme, beforeTheme);
    const beforePin = await page.evaluate(() => window.floatingBoard.getWindowState());
    await page.locator('#pin-btn').click();
    await page.waitForFunction(async value =>
      (await window.floatingBoard.getWindowState()).pinned !== value, beforePin.pinned);

    if (snap) {
      assert.ok(await app.evaluate(({ app }) => app.commandLine.hasSwitch('disable-dev-shm-usage')));
      assert.equal(await page.evaluate(() => window.floatingBoard.quitAndInstallUpdate()), false);
      assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()));
    }
    assert.deepEqual(errors, []);
    await app.close();
    app = null;

    // Simulate a saved window position from an unplugged monitor.
    await fs.writeFile(path.join(profile, 'window-state.json'), JSON.stringify({
      x: 20000, y: 20000, width: 460, height: 460, alwaysOnTop: false
    }));
    ({ page, errors } = await launch());
    await page.locator('.text-card-editor').first().waitFor();
    assert.equal(await page.locator('.text-card-editor').first().inputValue(), sample);
    assert.equal(await page.locator('#clipboard-markup').count(), 0);
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
    assert.equal((await page.evaluate(() => window.floatingBoard.getWindowState())).pinned, false);
    assert.deepEqual(errors, []);
    await app.close();
    app = null;

    // A valid JSON file can still contain an invalid state, e.g. null.
    await fs.writeFile(path.join(profile, 'window-state.json'), 'null');
    ({ page, errors } = await launch());
    await page.locator('.text-card-editor').first().waitFor();
    assert.equal(await page.locator('.text-card-editor').first().inputValue(), sample);
    assert.deepEqual(errors, []);
    if (snap) assert.ok(!logs.some(line => /AppImage|checkForUpdatesAndNotify|Failed to check for updates/.test(line)), 'Snap must not invoke the AppImage updater');
    await require('./board-regression.cjs').boardRegression(app, page);
    assert.deepEqual(errors, []);
    await app.close();
    app = null;
    ({ page, errors } = await launch());
    await page.waitForFunction(() => document.querySelectorAll('.text-card').length === 99 && document.querySelectorAll('.media-item').length === 100);
    await page.waitForTimeout(500);
    const metrics = await app.evaluate(({ app }) => app.getAppMetrics().map(({ pid, type }) => ({ pid, type })));
    let proportionalKiB = 0;
    for (const { pid } of metrics) {
      const memory = await fs.readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
      proportionalKiB += Number(memory.match(/^Pss:\s+(\d+)/m)[1]);
    }
    console.log(`Fresh restart with 100 images and 99 notes: ${Math.round(proportionalKiB / 1024)} MiB proportional memory across ${metrics.length} application processes`);
    assert.deepEqual(errors, []);
    console.log(`PASS ${executablePath ? 'packaged app' : 'source'}: visible window, literal clipboard text, copy, persistence, theme, pin, off-screen and invalid-state recovery${snap ? ', snapd-managed updates' : ''}`);
  } catch (error) {
    console.error(logs.join(''));
    throw error;
  } finally {
    if (app) await app.close().catch(() => {});
    await fs.rm(profile, { recursive: true, force: true });
  }
}

if (require.main === module) {
  smokeTest().catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { smokeTest };
