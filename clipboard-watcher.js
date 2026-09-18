let mode = 'stopped';
function startClipboardWatcher({ onChange, onError = console.warn }) {
  mode = 'focus';
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
