const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');

if (process.platform !== 'win32') {
  console.error('The Windows health smoke test must run on Windows.');
  process.exit(1);
}

const project = path.resolve(__dirname, '..');
const executablePath = process.env.FLOATBOARD_WINDOWS_EXECUTABLE || require('electron');
const packaged = Boolean(process.env.FLOATBOARD_WINDOWS_EXECUTABLE);
const profile = path.join(os.tmpdir(), `floatboard-windows-health-${Date.now()}`);

async function launch() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const instance = await electron.launch({
    executablePath,
    args: [...(packaged ? [] : [project]), `--user-data-dir=${profile}`],
    env,
    timeout: 30000
  });
  const page = await instance.firstWindow({ timeout: 20000 });
  await page.waitForFunction(() => window.floatingBoard && document.querySelector('#board'));
  assert.equal(await instance.evaluate(({ app }) => app.getPath('userData')), profile);
  return { instance, page };
}

async function quit(instance) {
  const process = instance.process();
  const exited = new Promise((resolve, reject) => {
    if (process.exitCode !== null) return resolve(process.exitCode);
    const deadline = setTimeout(() => reject(new Error('FloatBoard did not exit within 5 seconds')), 5000);
    process.once('exit', code => { clearTimeout(deadline); resolve(code); });
  });
  await instance.evaluate(({ app }) => { setImmediate(() => app.quit()); });
  assert.equal(await exited, 0);
}

(async () => {
  let running;
  try {
    await fs.mkdir(profile, { recursive: true });
    running = await launch();
    const { instance, page } = running;
    const clipText = `Windows clipboard event ${Date.now()}`;
    await page.evaluate(() => window.floatingBoard.onHistoryShow(history => { window.__testHistory = history; }));

    // An idle app must not repeatedly read the clipboard.
    await instance.evaluate(({ clipboard }) => {
      global.__clipboardReads = 0;
      const original = clipboard.readText.bind(clipboard);
      clipboard.readText = (...args) => { global.__clipboardReads++; return original(...args); };
    });
    await page.waitForTimeout(1400);
    assert.equal(await instance.evaluate(() => global.__clipboardReads), 0);

    await instance.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipText);
    await page.waitForFunction(text => {
      window.floatingBoard.requestClipboardHistory();
      return window.__testHistory?.some(item => item.content === text);
    }, clipText, { timeout: 5000 });
    assert.ok((await instance.evaluate(() => global.__clipboardReads)) > 0);

    // The title bar close button hides to tray, and an explicit quit terminates.
    await page.evaluate(() => window.floatingBoard.close());
    await page.waitForFunction(async () => !(await window.floatingBoard.getWindowState()).visible);
    await instance.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await page.waitForFunction(async () => (await window.floatingBoard.getWindowState()).visible);

    await instance.evaluate(({ clipboard }, text) => clipboard.writeText(text), 'Saved before quit');
    await page.locator('#board').focus();
    await page.keyboard.press('Control+v');
    const editor = page.locator('.text-card-editor').first();
    await editor.waitFor();
    await editor.fill('Last edit must survive immediate quit');
    await quit(instance);
    running = null;

    running = await launch();
    await running.page.waitForFunction(() => [...document.querySelectorAll('.text-card-editor')]
      .some(editor => editor.value === 'Last edit must survive immediate quit'));
    await quit(running.instance);
    running = null;
    console.log(`PASS Windows ${packaged ? 'packaged' : 'source'}: launch, event-driven clipboard, tray, save and quit`);
  } finally {
    if (running) await running.instance.close().catch(() => {});
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
