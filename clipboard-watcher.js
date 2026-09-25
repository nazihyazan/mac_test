let mode = 'stopped';
function startClipboardWatcher({ onChange, onError = console.warn, window }) {
  mode = 'focus';
  if (process.platform === 'win32') {
    if (!window || window.isDestroyed()) {
      onError('Windows clipboard listener needs a live window.');
      return () => {};
    }
    let removeListener;
    let hwnd;
    let registered = false;
    try {
      const koffi = require('koffi');
      const user32 = koffi.load('user32.dll');
      const addListener = user32.func('__stdcall', 'AddClipboardFormatListener', 'int', ['uintptr_t']);
      removeListener = user32.func('__stdcall', 'RemoveClipboardFormatListener', 'int', ['uintptr_t']);
      const handle = window.getNativeWindowHandle();
      hwnd = process.arch === 'ia32' ? BigInt(handle.readUInt32LE(0)) : handle.readBigUInt64LE(0);
      const WM_CLIPBOARDUPDATE = 0x031d;
      let stopped = false;
      let timer;
      const changed = () => {
        if (stopped) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (!stopped) Promise.resolve().then(onChange).catch(onError);
        }, 40);
      };
      window.hookWindowMessage(WM_CLIPBOARDUPDATE, changed);
      if (!addListener(hwnd)) {
        window.unhookWindowMessage(WM_CLIPBOARDUPDATE);
        throw new Error('AddClipboardFormatListener failed');
      }
      registered = true;
      mode = 'windows-message';
      const stop = () => {
        if (stopped) return;
        stopped = true;
        mode = 'stopped';
        clearTimeout(timer);
        if (!window.isDestroyed()) window.unhookWindowMessage(WM_CLIPBOARDUPDATE);
        removeListener(hwnd);
      };
      window.once('closed', stop);
      return stop;
    } catch (error) {
      if (registered) removeListener(hwnd);
      mode = 'focus';
      onError(`Windows clipboard notifications unavailable: ${error.message}`);
      return () => {};
    }
  }
  if (process.platform !== 'linux' || !process.env.DISPLAY) {
    onError('Clipboard notifications unavailable; clipboard is read on focus or paste.');
    return () => {};
  }
  // One X11 socket receives server notifications; no timer polls the clipboard.
  const x11 = require('x11');
  mode = 'starting';
  let timer;
  let stopped = false;
  const client = x11.createClient((error, display) => {
    if (error) { onError(error.message); return; }
    if (stopped) { client.terminate(); return; }
    client.require('fixes', (error, fixes) => {
      if (error) { onError(error.message); client.terminate(); return; }
      client.InternAtom(false, 'CLIPBOARD', (error, atom) => {
        if (error) { onError(error.message); client.terminate(); return; }
        client.on('event', event => {
          if (stopped || event.name !== 'SelectionNotify' || event.selection !== atom) return;
          clearTimeout(timer);
          timer = setTimeout(onChange, 40);
        });
        fixes.SelectSelectionInput(display.screen[0].root, atom, 7);
        // Round trip confirms the subscription before announcing readiness.
        client.GetInputFocus(error => {
          if (error) { mode = 'focus'; onError(error.message); return; }
          if (stopped) return;
          mode = 'xfixes';
          console.log('Clipboard notifications: XFixes');
        });
      });
    });
  });
  client.on('error', error => {
    mode = 'focus';
    onError(`Clipboard notifications unavailable: ${error.message}`);
  });
  return () => {
    stopped = true;
    mode = 'stopped';
    clearTimeout(timer);
    client.terminate();
  };
}

module.exports = { startClipboardWatcher, getClipboardWatcherStatus: () => mode };
