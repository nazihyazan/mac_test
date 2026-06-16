const { _electron: electron } = require('playwright');
const path = require('path');

(async () => {
  try {
    console.log('Launching Electron app...');
    // Launch Electron app
    const electronApp = await electron.launch({
      args: ['.'],
    });

    // Get the first window
    const window = await electronApp.firstWindow();
    console.log('Window loaded.');

    // Wait for the window to load completely
    await window.waitForLoadState('domcontentloaded');

    // Wait extra 3 seconds to ensure animations (glassmorphism) render
    console.log('Waiting for UI to settle...');
    await window.waitForTimeout(3000);

    // Take screenshot
    console.log('Taking screenshot...');
    await window.screenshot({ path: 'mac-screenshot.png' });
    console.log('Screenshot saved to mac-screenshot.png');

    // Close app
    await electronApp.close();
  } catch (error) {
    console.error('Error taking screenshot:', error);
    process.exit(1);
  }
})();
