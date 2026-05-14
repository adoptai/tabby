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
Xvfb :99 -screen 0 1920x1080x24 &
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
x11vnc -display :99 -forever -nopw -rfbport 5900 -listen 127.0.0.1 -clip PRIMARY,CLIPBOARD &
X11VNC_PID=$!

echo "Xvfb PID=$XVFB_PID, x11vnc PID=$X11VNC_PID"

# Step 6-8: Start the Node.js worker (launches Playwright, health server, login DSL)
exec node /app/apps/worker/dist/main.js
