const assert = require('node:assert/strict');

async function boardRegression(app, page) {
  const originalBoard = await page.evaluate(() => window.floatingBoard.loadBoard());
  const imagePngs = await app.evaluate(({ nativeImage }) => {
    const images = [];
    for (let i = 0; i < 100; i++) {
      const pixels = Buffer.alloc(1280 * 720 * 4, i + 50);
      images.push(nativeImage.createFromBitmap(pixels, { width: 1280, height: 720 }).toPNG().toString('base64'));
    }
    return images;
  });
  const images = await page.evaluate(async pngs => {
    const items = [];
    for (const png of pngs) {
      const bytes = Uint8Array.from(atob(png), character => character.charCodeAt(0));
      items.push(await window.floatingBoard.saveBlob(bytes.buffer));
    }
    return items;
  }, imagePngs);
  const texts = originalBoard.sections.find(section => section.type === 'text').items;
  for (let i = texts.length; i < 100; i++) texts.push({ id: `test-text-${i}`, text: `Note ${i}\nSecond line`, createdAt: new Date().toISOString() });
  await page.evaluate(async board => {
    state = normalizeLoadedBoard(board);
    await saveNow();
  }, { version: 1, sections: [{ type: 'text', items: texts }, { type: 'image', items: images }] });
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.text-card').length === 100 && document.querySelectorAll('.media-item').length === 100);
  await page.waitForTimeout(200);

  const baselineUsage = await page.evaluate(() => window.floatingBoard.getDailyUsage());
  await page.evaluate(async text => { await Promise.all([addText(text), addText(text)]); }, texts[0].text);
  assert.equal(await page.locator('.text-card').count(), 100);
  assert.equal(await page.evaluate(() => window.floatingBoard.getDailyUsage()), baselineUsage, 'Duplicates must not consume daily allowance');

  // Read instrumentation checks the real X11 subscription: no clipboard reads at idle.
  await app.evaluate(({ clipboard }) => {
    global.clipboardReads = { text: 0, image: 0 };
    for (const [method, key] of [['readText', 'text'], ['readImage', 'image']]) {
      const original = clipboard[method].bind(clipboard);
      clipboard[method] = (...args) => { global.clipboardReads[key]++; return original(...args); };
    }
  });
  await page.waitForTimeout(1600);
  assert.deepEqual(await app.evaluate(() => global.clipboardReads), { text: 0, image: 0 }, 'Idle clipboard must not be polled');
  await app.evaluate(({ clipboard, nativeImage }, png) => {
    clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(png, 'base64')));
  }, imagePngs[0]);
  for (let i = 0; i < 50; i++) {
    if ((await app.evaluate(() => global.clipboardReads)).image > 0) break;
    await page.waitForTimeout(100);
  }
  assert.ok((await app.evaluate(() => global.clipboardReads)).image > 0, 'An actual clipboard change must trigger a read');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.media-item').count(), 100, 'An existing clipboard image must not be added twice');
  assert.equal(await page.evaluate(() => window.floatingBoard.getDailyUsage()), baselineUsage);

  const deletionTimes = [];
  for (const [containerSelector, cardSelector, buttonSelector] of [
    ['.text-list-container', '.text-card', '.delete-btn'],
    ['.media-grid', '.media-item', '.media-remove']
  ]) {
    const result = await page.evaluate(({ containerSelector, cardSelector, buttonSelector }) => {
      const container = document.querySelector(containerSelector);
      container.scrollTop = container.scrollHeight * 0.75;
      const before = container.scrollTop;
      const kept = container.querySelector(cardSelector);
      const viewport = container.getBoundingClientRect();
      const card = [...container.querySelectorAll(cardSelector)].find(card => {
        const rect = card.getBoundingClientRect();
        return rect.top >= viewport.top && rect.top < viewport.bottom;
      });
      if (!card) throw new Error('No visible card to delete');
      const start = performance.now();
      card.querySelector(buttonSelector).click();
      return { before, after: container.scrollTop, kept: container.querySelector(cardSelector) === kept, elapsed: performance.now() - start };
    }, { containerSelector, cardSelector, buttonSelector });
    assert.ok(result.before > 100);
    assert.ok(Math.abs(result.before - result.after) < 2, `${containerSelector} must preserve its scroll position`);
    assert.ok(result.kept, 'Unchanged DOM cards must be retained');
    assert.ok(result.elapsed < 500, 'Deleting one of 100 cards should not stall the UI');
    deletionTimes.push(Math.round(result.elapsed));
  }
  await page.waitForTimeout(200);
  const loadedPreviews = await page.locator('.media-grid img[src]').count();
  assert.ok(loadedPreviews < 30, `Expected a bounded number of decoded previews, got ${loadedPreviews}`);

  const beforeBounds = await page.evaluate(() => window.floatingBoard.getWindowBounds());
  const boardBox = await page.locator('.media-grid').boundingBox();
  await page.mouse.move(boardBox.x + 20, boardBox.y + 20);
  await page.mouse.down();
  await page.mouse.move(boardBox.x + 80, boardBox.y + 50, { steps: 5 });
  await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => window.floatingBoard.getWindowBounds()), beforeBounds, 'Dragging board contents must not move the window');
  assert.equal(await page.locator('.chrome-bar').evaluate(el => getComputedStyle(el).getPropertyValue('-webkit-app-region')), 'drag');

  // A new image is imported by the notification; pasting it again remains a duplicate.
  await app.evaluate(({ clipboard, nativeImage }) => {
    clipboard.writeImage(nativeImage.createFromBitmap(Buffer.alloc(64 * 64 * 4, 240), { width: 64, height: 64 }));
  });
  await page.waitForFunction(() => document.querySelectorAll('.media-item').length === 100);
  const usageAfterNewImage = await page.evaluate(() => window.floatingBoard.getDailyUsage());
  await page.locator('#board').focus();
  await page.keyboard.press('Control+v');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.media-item').count(), 100);
  assert.equal(await page.evaluate(() => window.floatingBoard.getDailyUsage()), usageAfterNewImage);

  await page.evaluate(() => saveNow());
  await page.reload();
  await page.waitForFunction(() => document.querySelectorAll('.text-card').length === 99 && document.querySelectorAll('.media-item').length === 100);
  const memory = await app.evaluate(({ app }) => Math.round(app.getAppMetrics().reduce((total, metric) => total + metric.memory.workingSetSize, 0) / 1024));
  console.log(`PASS 100 images + 100 notes: event-driven clipboard, zero idle reads, deduplication, preserved scroll/DOM, header-only movement; deletion ${deletionTimes.join('/')} ms, ${loadedPreviews} loaded previews, process working sets ${memory} MiB`);
}

module.exports = { boardRegression };
