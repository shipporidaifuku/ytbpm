(function (root) {
  'use strict';

  const FRAME_SIZE = 1024;
  const HOP_SIZE = 128;

  function createFft(n) {
    const levels = Math.log2(n);
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < levels; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      rev[i] = r;
    }
    const cos = new Float32Array(n / 2);
    const sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }

    return function fft(re, im) {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1;
        const step = n / size;
        for (let start = 0; start < n; start += size) {
          for (let k = 0; k < half; k++) {
            const a = start + k;
            const b = a + half;
            const wr = cos[k * step];
            const wi = -sin[k * step];
            const tr = re[b] * wr - im[b] * wi;
            const ti = re[b] * wi + im[b] * wr;
            re[b] = re[a] - tr;
            im[b] = im[a] - ti;
            re[a] += tr;
            im[a] += ti;
          }
        }
      }
    };
  }

  function bandEdges(bins, count) {
    const edges = [1];
    for (let i = 1; i <= count; i++) {
      const edge = Math.round(Math.pow(bins, i / count));
      if (edge > edges[edges.length - 1]) edges.push(edge);
    }
    return edges;
  }

  class OnsetDetector {
    constructor(sampleRate) {
      this.sampleRate = sampleRate;
      this.frameRate = sampleRate / HOP_SIZE;
      this.envelope = [];
      this.sumSquares = 0;
      this.sampleCount = 0;

      this._fft = createFft(FRAME_SIZE);
      this._window = new Float32Array(FRAME_SIZE);
      for (let i = 0; i < FRAME_SIZE; i++) {
        this._window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_SIZE - 1));
      }
      this._buffer = new Float32Array(FRAME_SIZE);
      this._filled = 0;
      this._re = new Float32Array(FRAME_SIZE);
      this._im = new Float32Array(FRAME_SIZE);
      this._bands = bandEdges(FRAME_SIZE / 2, 24);
      this._prev = new Float32Array(this._bands.length - 1);
      this._hasPrev = false;
    }

    get frameCount() {
      return this.envelope.length;
    }

    get rms() {
      return this.sampleCount ? Math.sqrt(this.sumSquares / this.sampleCount) : 0;
    }

    push(samples) {
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        this.sumSquares += s * s;
        this._buffer[this._filled++] = s;
        if (this._filled === FRAME_SIZE) {
          this._processFrame();
          this._buffer.copyWithin(0, HOP_SIZE);
          this._filled = FRAME_SIZE - HOP_SIZE;
        }
      }
      this.sampleCount += samples.length;
    }

    _processFrame() {
      const re = this._re;
      const im = this._im;
      for (let i = 0; i < FRAME_SIZE; i++) {
        re[i] = this._buffer[i] * this._window[i];
        im[i] = 0;
      }
      this._fft(re, im);

      let flux = 0;
      const edges = this._bands;
      for (let b = 0; b < edges.length - 1; b++) {
        let sum = 0;
        for (let k = edges[b]; k < edges[b + 1]; k++) sum += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        const mag = Math.log1p(100 * (sum / (edges[b + 1] - edges[b])));
        const diff = mag - this._prev[b];
        if (diff > 0) flux += diff;
        this._prev[b] = mag;
      }
      this.envelope.push(this._hasPrev ? flux : 0);
      this._hasPrev = true;
    }
  }

  function estimateTempo(envelope, frameRate, options) {
    const minBpm = (options && options.minBpm) || 65;
    const n = envelope.length;
    if (n < frameRate * 5) return null;

    const half = Math.max(1, Math.round(frameRate * 0.25));
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + envelope[i];
    const rectified = new Float64Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - half);
      const hi = Math.min(n, i + half + 1);
      const v = envelope[i] - (prefix[hi] - prefix[lo]) / (hi - lo);
      if (v > 0) {
        rectified[i] = v;
        any = true;
      }
    }
    if (!any) return null;

    const kernel = [1, 2, 3, 2, 1];
    const onset = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = 0; k < kernel.length; k++) {
        const j = i + k - 2;
        if (j >= 0 && j < n) sum += rectified[j] * kernel[k];
      }
      onset[i] = sum / 9;
    }

    const maxLag = Math.min(n - 2, Math.ceil(((60 * frameRate) / minBpm) * 4) + 2);
    const ac = new Float64Array(maxLag + 2);
    for (let lag = 0; lag <= maxLag + 1 && lag < n; lag++) {
      let sum = 0;
      for (let i = 0; i + lag < n; i++) sum += onset[i] * onset[i + lag];
      ac[lag] = sum / (n - lag);
    }
    const acAt = (lag) => {
      const i = Math.floor(lag);
      if (i + 1 >= ac.length) return 0;
      const f = lag - i;
      return ac[i] * (1 - f) + ac[i + 1] * f;
    };
    const combScore = (bpm) => {
      const lag = (60 * frameRate) / bpm;
      let score = 0;
      let count = 0;
      for (let k = 1; k <= 4 && k * lag <= maxLag; k++) {
        score += acAt(k * lag);
        count++;
      }
      return count ? score / count : 0;
    };
    const classScore = (bpm) => combScore(bpm) + combScore(bpm * 2);

    let best = minBpm;
    let bestScore = -Infinity;
    for (let bpm = minBpm; bpm < minBpm * 2; bpm += 0.25) {
      const score = classScore(bpm);
      if (score > bestScore) {
        bestScore = score;
        best = bpm;
      }
    }

    let refined = best;
    let refinedScore = -Infinity;
    for (let bpm = best * 0.98; bpm <= best * 1.02; bpm += 0.02) {
      const score = classScore(bpm);
      if (score > refinedScore) {
        refinedScore = score;
        refined = bpm;
      }
    }

    return { bpm: refined, confidence: ac[0] > 0 ? refinedScore / ac[0] : 0 };
  }

  const api = { OnsetDetector, estimateTempo, FRAME_SIZE, HOP_SIZE };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.YtBpm = api;
  }
})(globalThis);
