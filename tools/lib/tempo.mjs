/**
 * 节奏分析：解码 + 起音包络 + 自相关测速。
 *
 * 纯函数在下面，`decodeMono` 是唯一碰外部程序的（ffmpeg）。
 * `tools/analyze-music.mjs` 和临时探针都从这里取。
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// ── 解码 ────────────────────────────────────────────────────

/**
 * 用 ffmpeg 解成单声道 Float32。
 * @returns {Float32Array|null} 没有 ffmpeg 就返回 null
 */
export function decodeMono(path, sampleRate = 8000, tmpPath = `${path}.tmp.f32`) {
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true });
  if (probe.status !== 0) return null;

  const r = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-nostdin', '-i', path, '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-y', tmpPath],
    { encoding: 'utf8', windowsHide: true },
  );
  if (r.status !== 0) throw new Error(`ffmpeg 解码失败：${r.stderr?.trim() || '(无输出)'}`);

  const raw = readFileSync(tmpPath);
  const n = Math.floor(raw.length / 4);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = raw.readFloatLE(i * 4);
  return out;
}

export function hasFfmpeg() {
  return spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true }).status === 0;
}

// ── 起音包络 ────────────────────────────────────────────────

/**
 * 起音包络。
 *
 * 用「能量的对数差分」而不是能量本身：曲子里的音量是起伏的
 * （主歌轻、副歌响），直接用能量会被整体响度带偏；
 * 取差分之后只留下**变化的那一刻**，也就是起音。
 */
export function onsetEnvelope(samples, sampleRate, { hop = 64, window = 256 } = {}) {
  const frames = Math.floor((samples.length - window) / hop);
  if (frames < 64) throw new Error('音频太短，测不出速度');

  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = f * hop;
    for (let i = 0; i < window; i++) {
      const v = samples[base + i];
      sum += v * v;
    }
    energy[f] = Math.log10(sum / window + 1e-12);
  }

  const onset = new Float64Array(frames);
  for (let f = 1; f < frames; f++) onset[f] = Math.max(0, energy[f] - energy[f - 1]);

  // 归一化：减去均值、除以标准差
  let mean = 0;
  for (let f = 0; f < frames; f++) mean += onset[f];
  mean /= frames;
  let variance = 0;
  for (let f = 0; f < frames; f++) variance += (onset[f] - mean) ** 2;
  const std = Math.sqrt(variance / frames) || 1;
  for (let f = 0; f < frames; f++) onset[f] = (onset[f] - mean) / std;

  return { onset, fps: sampleRate / hop, frames };
}

/** 自相关：corr[lag] = 归一化的重合段点积 */
export function autocorrelate(onset, minLag, maxLag) {
  const corr = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let f = 0; f + lag < onset.length; f++) sum += onset[f] * onset[f + lag];
    corr[lag] = sum / (onset.length - lag);
  }
  return corr;
}

/**
 * 梳状打分：周期为 L 时，L、2L、3L、4L 处都该有峰。
 *
 * 只看单个滞后很容易锁到半速或倍速上（半速那个的 2L 也恰好是峰）。
 * 同时要求多个倍频都对上，才能真正区分。
 *
 * ★ 注意：`corr` 必须算到 `maxLag * harmonics` 那么远。
 *   否则慢速的候选会因为「倍频超出数组」被凑不满项而系统性落选——
 *   这个坑踩过一次：80 BPM 明明得分最高，却因为只凑得出 1 项被直接排除。
 */
export function combScores(corr, minLag, maxLag, harmonics = 4) {
  const out = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    let used = 0;
    for (let k = 1; k <= harmonics; k++) {
      const idx = Math.round(lag * k);
      if (idx >= corr.length) break;
      sum += corr[idx];
      used++;
    }
    if (used >= 2) out.push({ lag, score: sum / used, used });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** 抛物线插值找峰顶的亚帧位置 */
export function refinePeak(corr, lag) {
  const y0 = corr[lag - 1] ?? 0;
  const y1 = corr[lag];
  const y2 = corr[lag + 1] ?? 0;
  const denom = y0 - 2 * y1 + y2;
  const shift = Math.abs(denom) > 1e-12 ? (0.5 * (y0 - y2)) / denom : 0;
  return lag + Math.max(-0.5, Math.min(0.5, shift));
}

/** 给定周期，找让起音之和最大的相位（也就是「第一拍在哪儿」） */
export function bestPhase(onset, period) {
  let best = 0;
  let bestScore = -Infinity;
  const steps = Math.max(16, Math.round(period * 4));
  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * period;
    let sum = 0;
    let count = 0;
    for (let t = phase; t < onset.length; t += period) {
      sum += onset[Math.round(t)];
      count++;
    }
    if (count > 0 && sum / count > bestScore) {
      bestScore = sum / count;
      best = phase;
    }
  }
  return { phase: best, score: bestScore };
}

/** 找出包络里的显著峰（用于「把节拍画出来」） */
export function onsetPeaks(onset, { threshold = 1.0, minGapFrames = 4 } = {}) {
  const peaks = [];
  for (let f = 1; f < onset.length - 1; f++) {
    if (onset[f] < threshold) continue;
    if (onset[f] < onset[f - 1] || onset[f] < onset[f + 1]) continue;
    if (peaks.length && f - peaks[peaks.length - 1] < minGapFrames) {
      if (onset[f] > onset[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = f;
      continue;
    }
    peaks.push(f);
  }
  return peaks;
}

/** 一次性给出结论 */
export function estimateTempo(samples, sampleRate, { bpmMin = 70, bpmMax = 200, hop = 64, window = 256, harmonics = 4 } = {}) {
  const { onset, fps } = onsetEnvelope(samples, sampleRate, { hop, window });
  const minLag = Math.max(2, Math.floor((60 / bpmMax) * fps));
  const maxLag = Math.min(onset.length - 8, Math.ceil((60 / bpmMin) * fps));
  // ★ 自相关要算到 harmonics 倍远，梳状打分才凑得齐倍频
  const corrMax = Math.min(onset.length - 8, maxLag * harmonics);
  const corr = autocorrelate(onset, minLag, corrMax);
  const scored = combScores(corr, minLag, maxLag, harmonics);
  const period = refinePeak(corr, scored[0].lag);
  const bpm = (60 * fps) / period;
  const { phase, score } = bestPhase(onset, period);

  return {
    bpm,
    periodFrames: period,
    firstBeatSec: phase / fps,
    onset,
    fps,
    corr,
    minLag,
    maxLag,
    candidates: scored.slice(0, 8).map((c) => ({ bpm: (60 * fps) / c.lag, lag: c.lag, score: c.score })),
    onsetStrength: score,
  };
}

/** 某个 BPM 在自相关上的表现（用来对比「120 还是 160」这种问题） */
export function scoreAtBpm(corr, fps, bpm, harmonics = 4) {
  const lag = Math.round((60 / bpm) * fps);
  if (lag < 1 || lag >= corr.length) return { bpm, lag, score: NaN };
  let sum = 0;
  let used = 0;
  for (let k = 1; k <= harmonics; k++) {
    const idx = Math.round(lag * k);
    if (idx >= corr.length) break;
    sum += corr[idx];
    used++;
  }
  return { bpm, lag, score: used ? sum / used : NaN };
}

/**
 * 网格贴合度：起音峰离最近的「整拍点」平均差多少毫秒。
 *
 * 这是判断 **BPM 和偏移对不对** 最直接的指标 —— 比自相关有用得多。
 * 自相关只能告诉你「有周期性」，这个能告诉你「有多整齐」。
 *
 * 数值接近半个跳距（跳距 8ms，所以约 4ms）就说明网格是假的；
 * 真正对上的话应该在 10~25ms 量级（音符本身有人性化的前后浮动）。
 *
 * @param {number} phaseFrames 第一拍落在第几帧（可以是小数）
 * @returns {{meanAbsMs:number, medianAbsMs:number, within25ms:number, peaks:number}}
 */
export function gridAlignment(onset, fps, periodFrames, phaseFrames, { threshold = 1.2 } = {}) {
  const peaks = onsetPeaks(onset, { threshold });
  if (peaks.length === 0) return null;

  const errs = [];
  for (const p of peaks) {
    const k = Math.round((p - phaseFrames) / periodFrames);
    const nearest = phaseFrames + k * periodFrames;
    errs.push(Math.abs(p - nearest) / fps);
  }
  errs.sort((a, b) => a - b);
  const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
  const within = errs.filter((e) => e <= 0.025).length;
  return {
    meanAbsMs: mean * 1000,
    medianAbsMs: errs[Math.floor(errs.length / 2)] * 1000,
    within25ms: within / errs.length,
    peaks: peaks.length,
  };
}

/**
 * 扫描相位，找让网格贴合度最好的那个相位。
 * 用来回答「第一拍到底在几分几秒」。
 */
export function bestGridPhase(onset, fps, periodFrames, { threshold = 1.2, steps = 200 } = {}) {
  let best = null;
  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * periodFrames;
    const a = gridAlignment(onset, fps, periodFrames, phase, { threshold });
    if (!a) continue;
    if (!best || a.meanAbsMs < best.align.meanAbsMs) best = { phase, align: a };
  }
  return best;
}
