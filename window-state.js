const DEFAULT_BOUNDS = { width: 460, height: 460 };
const MIN_BOUNDS = { width: 320, height: 280 };

function restoreWindowState(savedState, workAreas, primaryArea) {
  const saved = savedState && typeof savedState === 'object' ? savedState : {};
  const dimension = (value, fallback, minimum) =>
    Number.isFinite(Number(value)) && Number(value) > 0
      ? Math.max(Math.round(Number(value)), minimum)
      : fallback;
  const width = dimension(saved.width, DEFAULT_BOUNDS.width, MIN_BOUNDS.width);
  const height = dimension(saved.height, DEFAULT_BOUNDS.height, MIN_BOUNDS.height);
  const hasPosition = Number.isFinite(saved.x) && Number.isFinite(saved.y);

  // A saved position can belong to a monitor that is no longer connected.
  const area = (hasPosition && workAreas.find(display =>
    saved.x < display.x + display.width && saved.x + width > display.x &&
    saved.y < display.y + display.height && saved.y + height > display.y
  )) || primaryArea;
  const bounds = {
    width: Math.min(width, area.width),
    height: Math.min(height, area.height),
    alwaysOnTop: saved.alwaysOnTop !== false
  };
  const x = hasPosition ? Math.round(saved.x) : area.x + Math.round((area.width - bounds.width) / 2);
  const y = hasPosition ? Math.round(saved.y) : area.y + Math.round((area.height - bounds.height) / 2);
  bounds.x = Math.max(area.x, Math.min(x, area.x + area.width - bounds.width));
  bounds.y = Math.max(area.y, Math.min(y, area.y + area.height - bounds.height));
  return bounds;
}

module.exports = { restoreWindowState, DEFAULT_BOUNDS, MIN_BOUNDS };
