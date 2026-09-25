const { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, protocol, net, shell, clipboard, screen } = require('electron');
// Snap updates are installed by snapd, not the AppImage updater.
// Windows Store owns updates for its packages; the Windows test installer is updated manually.
const autoUpdater = process.env.SNAP || process.platform === 'win32' ? null : require('electron-updater').autoUpdater;
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { restoreWindowState, DEFAULT_BOUNDS, MIN_BOUNDS } = require('./window-state');
const { exec } = require('child_process');
// Snap has a private writable /tmp; avoid restricted Chromium /dev/shm names.
if (process.platform === 'linux' && process.env.SNAP) {
  app.commandLine.appendSwitch('disable-dev-shm-usage');
}
const { startClipboardWatcher, getClipboardWatcherStatus } = require('./clipboard-watcher');
const { createMediaStore } = require('./media-store');
const mediaStore = createMediaStore({ directory: getMediaDir, nativeImage });
let stopClipboardWatcher = () => {};
let inspectClipboard = () => {};


// Auto Updater config
if (autoUpdater) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
}

// Add updater IPC handlers
ipcMain.handle('updater:quit-and-install', () => {
  if (!autoUpdater) return false;
  autoUpdater.quitAndInstall();
  return true;
});

const { pathToFileURL } = require('url');
const crypto = require('crypto');
const { isPremium, activateLicense } = require('./license.js');
const { machineIdSync } = require('node-machine-id');

async function verifyWithKeygen(email, key) {
  try {
    const fingerprint = machineIdSync(true); // true to return original string

    // Dynamic import to use node fetch
    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
    // Or simpler, in electron main process we can use net.fetch which is built-in since Electron 21
    const { net } = require('electron');

    const response = await net.fetch('https://api.keygen.sh/v1/accounts/dcc57dd7-bfd1-4469-a4f4-7c8545660f76/licenses/actions/validate-key', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/vnd.api+json',
        'Accept': 'application/vnd.api+json'
      },
      body: JSON.stringify({
        meta: {
          key: key.trim(),
          scope: {
            fingerprint: fingerprint
          }
        }
      })
    });
    
    const data = await response.json();
    console.log('Keygen Validate Response:', JSON.stringify(data, null, 2));
    
    if (data.meta && data.meta.valid) {
      return true;
    }
    
    // If the key is valid but this specific machine hasn't been registered yet
    if (data.meta && (data.meta.code === 'NO_MACHINES' || data.meta.code === 'NO_MACHINE')) {
      console.log('Machine not registered. Attempting to register machine...');
      
      const activateResponse = await net.fetch('https://api.keygen.sh/v1/accounts/dcc57dd7-bfd1-4469-a4f4-7c8545660f76/machines', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.api+json',
          'Accept': 'application/vnd.api+json',
          'Authorization': `License ${key.trim()}`
        },
        body: JSON.stringify({
          data: {
            type: 'machines',
            attributes: {
              fingerprint: fingerprint,
              name: require('os').hostname() || 'FloatBoard User PC'
            },
            relationships: {
              license: {
                data: { type: 'licenses', id: data.data.id }
              }
            }
          }
        })
      });
      
      const activateData = await activateResponse.json();
      console.log('Keygen Machine Registration Response:', JSON.stringify(activateData, null, 2));
      
      if (activateData.data && activateData.data.id) {
        // Machine registered successfully!
        return true;
      }
    }
    
    return false;
  } catch (error) {
    console.error('Keygen validation error:', error);
    return false;
  }
}

const APP_NAME = 'FloatBoard';

let mainWindow = null;
let tray = null;
let saveWindowTimer = null;
let isQuitting = false;
let quitDrainStarted = false;
let restoreAlwaysOnTopAfterMinimize = false;

app.setName(APP_NAME);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app-media', privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

function getUserPath(...parts) {
  return path.join(app.getPath('userData'), ...parts);
}

function getBoardPath() {
  return getUserPath('board-data.json');
}

function getWindowStatePath() {
  return getUserPath('window-state.json');
}

function getMediaDir() {
  return getUserPath('media');
}

function getIconPath() {
  return path.join(__dirname, 'assets', 'icon.png');
}

function readJsonSync(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`Failed to read ${filePath}:`, error);
    return fallback;
  }
}

async function writeJsonAtomic(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tempPath, filePath);
}

function loadWindowState() {
  const state = readJsonSync(getWindowStatePath(), {});

  return restoreWindowState(
    state,
    screen.getAllDisplays().map(display => display.workArea),
    screen.getPrimaryDisplay().workArea
  );
}

function saveWindowStateSoon() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  clearTimeout(saveWindowTimer);

  saveWindowTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    const bounds = mainWindow.getBounds();
    writeJsonAtomic(getWindowStatePath(), {
      ...bounds,
      alwaysOnTop: mainWindow.isAlwaysOnTop()
    }).catch((error) => console.error('Failed to save window state:', error));
  }, 250);
}

function flushWindowState() {
  clearTimeout(saveWindowTimer);
  saveWindowTimer = null;
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve();
  return writeJsonAtomic(getWindowStatePath(), {
    ...mainWindow.getBounds(),
    alwaysOnTop: mainWindow.isAlwaysOnTop()
  });
}

function stopClipboardMonitoring() {
  const stop = stopClipboardWatcher;
  stopClipboardWatcher = () => {};
  stop();
}

function sendWindowStatus() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const isMax = mainWindow.isMaximized();
    mainWindow.webContents.send('window:status', {
      pinned: mainWindow.isAlwaysOnTop(),
      maximized: isMax,
      visible: mainWindow.isVisible()
    });
  }
}

function setPinned(value) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  mainWindow.setAlwaysOnTop(Boolean(value));
  saveWindowStateSoon();
  sendWindowStatus();
  updateTrayMenu();
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();

  // Restore always-on-top on restore/show
  const state = loadWindowState();
  mainWindow.setAlwaysOnTop(state.alwaysOnTop);

  sendWindowStatus();
}

function toggleWindowVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }

  if (mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide();
  } else {
    showWindow();
  }
}

function createTray() {
  const iconPath = getIconPath();
  const image = fs.existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 })
    : nativeImage.createEmpty();

  tray = new Tray(image);
  tray.setToolTip(APP_NAME);
  tray.on('click', toggleWindowVisibility);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;

  const pinned = mainWindow && !mainWindow.isDestroyed() ? mainWindow.isAlwaysOnTop() : true;
  const visible = mainWindow && !mainWindow.isDestroyed() ? mainWindow.isVisible() : false;

  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: visible ? 'Hide FloatBoard' : 'Show FloatBoard',
      click: toggleWindowVisibility
    },
    {
      label: 'Always on Top',
      type: 'checkbox',
      checked: pinned,
      click: (menuItem) => setPinned(menuItem.checked)
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
}

function createPinnedWindow(dataUrl) {
  const win = new BrowserWindow({
    width: 300,
    height: 300,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  const html = `
    <html>
    <head>
      <style>
        body { margin: 0; overflow: hidden; background: transparent; -webkit-app-region: drag; }
        img { width: 100%; height: 100%; object-fit: contain; }
        .close { position: absolute; top: 4px; right: 4px; background: red; color: white; border: none; border-radius: 50%; width: 20px; height: 20px; cursor: pointer; -webkit-app-region: no-drag; display: none; }
        body:hover .close { display: block; }
      </style>
    </head>
    <body>
      <button class="close" onclick="window.close()">X</button>
      <img src="${dataUrl}">
    </body>
    </html>
  `;
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function createWindow() {
  const state = loadWindowState();

  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: Math.min(MIN_BOUNDS.width, state.width),
    minHeight: Math.min(MIN_BOUNDS.height, state.height),
    title: APP_NAME,
    icon: getIconPath(),
    frame: false,
    transparent: false,
    backgroundColor: '#ffffff',
    hasShadow: true,
    resizable: true,
    minimizable: true,
    movable: true,
    skipTaskbar: false,
    show: false,
    alwaysOnTop: state.alwaysOnTop,
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: true
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    showWindow();

    if (process.env.TEST_STATE) {
      setTimeout(() => {
        const state = process.env.TEST_STATE;
        mainWindow.webContents.executeJavaScript(`
          if ('${state}' === 'dark') {
            document.documentElement.setAttribute('data-theme', 'dark');
            localStorage.setItem('theme', 'dark');
            if (window.api && window.api.changeTheme) window.api.changeTheme('dark');
          } else if ('${state}' === 'history') {
            document.getElementById('history-btn').click();
          } else if ('${state}' === 'shortcuts') {
            document.getElementById('shortcuts-btn').click();
          } else if ('${state}' === 'settings') {
            document.getElementById('settings-btn').click();
          }
        `);
        if (state === 'dark') mainWindow.setBackgroundColor('#1a1a1e');
      }, 500);
    }
  });

  mainWindow.webContents.on('context-menu', (_event, params) => {
    const template = [];
    
    if (params.isEditable) {
      template.push(
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' }
      );
    } else if (params.hasImageContents) {
      template.push({
        label: 'Copy as Screenshot',
        click: () => {
          mainWindow.webContents.send('context-menu:copy-screenshot', { x: params.x, y: params.y });
        }
      });
    } else if (params.selectionText) {
      template.push(
        { role: 'copy' },
        { type: 'separator' },
        { role: 'selectAll' }
      );
    } else {
      template.push(
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' }
      );
    }

    const menu = Menu.buildFromTemplate(template);
    menu.popup({ window: mainWindow });
  });

  mainWindow.on('focus', () => {
    if (!['xfixes', 'windows-message'].includes(getClipboardWatcherStatus())) inspectClipboard();
  });
  mainWindow.on('move', saveWindowStateSoon);
  mainWindow.on('resize', () => {
    saveWindowStateSoon();
    sendWindowStatus();
  });
  mainWindow.on('maximize', sendWindowStatus);
  mainWindow.on('unmaximize', sendWindowStatus);
  mainWindow.on('restore', () => {
    const state = loadWindowState();
    if (restoreAlwaysOnTopAfterMinimize || state.alwaysOnTop) {
      mainWindow.setAlwaysOnTop(true);
    }
    restoreAlwaysOnTopAfterMinimize = false;
    sendWindowStatus();
  });
  mainWindow.on('show', () => {
    sendWindowStatus();
    updateTrayMenu();
  });
  mainWindow.on('hide', updateTrayMenu);

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      updateTrayMenu();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.platform === 'win32') {
    // Windows can end a session without waiting for Electron's normal quit path.
    mainWindow.on('session-end', () => {
      clearTimeout(saveWindowTimer);
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try {
        fs.writeFileSync(getWindowStatePath(), JSON.stringify({
          ...mainWindow.getBounds(), alwaysOnTop: mainWindow.isAlwaysOnTop()
        }));
      } catch (error) { console.error('Failed to save state at session end:', error); }
    });
  }
}

function normalizeBoardForRenderer(board) {
  const normalized = {
    version: 1,
    sections: []
  };

  if (!board || !Array.isArray(board.sections)) return normalized;

  for (const section of board.sections) {
    if (section.type === 'text') {
      let items = [];
      if (Array.isArray(section.items)) {
        items = section.items;
      } else if (typeof section.text === 'string' && section.text.length > 0) {
        items = [{
          id: crypto.randomUUID(),
          text: section.text,
          createdAt: section.createdAt || new Date().toISOString()
        }];
      }

      normalized.sections.push({
        type: 'text',
        items: items,
        createdAt: section.createdAt || new Date().toISOString(),
        updatedAt: section.updatedAt || new Date().toISOString()
      });
      continue;
    }

    if ((section.type === 'image' || section.type === 'video') && Array.isArray(section.items)) {
      normalized.sections.push({
        type: section.type,
        items: section.items.map((item) => {
          if (item.storage === 'file' && item.fileName) {
            const mediaPath = path.join(getMediaDir(), item.fileName);
            return {
              ...item,
              src: mediaStore.mediaUrl(item.fileName),
              exists: fs.existsSync(mediaPath)
            };
          }

          return item;
        }).filter((item) => item.src || item.fileName),
        createdAt: section.createdAt || new Date().toISOString(),
        updatedAt: section.updatedAt || new Date().toISOString()
      });
    }
  }

  return normalized;
}

function getMediaKindFromMime(mime) {
  if (!mime) return null;
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  return null;
}

function getMediaKindFromName(name) {
  const cleanName = (name || '').split(/[?#]/)[0].toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|avif|svg)$/.test(cleanName)) return 'image';
  if (/\.(mp4|webm|mov|m4v|ogv|mkv|avi)$/.test(cleanName)) return 'video';
  return null;
}

function minimizeMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  restoreAlwaysOnTopAfterMinimize = mainWindow.isAlwaysOnTop();
  if (restoreAlwaysOnTopAfterMinimize) {
    mainWindow.setAlwaysOnTop(false);
  }

  mainWindow.setSkipTaskbar(false);
  mainWindow.blur();

  setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.minimize();
    updateTrayMenu();
  }, process.platform === 'linux' ? 80 : 0);
}

ipcMain.on('window:focus', () => {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
    mainWindow.focus();
  }
});

ipcMain.on('window:minimize', () => {
  minimizeMainWindow();
});

ipcMain.on('window:toggle-maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
  sendWindowStatus();
});

ipcMain.on('window:close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
});

ipcMain.on('app:quit', () => {
  isQuitting = true;
  app.quit();
});

ipcMain.on('window:toggle-pin', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  setPinned(!mainWindow.isAlwaysOnTop());
});

ipcMain.handle('window:get-state', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { pinned: true, maximized: false, visible: false };
  }

  return {
    pinned: mainWindow.isAlwaysOnTop(),
    maximized: mainWindow.isMaximized(),
    visible: mainWindow.isVisible()
  };
});

ipcMain.handle('window:get-bounds', () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { x: 0, y: 0, ...DEFAULT_BOUNDS };
  }

  return mainWindow.getBounds();
});

ipcMain.on('window:set-bounds', (_event, bounds) => {
  if (!mainWindow || mainWindow.isDestroyed() || !bounds) return;

  const current = mainWindow.getBounds();
  const next = {
    x: Number.isFinite(bounds.x) ? Math.round(bounds.x) : current.x,
    y: Number.isFinite(bounds.y) ? Math.round(bounds.y) : current.y,
    width: Math.max(Math.round(bounds.width || current.width), MIN_BOUNDS.width),
    height: Math.max(Math.round(bounds.height || current.height), MIN_BOUNDS.height)
  };

  mainWindow.setBounds(next);
});

ipcMain.handle('board:load', async () => {
  await fsp.mkdir(getMediaDir(), { recursive: true });
  const board = readJsonSync(getBoardPath(), { version: 1, sections: [] });
  const normalized = normalizeBoardForRenderer(board);
  for (const section of normalized.sections) {
    if (section.type !== 'image') continue;
    for (const item of section.items) {
      if (item.thumbnail && item.contentHash) {
        item.previewSrc = mediaStore.mediaUrl(item.thumbnail);
        continue;
      }
      if (item.storage !== 'file' || !item.fileName || item.exists === false) continue;
      try {
        const prepared = await mediaStore.prepareFile(item.fileName, item.name);
        item.contentHash = prepared.contentHash;
        item.thumbnail = prepared.thumbnail;
        item.previewSrc = prepared.previewSrc;
      } catch (error) { console.warn('Could not prepare image preview:', error.message); }
    }
  }
  return normalized;
});

let boardWrites = Promise.resolve();
ipcMain.handle('board:save', async (_event, data) => {
  const safeData = {
    version: 1,
    savedAt: new Date().toISOString(),
    sections: Array.isArray(data && data.sections) ? data.sections : []
  };

  const write = boardWrites.then(() => writeJsonAtomic(getBoardPath(), safeData));
  boardWrites = write.catch(() => {});
  await write;
  return true;
});

ipcMain.handle('license:is-premium', () => {
  return isPremium();
});

ipcMain.handle('license:activate', async (_event, email, key) => {
  const isValid = await verifyWithKeygen(email, key);
  if (isValid) {
    return activateLicense(email, key);
  }
  return false;
});

ipcMain.handle('license:check-daily-limit', async (_event, kind) => {
  if (isPremium()) return true;
  const limitKind = kind === 'video' ? 'image' : kind;
  if (limitKind !== 'text' && limitKind !== 'image') return true;

  const usagePath = getUserPath('daily-usage.json');
  const usage = readJsonSync(usagePath, {});
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;

  if (!usage.timestamp || (now - usage.timestamp) > ONE_DAY) {
    usage.timestamp = now;
    usage.text = 0;
    usage.image = 0;
  }

  const totalUsage = (usage.text || 0) + (usage.image || 0);

  if (totalUsage >= 10) {
    return false;
  }

  usage[limitKind] = (usage[limitKind] || 0) + 1;
  await writeJsonAtomic(usagePath, usage);
  return true;
});

ipcMain.handle('license:get-daily-usage', () => {
  if (isPremium()) return 0;
  const usagePath = getUserPath('daily-usage.json');
  const usage = readJsonSync(usagePath, {});
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;

  if (!usage.timestamp || (now - usage.timestamp) > ONE_DAY) {
    return 0;
  }
  return (usage.text || 0) + (usage.image || 0);
});

ipcMain.on('open-external', (_event, url) => {
  shell.openExternal(url);
});

ipcMain.handle('media:import', async (_event, payload) => {
  const sourcePath = payload && payload.sourcePath;
  if (!sourcePath || typeof sourcePath !== 'string') {
    throw new Error('Missing media source path.');
  }

  const stat = await fsp.stat(sourcePath);
  if (!stat.isFile()) {
    throw new Error('Media source is not a file.');
  }

  return mediaStore.saveFile(sourcePath, {
    kind: payload.kind === 'video' ? 'video' : 'image',
    name: payload.name || path.basename(sourcePath), mime: payload.mime || ''
  });
});

ipcMain.handle('media:import-url', async (_event, payload) => {
  const { url, kind } = payload;
  if (!url || typeof url !== 'string') {
    throw new Error('Missing media URL.');
  }

  const parsedUrl = new URL(url.trim());
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Only HTTP(S) media URLs are supported.');
  }

  const normalizedUrl = parsedUrl.toString();
  const urlParts = parsedUrl.pathname.split('/');
  const rawName = urlParts[urlParts.length - 1] || 'web-media';
  
  // Fetch remote media via main process net.fetch (immune to CORS restrictions)
  const response = await net.fetch(normalizedUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch remote media: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  
  const mime = response.headers.get('content-type') || '';
  const mimeKind = getMediaKindFromMime(mime);
  const nameKind = getMediaKindFromName(rawName || parsedUrl.pathname);
  const hintedKind = kind === 'video' || kind === 'image' ? kind : null;
  const actualKind = mimeKind || nameKind || hintedKind;

  if (!actualKind) {
    throw new Error('Dropped URL is not an image or video.');
  }

  if (mime && !mimeKind && mime !== 'application/octet-stream' && mime !== 'binary/octet-stream') {
    throw new Error(`Dropped URL returned unsupported content type: ${mime}`);
  }
  
  return mediaStore.saveBuffer(buffer, { kind: actualKind, name: rawName, mime });
});

ipcMain.handle('media:save-blob', async (_event, arrayBuffer) => {
  return mediaStore.saveImage(Buffer.from(arrayBuffer));
});

ipcMain.handle('media:save-buffer', async (_event, payload) => {
  return mediaStore.saveBuffer(Buffer.from(payload.data), payload);
});

const takeScreenshot = () => {
  const cmd = `gdbus call --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop --method org.freedesktop.portal.Screenshot.Screenshot "" "{'interactive': <true>}" || gnome-screenshot -ac || spectacle -rbc || flameshot gui || xfce4-screenshooter -rc`;
  exec(cmd, (error) => {
    if (error) {
      console.error('Failed to trigger native screenshot tool:', error);
    }
  });
};

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  return;
}

app.on('second-instance', (event, commandLine, workingDirectory) => {
  if (commandLine.includes('--screenshot')) {
    takeScreenshot();
    return;
  }
  // Someone tried to run a second instance, we should focus our window.
  if (mainWindow) {
    if (!mainWindow.isVisible()) mainWindow.show();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(() => {
  // Set the App User Model ID so the taskbar icon shows correctly on Windows and Linux
  app.setAppUserModelId('com.nazih.floatboard');
  if (process.platform === 'linux') {
    app.setDesktopName('floatboard.desktop');
  }

  if (autoUpdater) {
    autoUpdater.on('update-downloaded', (info) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater:update-downloaded', info);
      }
    });
    autoUpdater.checkForUpdatesAndNotify().catch(err => {
      console.error('Failed to check for updates:', err);
    });
  }

  // Register custom app-media protocol to load local files safely without webSecurity blocks
  protocol.handle('app-media', async (request) => {
    try {
      const url = new URL(request.url);
      const mediaDir = getMediaDir();
      
      let fileName = decodeURIComponent(
        url.pathname && url.pathname !== '/'
          ? url.pathname.replace(/^\/+/, '')
          : url.host
      );
      
      // Parse case-preserving pathname if host is 'media'
      if (url.host === 'media' && url.pathname) {
        fileName = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      }

      let filePath = path.join(mediaDir, fileName);

      // Backwards compatibility for broken legacy lowercase host URLs
      if (!fs.existsSync(filePath)) {
        const files = await fsp.readdir(mediaDir);
        const lowerName = fileName.toLowerCase();
        const match = files.find(f => f.toLowerCase() === lowerName);
        if (match) {
          filePath = path.join(mediaDir, match);
        }
      }

      return net.fetch(pathToFileURL(filePath).toString());
    } catch (error) {
      console.error('Failed to handle app-media protocol request:', error);
      return new Response('Not Found', { status: 404 });
    }
  });
  // Added theme:change for instant background color transition
  ipcMain.on('theme:change', (_event, theme) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(theme === 'dark' ? '#1a1a1e' : '#ffffff');
    }
  });

  createWindow();
  createTray();
  
  // XFixes sends notifications when clipboard ownership changes. No idle polling.
  const clipHistory = [];
  let lastText = '';
  let lastImageHash = '';
  let clipboardBusy = false;
  let clipboardPending = false;
  inspectClipboard = async () => {
    if (clipboardBusy) { clipboardPending = true; return; }
    clipboardBusy = true;
    try {
      do {
        clipboardPending = false;
        const formats = clipboard.availableFormats();
        const text = clipboard.readText();
        if (text && text !== lastText) {
          lastText = text;
          const existingIdx = clipHistory.findIndex(item => item.content === text);
          if (existingIdx !== -1) clipHistory.splice(existingIdx, 1);
          clipHistory.unshift({ type: 'text', content: text, timestamp: Date.now() });
          // Bound retained clipboard history, including very large text selections.
          let bytes = 0;
          while (clipHistory.length > 10) clipHistory.pop();
          for (let i = 0; i < clipHistory.length; i++) {
            bytes += Buffer.byteLength(clipHistory[i].content);
            if (bytes > 4 * 1024 * 1024) { clipHistory.splice(i); break; }
          }
        }
        if (!text) lastText = '';
        if (!formats.some(format => format.startsWith('image/'))) {
          lastImageHash = '';
          continue;
        }
        const image = clipboard.readImage();
        if (image.isEmpty()) continue;
        const item = await mediaStore.saveImage(image);
        if (item.contentHash === lastImageHash) continue;
        lastImageHash = item.contentHash;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('media:auto-added', item);
      } while (clipboardPending);
    } catch (error) {
      console.error('Could not read changed clipboard:', error);
    } finally {
      clipboardBusy = false;
    }
  };
  stopClipboardWatcher = startClipboardWatcher({ app, window: mainWindow, onChange: inspectClipboard });

  const showHistory = () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) showWindow();
      mainWindow.webContents.send('history:show', clipHistory);
    }
  };
  ipcMain.on('history:request', showHistory);
  globalShortcut.register('CommandOrControl+Shift+V', showHistory);

  globalShortcut.register('CommandOrControl+Shift+S', takeScreenshot);

  app.on('activate', showWindow);
});

app.on('before-quit', (event) => {
  isQuitting = true;
  if (quitDrainStarted) return;
  if (process.platform !== 'win32') {
    saveWindowStateSoon();
    return;
  }
  // Stop new clipboard work, then give queued board and window writes a short
  // opportunity to finish before the process exits. Never hold Windows shutdown indefinitely.
  event.preventDefault();
  quitDrainStarted = true;
  stopClipboardMonitoring();
  const flushBoard = mainWindow && !mainWindow.isDestroyed()
    ? mainWindow.webContents.executeJavaScript('window.__flushBoardForQuit && window.__flushBoardForQuit()')
    : Promise.resolve();
  const pending = Promise.allSettled([flushBoard, flushWindowState()])
    .then(() => boardWrites);
  let deadline;
  Promise.race([
    pending,
    new Promise(resolve => { deadline = setTimeout(resolve, 1500); })
  ]).finally(() => {
    clearTimeout(deadline);
    app.quit();
  });
});

app.on('will-quit', () => {
  stopClipboardMonitoring();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', (event) => {
  if (!isQuitting) {
    event.preventDefault();
  }
});
