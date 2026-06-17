#!/bin/bash
# Browser Worker Entrypoint - per spec section 15.5 startup sequence
set -e

echo "Worker entrypoint starting"

# CDP mode: skip Xvfb and x11vnc entirely
if [ "$STREAMING_MODE" = "cdp" ]; then
  echo "CDP mode: skipping Xvfb and x11vnc"
  exec node /app/apps/worker/dist/main.js
fi

# VNC mode (default): full display stack
echo "VNC mode: starting Xvfb and x11vnc"

# Step 1: Clean stale lock files
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99

# Step 2: Start Xvfb (virtual framebuffer)
# 1440x900 (down from 1920x1080): ~30% fewer pixels to encode/ship per frame,
# lower x11vnc CPU + bandwidth, still a full-window login/workflow canvas.
Xvfb :99 -screen 0 1440x900x24 &
XVFB_PID=$!

# Step 3: Wait for X11 socket
echo "Waiting for X11 socket..."
for i in $(seq 1 30); do
  if [ -e /tmp/.X11-unix/X99 ]; then
    echo "X11 socket ready"
    break
  fi
  if [ $i -eq 30 ]; then
    echo "ERROR: X11 socket not found after 30s"
    exit 1
  fi
  sleep 1
done

# Step 4: DISPLAY is already set via ENV in Dockerfile
export DISPLAY=:99

# Step 5: Start x11vnc (bound to localhost only - accessed by noVNC sidecar)
#   -threads : multi-threaded client handling/encoding (was single-threaded —
#              the #1 cause of multi-minute paint on a busy, animating page).
#   -defer/-wait 10 : coalesce screen updates (~fewer, larger frames; less churn).
#   -shared  : allow a new viewer to attach without killing the old connection
#              (smooths reconnects after a single-use token rotation).
#   (Removed the bogus '-clip PRIMARY,CLIPBOARD' — -clip takes a WxH+X+Y geometry,
#    not X selection names; clipboard is synced by default.)
x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -listen 127.0.0.1 \
  -threads -defer 10 -wait 10 &
X11VNC_PID=$!

echo "Xvfb PID=$XVFB_PID, x11vnc PID=$X11VNC_PID"

# Step 6-8: Start the Node.js worker (launches Playwright, health server, login DSL)
exec node /app/apps/worker/dist/main.js
