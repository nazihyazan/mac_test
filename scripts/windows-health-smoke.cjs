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

async function verifyLargeClipboardRemainsResponsive(instance, page) {
  const halfRed = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DQAAAEgQGALFXOsAAAAABJRU5ErkJggg==';
  const transparentItem = await page.evaluate(async png => {
    const bytes = Uint8Array.from(atob(png), character => character.charCodeAt(0));
    return window.floatingBoard.saveBlob(bytes.buffer);
  }, halfRed);
  const transparencyPreserved = await instance.evaluate(({ nativeImage }, { filePath, png }) => {
    const saved = nativeImage.createFromPath(filePath);
    const original = nativeImage.createFromBuffer(Buffer.from(png, 'base64'));
    return saved.toBitmap().equals(original.toBitmap());
  }, { filePath: path.join(profile, 'media', transparentItem.fileName), png: halfRed });
  assert.ok(transparencyPreserved, 'Transparent screenshots must preserve their colors and alpha');

  const before = await page.locator('.media-item').count();
  await instance.evaluate(({ clipboard, nativeImage }) => {
    const width = 2048, height = 2048;
    const pixels = Buffer.allocUnsafe(width * height * 4);
    let seed = 0x12345678;
    for (let index = 0; index < pixels.length; index += 4) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels[index] = seed & 255;
      pixels[index + 1] = (seed >>> 8) & 255;
      pixels[index + 2] = (seed >>> 16) & 255;
      pixels[index + 3] = 255;
    }
    const image = nativeImage.createFromBitmap(pixels, { width, height });
    global.__largeClipboardBitmap = image.toBitmap();
    clipboard.writeImage(image);
    global.__maxClipboardLag = 0;
    let lastTick = Date.now();
    global.__clipboardLagTimer = setInterval(() => {
      const now = Date.now();
      global.__maxClipboardLag = Math.max(global.__maxClipboardLag, now - lastTick - 25);
      lastTick = now;
    }, 25);
  });
  await page.waitForFunction(count => document.querySelectorAll('.media-item').length > count,
    before, { timeout: 20000 });
  await page.evaluate(() => saveNow());
  const fileName = await page.evaluate(async () => {
    const board = await window.floatingBoard.loadBoard();
    return board.sections.find(section => section.type === 'image').items.at(-1).fileName;
  });
  const result = await instance.evaluate(({ nativeImage }, filePath) => {
    clearInterval(global.__clipboardLagTimer);
    const saved = nativeImage.createFromPath(filePath);
    const result = { lag: global.__maxClipboardLag,
      pixelsMatch: saved.toBitmap().equals(global.__largeClipboardBitmap) };
    global.__largeClipboardBitmap = null;
    return result;
  }, path.join(profile, 'media', fileName));
  assert.ok(result.lag < 800, `Large clipboard image blocked the main loop for ${result.lag} ms`);
  assert.ok(result.pixelsMatch, 'Stored screenshot must preserve its original pixels');
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
    await page.evaluate(() => saveNow());
    if (packaged) {
      await require('./board-regression.cjs').boardRegression(instance, page);
    }
    await verifyLargeClipboardRemainsResponsive(instance, page);
    await editor.fill('Last edit must survive immediate quit');
    await quit(instance);
    running = null;

    running = await launch();
    await running.page.waitForFunction(() => [...document.querySelectorAll('.text-card-editor')]
      .some(editor => editor.value === 'Last edit must survive immediate quit'));
    await quit(running.instance);
    running = null;
    console.log(`PASS Windows ${packaged ? 'packaged with 100-item board' : 'source'}: launch, event-driven clipboard, tray, save and quit`);
  } finally {
    if (running) await running.instance.close().catch(() => {});
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
