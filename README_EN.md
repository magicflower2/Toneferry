# Toneferry

> Stream Windows system audio to your phone over LAN in real time.

[中文](./README.md)

## About

Captures what Windows is currently playing via WASAPI loopback and streams it over WebSocket so phones on the same LAN can listen in a browser (AudioWorklet).

```text
PC playback
      │
      ▼
WASAPI Loopback → Node.js → WebSocket
      │
      ▼
Phone / tablet browser (H5 AudioWorklet)
```

## Features

- Full system mix capture (no Stereo Mix device required)
- LAN playback from a mobile browser
- Optional single-file Windows `exe` build

## Requirements

- Windows 10/11 x64
- Node.js ≥ 18 (for source runs)
- Phone and PC on the same Wi‑Fi

## Quick start

```bash
npm install
npm start
```

Open the printed URL (default port `3088`) on your phone.

| Env | Description |
|-----|-------------|
| `PORT` | HTTP port (default `3088`) |
| `TONEFERRY_NO_BROWSER=1` | Don’t auto-open a browser |

## Build

```bash
npm run build          # native capture + packaged exe → release/Toneferry.exe
npm run build:capture  # capture binary only
```

## Stack

| Layer | Tech |
|-------|------|
| Capture | WASAPI Loopback (native C++) |
| Server | Node.js + `ws` |
| Playback | WebSocket + AudioWorklet |

## License

MIT
