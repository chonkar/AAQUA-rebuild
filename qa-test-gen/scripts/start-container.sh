#!/bin/bash
set -e

echo "[AAQUA] Initializing virtual display and noVNC service..."

# 1. Ensure any old X lock files on :99 are cleaned up
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true

# 2. Start Xvfb (Virtual Display) on :99 with standard 1080p resolution
Xvfb :99 -screen 0 1920x1080x24 -ac +extension GLX +render -noreset &
export DISPLAY=:99
sleep 1

# 3. Start window manager (fluxbox) so windows maximize and render decorations properly
if command -v fluxbox >/dev/null 2>&1; then
    fluxbox &
fi

# 4. Start x11vnc server on port 5900 (listening on localhost)
if command -v x11vnc >/dev/null 2>&1; then
    x11vnc -display :99 -forever -shared -nopw -rfbport 5900 -listen 127.0.0.1 -bg
fi

# 5. Start websockify + noVNC on port 6080
NOVNC_DIR="/usr/share/novnc"
if [ -d "$NOVNC_DIR" ]; then
    # Create symlink for vnc.html to index.html if index.html doesn't exist
    if [ ! -f "$NOVNC_DIR/index.html" ] && [ -f "$NOVNC_DIR/vnc.html" ]; then
        ln -sf "$NOVNC_DIR/vnc.html" "$NOVNC_DIR/index.html" || true
    fi
    websockify --web "$NOVNC_DIR" 6080 127.0.0.1:5900 &
elif command -v websockify >/dev/null 2>&1; then
    websockify 6080 127.0.0.1:5900 &
fi

echo "[AAQUA] Virtual display (:99) and noVNC (port 6080) started successfully."

# 6. Execute Express backend
exec node server/index.js
