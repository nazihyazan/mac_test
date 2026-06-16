const { _electron: electron } = require('playwright');
const { execSync } = require('child_process');

function takeScreenshot(filename) {
  try {
    console.log(`Capturing screen to ${filename}...`);
    execSync(`screencapture -x "${filename}"`);
  } catch (err) {
    console.error(`Failed to capture screen: ${err}`);
  }
}

(async () => {
  try {
    console.log('Launching Electron app...');
    const electronApp = await electron.launch({ args: ['.'] });
    const window = await electronApp.firstWindow();
    
    // Fixed delay instead of waitForLoadState
    await window.waitForTimeout(3000);

    // Center window
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
         win.center();
         win.focus();
      }
    });
    await window.waitForTimeout(1000);

    console.log('1. Empty State');
    takeScreenshot('01_mac_empty.png');

    console.log('2. Settings Menu');
    await window.click('#settings-btn');
    await window.waitForTimeout(1000);
    takeScreenshot('02_mac_settings.png');
    await window.click('#settings-close-btn');
    await window.waitForTimeout(500);

    console.log('3. Shortcuts Menu');
    await window.click('#shortcuts-btn');
    await window.waitForTimeout(1000);
    takeScreenshot('03_mac_shortcuts.png');
    await window.click('#shortcuts-close-btn');
    await window.waitForTimeout(500);

    console.log('4. Dark Theme Toggle');
    await window.click('#theme-toggle-btn');
    await window.waitForTimeout(1000);
    takeScreenshot('04_mac_dark_mode.png');

    console.log('5. Testing Clipboard');
    await electronApp.evaluate(({ clipboard }) => {
      clipboard.writeText('Test from Mac CI');
    });
    await window.click('#history-btn');
    await window.waitForTimeout(1000);
    takeScreenshot('05_mac_history_opened.png');
    await window.click('#history-close-btn');
    await window.waitForTimeout(500);

    console.log('6. License Modal');
    await window.click('#activate-btn');
    await window.waitForTimeout(1000);
    takeScreenshot('06_mac_license.png');
    await window.click('#license-close-btn');
    await window.waitForTimeout(500);

    console.log('7. Window Resize');
    await window.setViewportSize({ width: 800, height: 600 });
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if(win) win.center();
    });
    await window.waitForTimeout(1000);
    takeScreenshot('07_mac_resized.png');

    console.log('8. Toggle Pin');
    await window.click('#pin-btn');
    await window.waitForTimeout(1000);
    takeScreenshot('08_mac_unpinned.png');

    console.log('9. Light Theme');
    await window.click('#theme-toggle-btn');
    await window.waitForTimeout(1000);
    takeScreenshot('09_mac_light_mode.png');

    console.log('10. Add Image');
    await window.evaluate(() => {
      const empty = document.getElementById('empty-state');
      if(empty) empty.style.display = 'none';
      const section = document.createElement('div');
      section.className = 'content-section';
      section.innerHTML = `
        <div class="section-header">
          <div class="section-label">
            <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>
            <span class="section-title">Clipboard Image</span>
          </div>
        </div>
        <div class="section-body">
          <div class="media-grid single">
            <div class="media-item">
              <img src="https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/img/playwright-logo.svg" style="background: #2b3137; padding: 20px;">
            </div>
          </div>
        </div>
      `;
      document.getElementById('sections').appendChild(section);
      document.getElementById('sections').setAttribute('data-count', '1');
    });
    await window.waitForTimeout(1000);
    takeScreenshot('10_mac_image_added.png');

    console.log('11. Quick Look');
    await window.keyboard.press('Space');
    await window.waitForTimeout(1000);
    await window.evaluate(() => {
       document.getElementById('image-preview-overlay').style.display = 'flex';
       document.getElementById('image-preview-img').src = 'https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/img/playwright-logo.svg';
    });
    takeScreenshot('11_mac_quick_look.png');
    
    console.log('12. Close Quick Look');
    await window.keyboard.press('Escape');
    await window.evaluate(() => {
       document.getElementById('image-preview-overlay').style.display = 'none';
    });
    await window.waitForTimeout(1000);
    takeScreenshot('12_mac_quick_look_closed.png');

    await electronApp.close();
    console.log('Test completed successfully!');
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
})();
