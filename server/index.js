import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { spawn, exec } from 'node:child_process'
import { WebSocketServer, WebSocket } from 'ws'

/** Prefer LAN IPv4 (e.g. 192.168.x.x) for phone access on the same Wi‑Fi. */
function getLanIPv4() {
  const ifaces = os.networkInterfaces()
  const candidates = []
  for (const list of Object.values(ifaces)) {
    if (!list) continue
    for (const info of list) {
      const family = info.family === 4 || info.family === 'IPv4'
      if (!family || info.internal) continue
      candidates.push(info.address)
    }
  }
  const score = (ip) => {
    if (ip.startsWith('192.168.')) return 0
    if (ip.startsWith('10.')) return 1
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 2
    return 9
  }
  candidates.sort((a, b) => score(a) - score(b))
  return candidates[0] || '127.0.0.1'
}

function resolveRoot() {
  // pkg: public/ + bin/ are embedded in the snapshot next to the bundled script
  if (process.pkg) {
    return path.dirname(__filename)
  }
  // esbuild CJS bundle in build/: prefer sibling public/ (packaging layout) or repo root
  if (typeof __dirname !== 'undefined') {
    if (fs.existsSync(path.join(__dirname, 'public'))) return __dirname
    const candidate = path.resolve(__dirname, '..')
    if (fs.existsSync(path.join(candidate, 'public'))) return candidate
  }
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  } catch {
    return process.cwd()
  }
}

/**
 * Native .exe cannot be spawned from pkg's virtual FS — copy to a real temp path.
 */
function materializeCaptureExe(embeddedPath) {
  if (!process.pkg) return embeddedPath

  const destDir = path.join(os.tmpdir(), 'toneferry-runtime')
  const dest = path.join(destDir, 'audio-capture.exe')
  fs.mkdirSync(destDir, { recursive: true })

  const srcStat = fs.statSync(embeddedPath)
  let needCopy = true
  try {
    const destStat = fs.statSync(dest)
    needCopy = destStat.size !== srcStat.size || destStat.mtimeMs < srcStat.mtimeMs
  } catch {
    needCopy = true
  }
  if (needCopy) {
    fs.copyFileSync(embeddedPath, dest)
  }
  return dest
}

const ROOT = resolveRoot()
const PUBLIC_DIR = path.join(ROOT, 'public')
const CAPTURE_EXE = materializeCaptureExe(path.join(ROOT, 'bin', 'audio-capture.exe'))

const HTTP_PORT = Number(process.env.PORT || 3088)
const WS_PATH = '/audio'
const OPEN_BROWSER = process.env.TONEFERRY_NO_BROWSER !== '1'

/** @type {{ sampleRate: number, channels: number, format: string } | null} */
let audioConfig = null

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
}

function sendConfig(ws) {
  if (!audioConfig) return
  if (ws.readyState !== WebSocket.OPEN) return
  ws.send(
    JSON.stringify({
      type: 'audio-config',
      sampleRate: audioConfig.sampleRate,
      channels: audioConfig.channels,
      format: audioConfig.format,
    }),
  )
}

function broadcastBinary(buf) {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(buf, { binary: true })
    }
  }
}

function broadcastJson(obj) {
  const text = JSON.stringify(obj)
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(text)
    }
  }
}

function openBrowser(url) {
  if (!OPEN_BROWSER) return
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`
  exec(cmd, (err) => {
    if (err) console.warn('[browser] open failed:', err.message)
  })
}

/** ANSI colors for Windows Terminal / modern consoles */
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  white: '\x1b[37m',
  red: '\x1b[31m',
  bgBlue: '\x1b[44m',
}

function enableConsoleColor() {
  if (process.platform !== 'win32') return
  try {
    // Best-effort: Node 20+ usually already enables VT on Windows consoles
    if (process.stdout.isTTY) process.stdout.write('')
  } catch {
    /* ignore */
  }
}

function printStartupBanner(host, port) {
  const url = `http://${host}:${port}`
  const localUrl = `http://127.0.0.1:${port}`
  const wsUrl = `ws://${host}:${port}${WS_PATH}`
  const line = '═'.repeat(56)

  console.log('')
  console.log(`${c.cyan}${c.bold}  ${line}${c.reset}`)
  console.log(`${c.cyan}${c.bold}   Toneferry  ·  系统音频实时推流已启动${c.reset}`)
  console.log(`${c.cyan}${c.bold}  ${line}${c.reset}`)
  console.log('')
  console.log(`  ${c.green}${c.bold}访问地址${c.reset}`)
  console.log(`    局域网（手机请用这个）：  ${c.yellow}${c.bold}${url}${c.reset}`)
  console.log(`    本机浏览器：              ${c.dim}${localUrl}${c.reset}`)
  console.log(`    WebSocket：               ${c.dim}${wsUrl}${c.reset}`)
  console.log('')
  console.log(`  ${c.green}${c.bold}如何使用${c.reset}`)
  console.log(`    1. 电脑播放音乐 / 视频 / 浏览器声音`)
  console.log(`    2. 手机连 ${c.bold}同一 Wi‑Fi${c.reset}`)
  console.log(`    3. 手机浏览器打开上面的局域网地址`)
  console.log(`    4. 点击页面「开始收听」`)
  console.log('')
  console.log(`  ${c.magenta}${c.bold}注意事项${c.reset}`)
  console.log(`    · 请保持本窗口开着，${c.yellow}关闭窗口即停止服务${c.reset}`)
  console.log(`    · ${c.yellow}请先拔掉 / 禁用其他外置音频设备${c.reset}（USB 声卡、耳机等），只保留系统默认扬声器`)
  console.log(`    · 手机与电脑必须在同一局域网，访客网络可能不通`)
  console.log(`    · 若打不开页面，检查 Windows 防火墙是否放行端口 ${port}`)
  console.log(`    · 息屏 / 切后台后音频可能中断，回到页面会自动尝试恢复`)
  console.log(`    · 本机也可打开：${localUrl}`)
  console.log('')
  console.log(`  ${c.dim}停止服务：关闭本窗口，或按 Ctrl+C${c.reset}`)
  console.log(`${c.cyan}${c.bold}  ${line}${c.reset}`)
  console.log('')
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
  const relUrl = urlPath === '/' ? '/index.html' : urlPath
  const filePath = path.normalize(path.join(PUBLIC_DIR, relUrl))
  const rel = path.relative(PUBLIC_DIR, filePath)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403).end('Forbidden')
    return
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not Found')
      return
    }
    const ext = path.extname(filePath).toLowerCase()
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' })
    res.end(data)
  })
})

const wss = new WebSocketServer({ server, path: WS_PATH })

wss.on('connection', (ws) => {
  console.log('[ws] client connected', audioConfig ? 'config ready' : 'config pending')
  sendConfig(ws)

  ws.on('message', (data, isBinary) => {
    if (isBinary) return
    const text = typeof data === 'string' ? data : data.toString('utf8')
    try {
      const msg = JSON.parse(text)
      if (msg.type === 'get-config') {
        if (audioConfig) {
          sendConfig(ws)
        } else {
          ws.send(JSON.stringify({ type: 'status', message: 'capture config pending' }))
        }
      }
    } catch {
      /* ignore non-json */
    }
  })

  ws.on('close', () => console.log('[ws] client disconnected'))
})

function startCapture() {
  if (!fs.existsSync(CAPTURE_EXE)) {
    console.error(`[error] missing capture binary: ${CAPTURE_EXE}`)
    console.error('Dev: npm run build:capture   |   Packaged: rebuild with npm run build:exe')
    holdAndExit(1)
  }

  const child = spawn(CAPTURE_EXE, [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let stderrBuf = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk
    let idx
    while ((idx = stderrBuf.indexOf('\n')) >= 0) {
      const line = stderrBuf.slice(0, idx).trim()
      stderrBuf = stderrBuf.slice(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type === 'audio-config') {
          audioConfig = {
            sampleRate: Number(msg.sampleRate),
            channels: Number(msg.channels) || 2,
            format: msg.format || 'f32',
          }
          broadcastJson({
            type: 'audio-config',
            ...audioConfig,
          })
        } else if (msg.type === 'error') {
          console.error('[capture]', msg.message, msg.hr ?? '')
          broadcastJson({ type: 'error', message: msg.message })
        } else if (msg.type === 'status') {
        }
      } catch {
        console.log('[capture:stderr]', line)
      }
    }
  })

  let pending = Buffer.alloc(0)
  const defaultFrameBytes = 48000 * 2 * 4 * 0.01

  child.stdout.on('data', (chunk) => {
    pending = Buffer.concat([pending, chunk])
    const frameBytes = audioConfig
      ? Math.max(
          Math.floor(audioConfig.sampleRate * audioConfig.channels * 4 * 0.01),
          audioConfig.channels * 4,
        )
      : defaultFrameBytes

    while (pending.length >= frameBytes) {
      const frame = pending.subarray(0, frameBytes)
      pending = pending.subarray(frameBytes)
      broadcastBinary(Buffer.from(frame))
    }
  })

  child.on('exit', (code, signal) => {
    console.error(`[capture] exited code=${code} signal=${signal}`)
    broadcastJson({ type: 'status', message: 'capture stopped' })
    if (!shuttingDown) {
      setTimeout(() => {
        captureProc = startCapture()
      }, 1500)
    }
  })

  child.on('error', (err) => {
    console.error('[capture] spawn error', err)
  })

  return child
}

let shuttingDown = false
let captureProc = null

captureProc = startCapture()

server.listen(HTTP_PORT, '0.0.0.0', () => {
  const host = getLanIPv4()
  const url = `http://${host}:${HTTP_PORT}`
  enableConsoleColor()
  printStartupBanner(host, HTTP_PORT)
  openBrowser(url)
})

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[error] port ${HTTP_PORT} already in use. Kill the old process or set PORT=3089`)
  } else {
    console.error('[error] server', err)
  }
  holdAndExit(1)
})

function holdAndExit(code = 1) {
  if (process.pkg) {
    console.error('')
    console.error('按回车键退出…')
    try {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      rl.question('', () => {
        rl.close()
        process.exit(code)
      })
      return
    } catch {
      /* fall through */
    }
  }
  process.exit(code)
}

function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  console.log('shutting down...')
  if (captureProc && !captureProc.killed) {
    captureProc.kill()
  }
  wss.close()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('uncaughtException', (err) => {
  console.error('[fatal]', err)
  holdAndExit(1)
})
process.on('unhandledRejection', (err) => {
  console.error('[fatal]', err)
  holdAndExit(1)
})
