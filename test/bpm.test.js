const test = require('node:test');
const assert = require('node:assert');
const { OnsetDetector, estimateTempo } = require('../src/bpm.js');

const SAMPLE_RATE = 48000;

function synthesize(bpm, seconds, { kick = [0, 2, 4, 6], snare = [], hihat = true, noise = 0.02 } = {}) {
  const out = new Float32Array(SAMPLE_RATE * seconds);
  const eighth = ((60 / bpm) * SAMPLE_RATE) / 2;
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const add = (pos, fn, len) => {
    const start = Math.round(pos);
    for (let i = 0; i < len && start + i < out.length; i++) out[start + i] += fn(i);
  };
  for (let i = 0; i < out.length; i++) out[i] = rand() * noise;
  for (let e = 0; e * eighth < out.length; e++) {
    const t = e * eighth;
    if (kick.includes(e % 8)) add(t, (i) => Math.sin((2 * Math.PI * 60 * i) / SAMPLE_RATE) * Math.exp(-i / 1200) * 0.8, 4800);
    if (snare.includes(e % 8)) add(t, (i) => rand() * Math.exp(-i / 2500) * 0.6, 8000);
    if (hihat && e % 2 === 1) add(t, (i) => rand() * Math.exp(-i / 200) * 0.3, 1200);
  }
  return out;
}

function detect(signal) {
  const detector = new OnsetDetector(SAMPLE_RATE);
  for (let i = 0; i < signal.length; i += 4096) detector.push(signal.subarray(i, i + 4096));
  return estimateTempo(detector.envelope, detector.frameRate);
}

function assertTempo(result, bpm) {
  assert.ok(result, '推定結果が null');
  assert.ok(result.bpm >= 65 && result.bpm < 130, `表示値が範囲外: ${result.bpm.toFixed(2)}`);
  const ok = [result.bpm, result.bpm * 2].some((b) => Math.abs(b - bpm) < 1);
  assert.ok(ok, `期待 ${bpm}, 実際 ${result.bpm.toFixed(2)} / ×2 ${(result.bpm * 2).toFixed(2)}`);
}

for (const bpm of [66, 72, 90, 100, 120, 128, 140, 150, 165, 174, 190, 240]) {
  test(`${bpm} BPM を推定できる`, () => {
    assertTempo(detect(synthesize(bpm, 20)), bpm);
  });
}

test('3-3-2 のシンコペーションでも 2/3 のテンポにならない', () => {
  assertTempo(detect(synthesize(171, 20, { kick: [0, 3, 6], snare: [2, 6] })), 171);
});

test('無音では null を返す', () => {
  assert.strictEqual(detect(new Float32Array(SAMPLE_RATE * 20)), null);
});
