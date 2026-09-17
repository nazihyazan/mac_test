#!/usr/bin/env bash
set -euo pipefail

# Run under an isolated Xvfb display, after installing the actual strict Snap.
# No Chromium debugging ports or extra snap interfaces are needed for this test.
log_file=$(mktemp)
snap_test_pid=
cleanup() {
  if [[ -n "$snap_test_pid" ]]; then
    kill "$snap_test_pid" 2>/dev/null || true
    wait "$snap_test_pid" 2>/dev/null || true
  fi
  cat "$log_file"
  rm -f "$log_file"
}
trap cleanup EXIT

timeout 30s snap run floatboard >"$log_file" 2>&1 &
snap_test_pid=$!
for ((attempt = 0; attempt < 50; attempt++)); do
  window_id=$(xdotool search --onlyvisible --class 'floatboard' 2>/dev/null | head -n 1 || true)
  if [[ -n "$window_id" ]]; then
    printf 'PASS installed strict Snap: visible window %s\n' "$window_id"
    xdotool getwindowname "$window_id"
    exit 0
  fi
  if ! kill -0 "$snap_test_pid" 2>/dev/null; then
    echo 'FAIL: installed Snap exited before opening a window' >&2
    exit 1
  fi
  sleep 0.5
done
echo 'FAIL: installed Snap did not open a visible window within 25 seconds' >&2
exit 1
