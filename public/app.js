const btnStart = document.getElementById('btnStart')
const btnStop = document.getElementById('btnStop')
const statusDot = document.getElementById('statusDot')
const statusText = document.getElementById('statusText')
const sampleRateEl = document.getElementById('sampleRate')
const channelsEl = document.getElementById('channels')
const bufferedEl = document.getElementById('buffered')
const levelEl = document.getElementById('level')

/** @type {AudioContext | null} */
let audioContext = null
/** @type {AudioWorkletNode | ScriptProcessorNode | null} */
let player = null
/** @type {'worklet' | 'script' | null} */
let playerMode = null
/** @type {WebSocket | null} */
let ws = null
/** @type {{ sampleRate: number, channels: number, format: string } | null} */
let config = null
/** User intends to keep listening (until Stop). */
let listening = false
/** Page is hidden / screen off — WS closed on purpose, wait for foreground. */
let backgroundPaused = false
/** @type {WakeLockSentinel | null} */
let wakeLock = null
/** @type {HTMLAudioElement | null} */
let keepAliveAudio = null
/** @type {ReturnType<typeof setTimeout> | null} */
let reconnectTimer = null
let reconnectAttempt = 0

const scriptQueue = {
  samples: new Float32Array(0),
  clear() {
    this.samples = new Float32Array(0)
  },
  push(buf) {
    const next = new Float32Array(this.samples.length + buf.length)
    next.set(this.samples)
    next.set(buf, this.samples.length)
    const max = 48000 * 2
    this.samples = next.length > max ? next.subarray(next.length - max) : next
  },
  pull(frames) {
    const need = frames * 2
    const out = new Float32Array(need)
    const take = Math.min(need, this.samples.length)
    out.set(this.samples.subarray(0, take))
    this.samples = this.samples.subarray(take)
    return out
  },
  frames() {
    return this.samples.length >> 1
  },
}

function setStatus(text, ok = false) {
  statusText.textContent = text
  statusDot.classList.toggle('on', ok)
}

function playingLabel() {
  return playerMode === 'worklet' ? '播放中' : '播放中（兼容模式）'
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/audio`
}

function clearReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function scheduleReconnect() {
  // Do not reconnect while page is in background / screen off
  if (!listening || backgroundPaused || document.hidden || reconnectTimer) return
  const delay = Math.min(8000, 500 * 2 ** reconnectAttempt)
  reconnectAttempt += 1
  setStatus(`连接断开，${Math.round(delay / 1000)}s 后重连…`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (!listening || backgroundPaused || document.hidden) return
    connectWs()
  }, delay)
}

/** Intentionally drop WS when tab backgrounds or screen locks. */
function pauseForBackground() {
  if (!listening) return
  backgroundPaused = true
  clearReconnect()

  if (ws) {
    ws.onclose = null
    ws.onerror = null
    ws.onmessage = null
    try {
      ws.close()
    } catch {
      /* ignore */
    }
    ws = null
  }

  if (playerMode === 'worklet' && player) {
    try {
      player.port.postMessage({ type: 'reset' })
    } catch {
      /* ignore */
    }
  }
  scriptQueue.clear()

  if (audioContext && audioContext.state === 'running') {
    audioContext.suspend().catch(() => {})
  }

  setStatus('已暂停（后台 / 息屏）')
}

/** Tiny silent WAV — marks page as "media playing" on many Android browsers. */
function silentWavDataUri(seconds = 2, sampleRate = 8000) {
  const n = sampleRate * seconds
  const dataBytes = n * 2
  const buf = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(buf)
  const w = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  w(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  w(8, 'WAVEfmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, sampleRate, true)
  v.setUint32(28, sampleRate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  w(36, 'data')
  v.setUint32(40, dataBytes, true)
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return `data:audio/wav;base64,${btoa(bin)}`
}

async function startKeepAliveMedia() {
  if (!keepAliveAudio) {
    keepAliveAudio = new Audio(silentWavDataUri())
    keepAliveAudio.loop = true
    keepAliveAudio.volume = 0.01
    keepAliveAudio.setAttribute('playsinline', '')
  }
  try {
    await keepAliveAudio.play()
  } catch (err) {
    console.warn('keepalive audio play failed', err)
  }

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: '系统音频推流',
        artist: 'Toneferry',
        album: 'Loopback',
      })
      navigator.mediaSession.playbackState = 'playing'
      navigator.mediaSession.setActionHandler('pause', () => {
        stop().catch(console.error)
      })
      navigator.mediaSession.setActionHandler('stop', () => {
        stop().catch(console.error)
      })
      navigator.mediaSession.setActionHandler('play', () => {
        if (!listening) start().catch(console.error)
      })
    } catch {
      /* ignore unsupported handlers */
    }
  }
}

function stopKeepAliveMedia() {
  if (keepAliveAudio) {
    keepAliveAudio.pause()
    keepAliveAudio.currentTime = 0
  }
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState = 'none'
    } catch {
      /* ignore */
    }
  }
}

async function requestWakeLock() {
  if (!listening || !('wakeLock' in navigator)) return
  try {
    if (wakeLock) {
      try {
        await wakeLock.release()
      } catch {
        /* ignore */
      }
      wakeLock = null
    }
    wakeLock = await navigator.wakeLock.request('screen')
    wakeLock.addEventListener('release', () => {
      wakeLock = null
    })
  } catch (err) {
    console.warn('wakeLock failed', err)
  }
}

async function releaseWakeLock() {
  if (!wakeLock) return
  try {
    await wakeLock.release()
  } catch {
    /* ignore */
  }
  wakeLock = null
}

function destroyPlayer() {
  if (player) {
    try {
      if (playerMode === 'worklet') {
        player.port.postMessage({ type: 'reset' })
      }
      player.disconnect()
    } catch {
      /* ignore */
    }
    player = null
  }
  playerMode = null
  scriptQueue.clear()
}

async function ensurePlayer(sampleRate) {
  if (audioContext && player && Math.abs(audioContext.sampleRate - sampleRate) < 1) {
    if (audioContext.state === 'suspended') await audioContext.resume()
    return
  }

  destroyPlayer()
  if (audioContext) {
    try {
      await audioContext.close()
    } catch {
      /* ignore */
    }
    audioContext = null
  }

  audioContext = new AudioContext({ sampleRate })
  const actualRate = audioContext.sampleRate
  if (Math.abs(actualRate - sampleRate) > 1) {
    console.warn(`AudioContext sampleRate=${actualRate}, stream=${sampleRate}`)
  }

  const canWorklet =
    window.isSecureContext && typeof audioContext.audioWorklet?.addModule === 'function'

  if (canWorklet) {
    try {
      await audioContext.audioWorklet.addModule('./audio-player.js')
      const node = new AudioWorkletNode(audioContext, 'audio-player', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      })
      node.connect(audioContext.destination)
      node.port.onmessage = (ev) => {
        const msg = ev.data
        if (msg?.type === 'stats') {
          bufferedEl.textContent = String(msg.bufferedFrames)
          levelEl.style.width = `${Math.min(100, Math.round((msg.level || 0) * 140))}%`
        }
      }
      player = node
      playerMode = 'worklet'
      if (audioContext.state === 'suspended') await audioContext.resume()
      return
    } catch (err) {
      console.warn('AudioWorklet failed, fallback to ScriptProcessor', err)
      destroyPlayer()
    }
  }

  const bufferSize = 2048
  const sp = audioContext.createScriptProcessor(bufferSize, 0, 2)
  sp.onaudioprocess = (ev) => {
    const outL = ev.outputBuffer.getChannelData(0)
    const outR = ev.outputBuffer.getChannelData(1)
    const interleaved = scriptQueue.pull(bufferSize)
    let peak = 0
    for (let i = 0; i < bufferSize; i++) {
      const l = interleaved[i * 2] || 0
      const r = interleaved[i * 2 + 1] || 0
      outL[i] = l
      outR[i] = r
      const a = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r)
      if (a > peak) peak = a
    }
    bufferedEl.textContent = String(scriptQueue.frames())
    levelEl.style.width = `${Math.min(100, Math.round(peak * 140))}%`
  }
  const silent = audioContext.createGain()
  silent.gain.value = 0
  silent.connect(sp)
  sp.connect(audioContext.destination)
  player = sp
  playerMode = 'script'

  if (audioContext.state === 'suspended') await audioContext.resume()
}

function feedPcm(arrayBuffer) {
  if (!player) return
  if (playerMode === 'worklet') {
    player.port.postMessage(arrayBuffer, [arrayBuffer])
    return
  }
  if (playerMode === 'script') {
    scriptQueue.push(new Float32Array(arrayBuffer))
  }
}

async function applyAudioConfig(msg) {
  config = {
    sampleRate: Number(msg.sampleRate) || 48000,
    channels: Number(msg.channels) || 2,
    format: msg.format || 'f32',
  }
  sampleRateEl.textContent = `${config.sampleRate} Hz`
  channelsEl.textContent = String(config.channels)
  setStatus('收到配置，初始化播放器…', true)
  try {
    await ensurePlayer(config.sampleRate)
    setStatus(playingLabel(), true)
  } catch (err) {
    console.error(err)
    setStatus(`播放器初始化失败：${err.message || err}`)
  }
}

/** Resume after returning to the page — reconnect WS if it was paused or dropped. */
async function resumePlayback() {
  if (!listening) return
  if (document.hidden) return

  const wasPaused = backgroundPaused
  backgroundPaused = false
  clearReconnect()

  await requestWakeLock()
  await startKeepAliveMedia()

  if (audioContext && audioContext.state === 'suspended') {
    try {
      await audioContext.resume()
    } catch (err) {
      console.warn('AudioContext.resume failed', err)
    }
  }

  const needWs =
    wasPaused || !ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED

  if (needWs) {
    reconnectAttempt = 0
    setStatus('回到前台，正在重连…', true)
    connectWs()
    return
  }

  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'get-config' }))
    } catch {
      /* ignore */
    }
    if (config && player) setStatus(playingLabel(), true)
  }
}

function connectWs() {
  clearReconnect()

  if (ws) {
    ws.onclose = null
    ws.onerror = null
    ws.onmessage = null
    try {
      ws.close()
    } catch {
      /* ignore */
    }
    ws = null
  }

  ws = new WebSocket(wsUrl())
  ws.binaryType = 'arraybuffer'
  setStatus('连接中…')

  ws.onopen = () => {
    reconnectAttempt = 0
    setStatus(config ? playingLabel() : '已连接，等待音频配置…', true)
    ws.send(JSON.stringify({ type: 'get-config' }))
  }

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      if (msg.type === 'audio-config') {
        applyAudioConfig(msg)
      } else if (msg.type === 'error') {
        setStatus(`错误：${msg.message}`)
      } else if (msg.type === 'status') {
        if (!config) setStatus(msg.message, String(msg.message).includes('start'))
      }
      return
    }

    if (event.data instanceof ArrayBuffer) {
      feedPcm(event.data)
    }
  }

  ws.onclose = () => {
    ws = null
    if (backgroundPaused || document.hidden) {
      // Closed because page went to background — wait for foreground
      return
    }
    if (listening) {
      scheduleReconnect()
    } else {
      setStatus('连接已断开')
      btnStart.disabled = false
      btnStop.disabled = true
    }
  }

  ws.onerror = () => {
    if (!listening) setStatus('WebSocket 错误')
  }
}

async function start() {
  listening = true
  backgroundPaused = false
  btnStart.disabled = true
  btnStop.disabled = false
  config = null
  reconnectAttempt = 0
  clearReconnect()

  const unlock = new AudioContext()
  if (unlock.state === 'suspended') await unlock.resume()
  await unlock.close()

  await startKeepAliveMedia()
  await requestWakeLock()
  connectWs()
}

async function stop() {
  listening = false
  backgroundPaused = false
  clearReconnect()
  reconnectAttempt = 0
  btnStart.disabled = false
  btnStop.disabled = true

  await releaseWakeLock()
  stopKeepAliveMedia()

  if (ws) {
    ws.onclose = null
    try {
      ws.close()
    } catch {
      /* ignore */
    }
    ws = null
  }
  destroyPlayer()
  if (audioContext) {
    try {
      await audioContext.close()
    } catch {
      /* ignore */
    }
    audioContext = null
  }
  config = null
  setStatus('已停止')
  bufferedEl.textContent = '0'
  levelEl.style.width = '0%'
}

btnStart.addEventListener('click', () => {
  start().catch((err) => {
    console.error(err)
    setStatus(String(err.message || err))
    listening = false
    btnStart.disabled = false
    btnStop.disabled = true
  })
})
btnStop.addEventListener('click', () => {
  stop().catch(console.error)
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    pauseForBackground()
  } else {
    resumePlayback().catch(console.error)
  }
})

window.addEventListener('pagehide', () => {
  pauseForBackground()
})

window.addEventListener('pageshow', (ev) => {
  if (ev.persisted || document.visibilityState === 'visible') {
    resumePlayback().catch(console.error)
  }
})

window.addEventListener('focus', () => {
  if (!document.hidden) {
    resumePlayback().catch(console.error)
  }
})

// Some mobiles fire this when unlocking screen while page stays "visible"
document.addEventListener('resume', () => {
  resumePlayback().catch(console.error)
})
