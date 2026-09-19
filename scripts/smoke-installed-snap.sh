#!/usr/bin/env bash
set -euo pipefail

# An isolated Xvfb display and a fresh CI user profile exercise the desktop
# entry FIRST, so opening a terminal cannot accidentally initialize the app.
log_file=$(mktemp)
launcher_pid=
window_pid=
cleanup_app() {
  if [[ -n "$window_pid" ]]; then
    kill "$window_pid" 2>/dev/null || true
    window_pid=
  fi
  if [[ -n "$launcher_pid" ]]; then
    kill "$launcher_pid" 2>/dev/null || true
    wait "$launcher_pid" 2>/dev/null || true
    launcher_pid=
  fi
}
cleanup() {
  cleanup_app
  cat "$log_file"
  rm -f "$log_file"
}
trap cleanup EXIT

desktop_file=/var/lib/snapd/desktop/applications/floatboard_floatboard.desktop
if [[ "${EXPECT_SNAPCRAFT_ICON_PATH:-0}" == 1 ]]; then
  expected_icon=/snap/floatboard/current/usr/share/icons/hicolor/512x512/apps/floatboard.png
  grep -Fx "Icon=$expected_icon" "$desktop_file"
  test -f "$expected_icon"
fi

for launch_mode in desktop terminal; do
  launch_started_ms=$(date +%s%3N)
  if [[ "$launch_mode" == desktop ]]; then
    timeout 35s gio launch "$desktop_file" >>"$log_file" 2>&1 &
  else
    timeout 35s snap run floatboard >>"$log_file" 2>&1 &
  fi
  launcher_pid=$!
  window_id=
  for ((attempt = 0; attempt < 60; attempt++)); do
    window_id=$(xdotool search --onlyvisible --class 'floatboard' 2>/dev/null | head -n 1 || true)
    if [[ -n "$window_id" ]]; then break; fi
    sleep 0.5
  done
  if [[ -z "$window_id" ]]; then
    echo "FAIL: installed Snap did not open from $launch_mode within 30 seconds" >&2
    exit 1
  fi
  window_pid=$(xdotool getwindowpid "$window_id")
  launch_ready_ms=$(date +%s%3N)
  launch_duration_ms=$((launch_ready_ms - launch_started_ms))
  if ((launch_duration_ms > 20000)); then
    echo "FAIL: $launch_mode cold start took ${launch_duration_ms}ms" >&2
    exit 1
  fi
  sleep 2
  kill -0 "$window_pid"
  xdotool getwindowname "$window_id"
  printf 'PASS installed strict Snap: %s launch opens a stable visible window in %sms\n' "$launch_mode" "$launch_duration_ms"
  cleanup_app
  for ((attempt = 0; attempt < 20; attempt++)); do
    if ! xdotool getwindowname "$window_id" >/dev/null 2>&1; then break; fi
    sleep 0.1
  done
done
if ! grep -q 'Clipboard notifications: XFixes' "$log_file"; then
  echo 'FAIL: Snap did not subscribe to clipboard change notifications' >&2
  exit 1
fi
if grep -q 'Creating shared memory.*failed' "$log_file"; then
  echo 'FAIL: shared-memory startup error' >&2
  exit 1
fi
