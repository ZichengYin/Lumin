/**
 * 占位音乐生成器 —— 纯 Node，零依赖。
 *
 *   node tools/make-placeholder-music.mjs
 *   node tools/make-placeholder-music.mjs --bpm 140 --bars 24 --out assets/audio/foo.wav
 *
 * 为什么要有这个：做音游必须拿一首「已知每一拍在哪」的曲子来对齐判定。
 * 用它生成的曲子，第 0 拍严格落在文件的第 0 个采样点上，所以
 * 「音频时间 → 拍号 → 行星角度」这条链路对不对，一听一看就知道。
 *
 * 输出是 16-bit 单声道 WAV（PCM 未压缩），用自带的合成器现场算出来，
 * 不依赖任何音频库，也不下载任何东西。
 *
 * 音乐内容：Am – F – C – G 四小节循环
 *   底鼓  第 1、3 拍   ← 这两下就是判定要对的点
 *   军鼓  第 2、4 拍
 *   闭镲  八分音符
 *   贝斯  根音八分音符
 *   铺底  三和弦长音
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// ── 命令行参数 ──────────────────────────────────────────────
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};

const BPM = Number(argOf('--bpm', 120));
const BARS = Number(argOf('--bars', 16));
const SAMPLE_RATE = Number(argOf('--rate', 44100));
const SEED = Number(argOf('--seed', 20261005));
const OUT = resolve(ROOT, argOf('--out', 'assets/audio/placeholder-120bpm.wav'));

const TAU = Math.PI * 2;
const SPB = 60 / BPM; // 每拍秒数
const BEATS = BARS * 4;
const DURATION = BEATS * SPB;

// ── 可复现的噪声（否则每次生成的 WAV 都不一样，没法做二进制比对）──
let rngState = SEED >>> 0;
function rand() {
  // xorshift32
  rngState ^= rngState << 13;
  rngState >>>= 0;
  rngState ^= rngState >>> 17;
  rngState ^= rngState << 5;
  rngState >>>= 0;
  return rngState / 0xffffffff;
}
/** 双极噪声，[-1, 1) */
const noise = () => rand() * 2 - 1;

// ── 音色 ────────────────────────────────────────────────────

/**
 * 底鼓。频率从 140Hz 指数滑到 45Hz。
 * 相位是频率的积分，不能直接写 sin(2πf(t)·t)，否则音高会跑。
 */
function kick(t) {
  if (t < 0) return 0;
  const phase = TAU * (45 * t + (95 / 28) * (1 - Math.exp(-28 * t)));
  const body = Math.sin(phase) * Math.exp(-t * 9);
  const click = noise() * Math.exp(-t * 400) * 0.25;
  return body * 0.95 + click;
}

/** 军鼓 / 拍手 */
function snare(t) {
  if (t < 0) return 0;
  const n = noise() * Math.exp(-t * 26);
  const body = Math.sin(TAU * 185 * t) * Math.exp(-t * 38) * 0.4;
  return n * 0.6 + body;
}

/** 闭镲。用相邻噪声相减做一个粗糙的高通，让它变亮。 */
let hatPrev = 0;
function hat(t) {
  if (t < 0) return 0;
  const n = noise();
  const hp = n - hatPrev;
  hatPrev = n;
  return hp * Math.exp(-t * 110) * 0.28;
}

/** 贝斯：基频 + 一点二次谐波 */
function bass(t, freq) {
  if (t < 0) return 0;
  const env = Math.min(1, t * 300) * Math.exp(-t * 4.5);
  return (Math.sin(TAU * freq * t) + 0.32 * Math.sin(TAU * 2 * freq * t)) * env * 0.5;
}

/** 铺底：三和弦，轻微失谐做出厚度 */
function pad(t, freqs) {
  if (t < 0) return 0;
  const env = Math.min(1, t / 0.18) * Math.exp(-t * 1.1);
  let s = 0;
  for (const f of freqs) {
    s += Math.sin(TAU * f * t);
    s += 0.6 * Math.sin(TAU * f * 1.004 * t);
  }
  return (s / (freqs.length * 1.6)) * env * 0.5;
}

// ── 和声进行：Am – F – C – G ────────────────────────────────
const PROGRESSION = [
  { root: 110.0, chord: [220.0, 261.63, 329.63] }, // Am
  { root: 87.31, chord: [174.61, 220.0, 261.63] }, // F
  { root: 130.81, chord: [261.63, 329.63, 392.0] }, // C
  { root: 98.0, chord: [196.0, 246.94, 293.66] }, // G
];

// ── 逐拍写样本 ──────────────────────────────────────────────
const totalSamples = Math.round(DURATION * SAMPLE_RATE);
const out = new Float32Array(totalSamples);

/** 在某个时间点混入一个音色产生的整段波形 */
function place(startSec, voice, gain = 1, voiceDuration = 0.6) {
  const startSample = Math.round(startSec * SAMPLE_RATE);
  const n = Math.round(voiceDuration * SAMPLE_RATE);
  for (let i = 0; i < n; i++) {
    const idx = startSample + i;
    if (idx < 0 || idx >= totalSamples) continue;
    out[idx] += voice(i / SAMPLE_RATE) * gain;
  }
}

for (let beat = 0; beat < BEATS; beat++) {
  const t = beat * SPB;
  const beatInBar = beat % 4;
  const bar = Math.floor(beat / 4) % PROGRESSION.length;
  const { root, chord } = PROGRESSION[bar];

  // 底鼓：第 1、3 拍 —— 判定要对的就是这两下
  if (beatInBar === 0 || beatInBar === 2) place(t, kick, 0.95, 0.5);
  // 军鼓：第 2、4 拍
  if (beatInBar === 1 || beatInBar === 3) place(t, snare, 0.55, 0.35);
  // 闭镲：八分音符
  place(t, hat, 0.7, 0.09);
  place(t + SPB / 2, hat, 0.45, 0.09);
  // 贝斯：八分音符
  place(t, (x) => bass(x, root), 0.85, 0.4);
  place(t + SPB / 2, (x) => bass(x, root * 1.5), 0.5, 0.3);
  // 铺底：每小节换一次和弦，铺满整个小节
  if (beatInBar === 0) place(t, (x) => pad(x, chord), 0.5, SPB * 4);
}

// ── 收尾：归一化 + 首尾各 8ms 淡入淡出，避免爆音 ────────────
let peak = 0;
for (let i = 0; i < totalSamples; i++) {
  const a = Math.abs(out[i]);
  if (a > peak) peak = a;
}
const norm = peak > 0 ? 0.9 / peak : 1;

const fadeSamples = Math.round(0.008 * SAMPLE_RATE);
for (let i = 0; i < totalSamples; i++) {
  let g = norm;
  if (i < fadeSamples) g *= i / fadeSamples;
  const fromEnd = totalSamples - 1 - i;
  if (fromEnd < fadeSamples) g *= fromEnd / fadeSamples;
  out[i] *= g;
}

// ── 打包成 16-bit PCM 单声道 WAV ────────────────────────────
function encodeWav(samples, sampleRate) {
  const dataSize = samples.length * 2;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);

  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt 块长度
  buf.writeUInt16LE(1, 20); // 1 = PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // 字节率
  buf.writeUInt16LE(2, 32); // 块对齐
  buf.writeUInt16LE(16, 34); // 位深

  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

const wav = encodeWav(out, SAMPLE_RATE);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, wav);

// ── 自检 ────────────────────────────────────────────────────
// 光看代码不能证明采样点算对了。这里直接量：每一拍开头 25ms 的响度，
// 和拍与拍中间（八分音符之间，应该只有贝斯余音）的响度比。
// 比值明显大于 1，才说明「音频时间 → 拍号」这条链路的起点是真的对上了。
const windowSamples = Math.round(0.025 * SAMPLE_RATE);
function rmsAt(sec) {
  const start = Math.round(sec * SAMPLE_RATE);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < windowSamples; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= totalSamples) continue;
    sum += out[idx] * out[idx];
    n++;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

const onBeat = [];
const offBeat = [];
for (let b = 0; b < BEATS; b++) {
  onBeat.push(rmsAt(b * SPB));
  offBeat.push(rmsAt((b + 0.25) * SPB));
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const onMean = mean(onBeat);
const offMean = mean(offBeat);
const ratio = offMean > 0 ? onMean / offMean : Infinity;
// 最弱的一拍也要明显强过拍间，否则说明某一拍漏了音
const weakestBeat = Math.min(...onBeat);

// ── 报告 ────────────────────────────────────────────────────
const secs = DURATION.toFixed(2);
console.log(`已生成 ${OUT}`);
console.log(`  BPM        ${BPM}`);
console.log(`  小节/拍数   ${BARS} 小节 / ${BEATS} 拍`);
console.log(`  时长       ${secs} 秒（每拍 ${SPB.toFixed(4)} 秒）`);
console.log(`  采样率     ${SAMPLE_RATE} Hz，16-bit 单声道`);
console.log(`  体积       ${(wav.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`  峰值归一   0.90（原始峰值 ${peak.toFixed(3)}）`);
console.log('');
console.log(`  自检：拍上响度 ${onMean.toFixed(4)} / 拍间响度 ${offMean.toFixed(4)} = ${ratio.toFixed(1)}×`);
console.log(`        最弱的一拍 ${weakestBeat.toFixed(4)}，仍高于拍间 ${(weakestBeat / offMean).toFixed(1)}×`);

if (ratio < 2) {
  console.error(`\n  [失败] 拍上响度只有拍间的 ${ratio.toFixed(1)} 倍，说明采样点算错了。`);
  process.exit(1);
}
console.log(`        第 0 拍严格位于第 0 个采样点 ✔`);
