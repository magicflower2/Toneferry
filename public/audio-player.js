/**
 * Simple ring-buffer AudioWorklet player for interleaved stereo Float32 PCM.
 * Incoming messages: ArrayBuffer (PCM) or { type: 'reset' }
 * Outgoing stats every ~100ms: { type: 'stats', bufferedFrames, level }
 */

class RingBuffer {
  constructor(capacityFrames) {
    this.capacity = capacityFrames
    this.L = new Float32Array(capacityFrames)
    this.R = new Float32Array(capacityFrames)
    this.read = 0
    this.write = 0
    this.size = 0
  }

  available() {
    return this.size
  }

  clear() {
    this.read = 0
    this.write = 0
    this.size = 0
  }

  pushInterleaved(samples) {
    // samples: Float32 interleaved LRLR...
    const frames = samples.length >> 1
    for (let i = 0; i < frames; i++) {
      if (this.size >= this.capacity) {
        // Drop oldest frame on overflow
        this.read = (this.read + 1) % this.capacity
        this.size--
      }
      this.L[this.write] = samples[i * 2]
      this.R[this.write] = samples[i * 2 + 1]
      this.write = (this.write + 1) % this.capacity
      this.size++
    }
  }

  pull(outL, outR, frames) {
    let peak = 0
    for (let i = 0; i < frames; i++) {
      if (this.size > 0) {
        const l = this.L[this.read]
        const r = this.R[this.read]
        outL[i] = l
        outR[i] = r
        const a = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r)
        if (a > peak) peak = a
        this.read = (this.read + 1) % this.capacity
        this.size--
      } else {
        outL[i] = 0
        outR[i] = 0
      }
    }
    return peak
  }
}

class AudioPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    // ~1s @ 48k
    this.ring = new RingBuffer(48000)
    this.started = false
    this.prebufferFrames = 2400 // ~50ms @ 48k
    this.framesSinceStats = 0
    this.lastPeak = 0

    this.port.onmessage = (ev) => {
      const data = ev.data
      if (data && data.type === 'reset') {
        this.ring.clear()
        this.started = false
        return
      }
      if (data instanceof ArrayBuffer) {
        this.ring.pushInterleaved(new Float32Array(data))
      } else if (ArrayBuffer.isView(data)) {
        const view = data
        const copy = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
        this.ring.pushInterleaved(new Float32Array(copy))
      }
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0]
    const outL = output[0]
    const outR = output[1] || output[0]
    const frames = outL.length

    if (!this.started) {
      if (this.ring.available() >= this.prebufferFrames) {
        this.started = true
      } else {
        outL.fill(0)
        outR.fill(0)
        return true
      }
    }

    const peak = this.ring.pull(outL, outR, frames)
    this.lastPeak = Math.max(this.lastPeak * 0.92, peak)
    this.framesSinceStats += frames

    if (this.framesSinceStats >= 4800) {
      this.port.postMessage({
        type: 'stats',
        bufferedFrames: this.ring.available(),
        level: this.lastPeak,
      })
      this.framesSinceStats = 0
    }

    return true
  }
}

registerProcessor('audio-player', AudioPlayerProcessor)
