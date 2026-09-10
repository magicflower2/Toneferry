# Toneferry

[English](./README_EN.md)

> Windows 系统音频 → 局域网手机实时收听

![Toneferry](./public/banner.png)


## 简介

在 Windows 上捕获当前正在播放的系统声音（WASAPI Loopback），通过 WebSocket 推流到同局域网设备的浏览器，用 AudioWorklet 低延迟播放。适合把电脑音乐、视频声传到手机听。

```text
PC 播放中的声音
      │
      ▼
WASAPI Loopback → Node.js → WebSocket
      │
      ▼
手机 / 平板浏览器（H5 AudioWorklet）
```

## 功能

- 捕获整机混音（无需「立体声混音」设备）
- 局域网访问，扫码或打开页面即可收听
- 可打包为单文件 `exe`，无需安装 Node

## 环境

- Windows 10/11 x64
- Node.js ≥ 18（开发 / 源码运行）
- 手机与电脑同一 Wi‑Fi

## 快速开始

```bash
npm install
npm start
```

浏览器打开本机提示的地址（默认 `http://<局域网IP>:3088`），用手机访问同一地址即可收听。

可选环境变量：

| 变量 | 说明 |
|------|------|
| `PORT` | HTTP 端口，默认 `3088` |
| `TONEFERRY_NO_BROWSER=1` | 启动时不自动打开浏览器 |

## 构建

```bash
# 编译原生采集程序 + 打包 exe
npm run build
```

产物在 `release/Toneferry.exe`。

从源码仅跑服务：

```bash
npm run build:capture   # 生成 bin/audio-capture.exe
npm start
```

## 技术栈

| 层 | 技术 |
|----|------|
| 捕获 | WASAPI Loopback（原生 C++） |
| 服务 | Node.js + `ws` |
| 播放 | WebSocket + AudioWorklet |

## License

MIT
