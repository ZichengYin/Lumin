/**
 * 音频分析：解码 + 测速 + 网格贴合度，写一份 <音频>.analysis.json。
 *
 * 谱面的 BPM 和偏移必须和音频一致。错了的话**前 20 秒听不出来**，
 * 等你发现时整关都白写了。所以换 / 改曲子之后先跑这个：
 *
 *   node tools/analyze-music.mjs                     用 config.js 里那首
 *   node tools/analyze-music.mjs assets/audio/xxx.mp3
 *
 * 时长和文件信息是纯 Node 算的（tools/lib/audiofile.mjs）；
 * 测速需要解码，用 ffmpeg —— 没装就只报时长，并明确说测速跳过了。
 *
 * ── 怎么读它的输出 ────────────────────────────────────────
 * 「强拍交替比」才是关键指标，不是自相关第一名：
 *   比值 > 1.3  →  这个 BPM 上确实有强弱分明的拍子
 *   比值 ≈ 1    →  强弱不分，真正的拍子可能是它的一半
 * 自相关天然偏爱慢速（倍频多，容易凑齐），单看它会一路滑到 60 BPM。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAudioFile } from './lib/audiofile.mjs';
import { decodeMono, onsetEnvelope, estimateTempo, gridAlignment, bestGridPhase } from './lib/tempo.mjs';
import { CONFIG } from '../src/config.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const rel = args.find((a) => !a.startsWith('--')) ?? CONFIG.audio.url;
const target = resolve(ROOT, rel);

if (!existsSync(target)) {
  console.error(`找不到音频文件：${rel}`);
  process.exit(1);
}

// ── 1. 纯 Node：文件信息和时长 ──────────────────────────────
const info = parseAudioFile(target);
const bytes = statSync(target).size;
const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');

console.log('');
console.log(`  文件      ${rel}`);
console.log(`  格式      ${info.format.toUpperCase()}  ${info.encoding}  ${info.sampleRate} Hz  ${info.channels} 声道`);
console.log(`  大小      ${(bytes / 1024 / 1024).toFixed(2)} MB${info.vbr ? '  (VBR)' : ''}`);
if (info.bitrate) console.log(`  码率      约 ${Math.round(info.bitrate / 1000)} kbps`);
console.log(`  时长      ${info.durationSec.toFixed(3)} 秒  =  ${(info.durationSec / 60).toFixed(2)} 分`);

// 顺手读一下谱面，好评估「谱面写的 BPM 贴不贴」
let chartRaw = null;
try {
  chartRaw = JSON.parse(readFileSync(resolve(ROOT, CONFIG.chart.url), 'utf8'));
} catch {
  // 谱面读不到就不评估，不影响音频本身
}

const report = {
  source: rel.replace(/\\/g, '/'),
  bytes,
  sha256,
  format: info.format,
  encoding: info.encoding,
  sampleRate: info.sampleRate,
  channels: info.channels,
  vbr: Boolean(info.vbr),
  durationSec: Number(info.durationSec.toFixed(4)),
  analyzedAt: new Date().toISOString(),
};

// ── 2. 解码 + 分析 ──────────────────────────────────────────
if (spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true }).status !== 0) {
  console.log('');
  console.log('  ⚠ 机器上没有 ffmpeg，跳过测速。');
  console.log('    时长已经算出来了，谱面「放得下」这条检查照样能跑，');
  console.log('    但 BPM 和偏移只能靠你自己确认。装一个再跑本工具：');
  console.log('    winget install Gyan.FFmpeg');
  writeAnalysis(report);
  process.exit(0);
}

const sr = 8000;
const tmp = mkdtempSync(join(tmpdir(), 'yuguang-audio-'));
try {
  const samples = decodeMono(target, sr, join(tmp, 'mono.f32'));
  const { onset, fps } = onsetEnvelope(samples, sr);

  const est = estimateTempo(samples, sr);
  const bpm = est.bpm;

  // ① 测速
  console.log('');
  console.log(`  测速      ${bpm.toFixed(2)} BPM   （每拍 ${(60000 / bpm).toFixed(1)} ms）`);

  // ② 候选
  console.log('');
  console.log('  自相关候选（前 6，注意它偏爱慢速）：');
  for (const c of est.candidates.slice(0, 6)) {
    console.log(`    ${c.bpm.toFixed(2).padStart(7)} BPM   ${'█'.repeat(Math.max(1, Math.round(c.score * 40)))}`);
  }

  // ③ 强拍交替比 —— 这才是判断拍子在哪的关键
  const alternation = (b) => alternationRatio(onset, fps, b);
  const list = [60, 75, 80, 90, 100, 110, 120, 130, 140, 150, 160, 180, 200, 240];
  console.log('');
  console.log('  强拍交替比（拍点平均强度 ÷ 半拍平均强度）：');
  console.log('     >1.3 = 这个 BPM 上有明确的拍子；≈1 = 强弱不分，拍子可能是它的一半');
  const rows = list.map((b) => ({ bpm: b, ...alternation(b) }));
  for (const r of rows) {
    const flag = r.ratio >= 1.3 ? '  ← 有拍' : r.ratio < 1.1 ? '  ← 强弱不分' : '';
    console.log(
      `    ${String(r.bpm).padStart(3)} BPM   拍点 ${r.on.toFixed(2).padStart(6)}   半拍 ${r.off.toFixed(2).padStart(6)}   比值 ${r.ratio.toFixed(2).padStart(5)}${flag}`,
    );
  }
  const strongest = [...rows].filter((r) => r.on > 0).sort((a, b) => b.ratio - a.ratio)[0];

  // ④ 谱面写的 BPM 到底贴不贴
  report.bpm = Number(bpm.toFixed(2));
  report.bpmCandidates = est.candidates.slice(0, 6).map((c) => ({ bpm: Number(c.bpm.toFixed(2)), score: Number(c.score.toFixed(4)) }));
  report.alternation = rows.map((r) => ({ bpm: r.bpm, ratio: Number(r.ratio.toFixed(3)) }));
  report.strongestAlternationBpm = strongest?.bpm ?? null;

  if (chartRaw && Number.isFinite(chartRaw.bpm)) {
    const cb = chartRaw.bpm;
    const a = alternation(cb);
    report.chartBpm = cb;
    report.chartBpmAlternation = Number(a.ratio.toFixed(3));
    report.offsetSec = Number(a.phase.toFixed(4));

    console.log('');
    console.log(`  谱面写的  ${cb} BPM`);
    console.log(`    强拍交替比  ${a.ratio.toFixed(3)}   ${a.ratio >= 1.3 ? '✓ 有明确的拍子' : a.ratio >= 1.15 ? '~ 偏弱，能用' : '✗ 强弱不分，谱面的 BPM 可能错了'}`);
    console.log(`    第一拍在    ${a.phase.toFixed(4)} 秒处`);

    const want = chartRaw.audioOffsetSec;
    if (Number.isFinite(want)) {
      const diff = (want - a.phase) * 1000;
      console.log(`    谱面偏移    ${want.toFixed(3)} 秒   ${Math.abs(diff) <= 40 ? '✓ 和实测吻合' : `✗ 和实测差 ${diff.toFixed(0)} ms`}`);
    } else {
      console.log(`    ⚠ 谱面里没写 audioOffsetSec，建议填 ${a.phase.toFixed(3)}`);
    }
  }

  console.log('');
  console.log(`  谱面时长不能超过 ${info.durationSec.toFixed(1)} 秒（这条 npm test 会验）。`);
  writeAnalysis(report);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

/**
 * 强拍交替比。
 *
 * 拿候选周期 P 去套：落在拍点上的平均起音强度 ÷ 落在半拍上的。
 *   · 比值明显大于 1  →  P 就是拍子（拍点上有重音）
 *   · 比值接近 1      →  拍点和半拍一样重，真正的拍子多半是 P/2
 *
 * 比自相关可靠：自相关只看「有没有周期性」，任何整数倍都满足；
 * 这个看的是「有没有强弱对比」，而强弱对比只会出现在真正的拍子上。
 */
function alternationRatio(onset, fps, bpm) {
  const P = (60 / bpm) * fps;
  let phase = 0;
  let bestScore = -Infinity;
  const STEPS = 96;
  for (let s = 0; s < STEPS; s++) {
    const ph = (s / STEPS) * P;
    let sum = 0;
    let n = 0;
    for (let t = ph; t < onset.length; t += P) {
      sum += onset[Math.round(t)];
      n++;
    }
    if (n > 0 && sum / n > bestScore) {
      bestScore = sum / n;
      phase = ph;
    }
  }
  let on = 0;
  let onN = 0;
  let off = 0;
  let offN = 0;
  for (let t = phase; t < onset.length; t += P) {
    on += onset[Math.round(t)];
    onN++;
    const o = Math.round(t + P / 2);
    if (o < onset.length) {
      off += onset[o];
      offN++;
    }
  }
  const a = onN ? on / onN : 0;
  const b = offN ? off / offN : 0;
  return { on: a, off: b, ratio: b !== 0 ? a / b : Infinity, phase: phase / fps };
}

function writeAnalysis(data) {
  const out = `${target}.analysis.json`;
  writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log('');
  console.log(`  已写入    ${out.slice(ROOT.length + 1)}`);
  console.log('');
}
