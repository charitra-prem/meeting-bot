#!/bin/bash
# Ensure End of Line is unix-style (LF)

echo "[entrypoint] Setting up XDG_RUNTIME_DIR..."
export XDG_RUNTIME_DIR=/tmp/runtime-$USER
mkdir -p $XDG_RUNTIME_DIR
chmod 700 $XDG_RUNTIME_DIR

echo "[entrypoint] Starting virtual display..."
Xvfb :99 -screen 0 1920x1080x24 &
XVFB_PID=$!

# Wait for X server to be ready
echo "[entrypoint] Waiting for X server to be ready..."
for i in {1..10}; do
    if xdpyinfo -display :99 >/dev/null 2>&1; then
        echo "[entrypoint] X server is ready"
        break
    fi
    if [ $i -eq 10 ]; then
        echo "[entrypoint] ERROR: X server failed to start"
        exit 1
    fi
    sleep 1
done

echo "[entrypoint] Starting window manager..."
fluxbox &

echo "[entrypoint] Starting PulseAudio..."
pulseaudio -D --exit-idle-time=-1

# Wait for PulseAudio to be ready
echo "[entrypoint] Waiting for PulseAudio to be ready..."
for i in {1..10}; do
    if pactl info >/dev/null 2>&1; then
        echo "[entrypoint] PulseAudio is ready"
        break
    fi
    if [ $i -eq 10 ]; then
        echo "[entrypoint] WARNING: PulseAudio may not be ready"
    fi
    sleep 1
done

# Create a null audio source for ffmpeg to capture
echo "[entrypoint] Setting up null audio sink..."
pactl load-module module-null-sink sink_name=virtual_speaker sink_properties=device.description=Virtual_Speaker || echo "[entrypoint] Warning: Could not create virtual speaker"

# List available audio sources for debugging
echo "[entrypoint] Available PulseAudio sources:"
pactl list short sources || echo "[entrypoint] Could not list sources"

echo "[entrypoint] Available PulseAudio sinks:"
pactl list short sinks || echo "[entrypoint] Could not list sinks"

echo "[entrypoint] Environment ready. Starting bot..."
pnpm run dev
