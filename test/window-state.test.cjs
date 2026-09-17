const test = require('node:test');
const assert = require('node:assert/strict');
const { restoreWindowState } = require('../window-state');

const primary = { x: 0, y: 0, width: 1280, height: 800 };
const left = { x: -1920, y: 0, width: 1920, height: 1080 };

function assertInside(bounds, area) {
  assert.ok(bounds.x >= area.x && bounds.y >= area.y);
  assert.ok(bounds.x + bounds.width <= area.x + area.width);
  assert.ok(bounds.y + bounds.height <= area.y + area.height);
}

test('recovers a window saved on a disconnected monitor', () => {
  const bounds = restoreWindowState({ x: 20000, y: 20000, width: 460, height: 460 }, [primary], primary);
  assertInside(bounds, primary);
  assert.equal(bounds.width, 460);
});

test('preserves a valid position on a monitor left of the primary screen', () => {
  const saved = { x: -1600, y: 100, width: 700, height: 500, alwaysOnTop: false };
  assert.deepEqual(restoreWindowState(saved, [primary, left], primary), saved);
});

test('fits an oversized or partially hidden window into the available work area', () => {
  const bounds = restoreWindowState({ x: 1200, y: -100, width: 5000, height: 5000 }, [primary], primary);
  assertInside(bounds, primary);
});

test('invalid saved data does not prevent startup', () => {
  for (const saved of [null, [], 'invalid', { width: 'invalid', height: Infinity, x: null, y: null }]) {
    const bounds = restoreWindowState(saved, [primary], primary);
    assertInside(bounds, primary);
    assert.equal(bounds.width, 460);
    assert.equal(bounds.height, 460);
    assert.equal(bounds.alwaysOnTop, true);
  }
});
