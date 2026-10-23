/**
 * 谱面时间轴 —— 写谱面时对着音乐用的那张表。
 *
 *   node tools/chart-timeline.mjs                     用 config.js 里那一关
 *   node tools/chart-timeline.mjs levels/level02.json
 *   node tools/chart-timeline.mjs levels/level02.json --every 4
 *
 * 它回答的是**写谱面时真正会问的那几个问题**：
 *
 *   · 我听到 1 分 23 秒有个转折，那是第几格？   → 按时间找格
 *   · 我在这格放个井盖，玩家什么时候听到提示？ → 物件与播报
 *   · 我这条路会不会压到井盖上？               → 自检
 *   · 这一关能跑到全黑吗？                     → 渐暗进度
 *
 * 和 preview-chart.mjs 的分工：那个看**形状**（ASCII 轨迹图），这个看**时间**。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from '../src/config.js';
import { buildChart, verifyChart } from '../src/core/chart.js';
import { buildWarnings, manholeClearance, findCrowdedWarnings } from '../src/core/warnings.js';
import { parseAudioFile } from './lib/audiofile.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const chartRel = argv.find((a) => !a.startsWith('--')) ?? CONFIG.chart.url;
const EVERY = Number(argOf('--every', 2));

const chartPath = resolve(ROOT, chartRel);
if (!existsSync(chartPath)) {
  console.error(`找不到谱面：${chartRel}`);
  process.exit(1);
}
const chart = buildChart(JSON.parse(readFileSync(chartPath, 'utf8')));

// ── 音乐信息（有就显示，没有也照常工作） ────────────────────
let music = null;
const audioPath = resolve(ROOT, CONFIG.audio.url);
if (existsSync(audioPath)) {
  try {
    music = parseAudioFile(audioPath);
  } catch {
    // 读不出来就当没有
  }
}

const spb = 60 / chart.bpm; // 每拍秒数
const offset = chart.audioOffsetSec;
/** 曲内拍号 → 音乐文件里的秒数 */
const timeOf = (beat) => offset + beat * spb;
const mmss = (sec) => {
  const s = Math.max(0, sec);
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`;
};

const warnings = buildWarnings(chart, { leadBeats: CONFIG.voice.leadBeats });
const chartSec = timeOf(chart.durationBeats);
const fadeSec = CONFIG.fade.durationSec;
// fadeAmountAt 的曲线：p^curve
const fadeAt = (t) => Math.pow(Math.max(0, Math.min(1, t / fadeSec)), CONFIG.fade.curve);

// ── 头部 ────────────────────────────────────────────────────
console.log('');
console.log(`  谱面        ${chartRel}   ${chart.timing} 配速`);
if (music) console.log(`  音乐        ${CONFIG.audio.url}   ${music.durationSec.toFixed(1)} 秒`);
console.log(`  BPM         ${chart.bpm}   每拍 ${(spb * 1000).toFixed(0)} ms`);
console.log(`  长度        ${chart.hitCount} 次击打  ${chart.durationBeats.toFixed(2)} 拍 = ${chartSec.toFixed(1)} 秒`);
console.log(`  音频偏移    ${offset.toFixed(3)} 秒（谱面整体往后推）`);
if (music) {
  const use = (chartSec / music.durationSec) * 100;
  console.log(`  音乐利用率  ${use.toFixed(0)}%`);
  console.log(
    `  渐暗        ${fadeSec} 秒后全黑；本谱面跑到 ${chartSec.toFixed(0)} 秒，最暗只到 ${(fadeAt(chartSec) * 100).toFixed(0)}%`,
  );
}

// ── 按时间找格 ──────────────────────────────────────────────
// 每个「动作拍」和物件所在拍都值得标出来，作者就是靠这个把音乐和格号对上
const marks = new Map();
for (const w of warnings) {
  if (!marks.has(Math.floor(w.actionBeat))) marks.set(Math.floor(w.actionBeat), []);
  marks.get(Math.floor(w.actionBeat)).push(`★ 第 ${w.index} 号物件在此`);
}

console.log('');
console.log(`  ── 按时间找格（每 ${EVERY} 拍一行，★ = 这一拍有动作）──`);
console.log('     拍号     时间         格号   段落');
const first = chart.segments[0].startBeat;
for (let beat = Math.ceil(first); beat <= chart.durationBeats; beat += EVERY) {
  const seg = chart.segments[Math.min(chart.hitCount - 1, Math.max(0, Math.round(beat + 1e-9)))];
  let tile = 0;
  for (const s of chart.segments) {
    if (beat >= s.startBeat - 1e-9) tile = s.tileIndex;
  }
  const note = marks.get(beat)?.join(' ') ?? (seg && Math.abs(seg.hitBeat - beat) < 1e-6 ? '· 击打点' : '');
  console.log(`  ${String(beat).padStart(6)}   ${mmss(timeOf(beat)).padStart(11)}   ${String(tile).padStart(5)}   ${note}`);
}

// ── 物件与播报 ──────────────────────────────────────────────
if (warnings.length) {
  console.log('');
  console.log(`  ── 路面物件与导航播报（提前 ${CONFIG.voice.leadBeats} 拍）──`);
  console.log('     格号  物件              动作拍    播报拍   播报时间     语音');
  for (const w of warnings) {
    const prop = chart.props[w.index];
    const kind = prop.type === 'manhole' ? '井盖' : '转向箭头';
    console.log(
      `  ${String(prop.tile).padStart(6)}  ${(kind + ` P${prop.tile}`).padEnd(16)}  ` +
        `${w.actionBeat.toFixed(2).padStart(6)}  ${w.beat.toFixed(2).padStart(7)}   ` +
        `${mmss(timeOf(w.beat)).padStart(10)}   ${w.cue}`,
    );
  }
} else {
  console.log('');
  console.log('  ── 这一关还没有任何 props（井盖 / 转向箭头）──');
}

// ── 自检 ────────────────────────────────────────────────────
console.log('');
console.log('  ── 自检 ──');
let bad = 0;

try {
  verifyChart(chart);
  console.log('  ✓ 谱面几何自洽');
} catch (err) {
  bad += 1;
  console.log(`  ✗ 谱面几何有问题：${err.message}`);
}

const clear = manholeClearance(chart, { tileSpacing: CONFIG.world.tileSpacing, pathWidth: CONFIG.world.pathWidth });
if (clear.length) {
  const worst = clear.reduce((a, b) => (a.clearance < b.clearance ? a : b));
  const worstWorld = worst.clearance * CONFIG.world.tileSpacing;
  if (worst.clearance > 0) {
    console.log(`  ✓ ${clear.length} 个井盖都没压到路面（最小余量 ${worstWorld.toFixed(2)} 世界单位）`);
  } else {
    bad += 1;
    console.log(
      `  ✗ 第 ${worst.prop.index} 号井盖（P${worst.prop.tile}）压到路面了 —— ` +
        `离第 ${worst.segment} 段只有 ${worst.distance.toFixed(3)} 格，至少要 ${worst.need.toFixed(3)} 格`,
    );
  }
}

if (music) {
  if (chartSec <= music.durationSec) {
    console.log(`  ✓ 谱面在音乐放完之前结束（${chartSec.toFixed(1)} / ${music.durationSec.toFixed(1)} 秒）`);
  } else {
    bad += 1;
    console.log(`  ✗ 谱面比音乐长 ${(chartSec - music.durationSec).toFixed(1)} 秒，最后几格会在音乐结束后才轮到`);
  }
}

// ── 语音时长检查 ────────────────────────────────────────────
//
// ★ 反应时间算的是「语音**开始**播 → 该做动作」这一段，不是「播完 → 动作」。
//   听到「前方…」你就知道有事了，不必等整句说完。leadSec 本身就是反应时间。
//
// 另一半是「语音最好在动作之前播完」（tail >= 0）—— 没播完的话，
// 你得一边听一边动，体验会毛躁。这条只提醒，不算失败。
const leadSec = CONFIG.voice.leadBeats * spb;
/** 实测 1 秒反应时间就够（从语音开始播算）。低于这个数才算失败 */
const MIN_REACTION_SEC = 1.0;
/** 实际量到的最长一条语音，用来判断两条播报会不会叠在一起 */
let maxCueSec = 0;
const usedCues = [...new Set(warnings.map((w) => w.cue))];
if (usedCues.length) {
  console.log('');
  console.log(`  ── 导航语音（提前 ${CONFIG.voice.leadBeats} 拍 = ${leadSec.toFixed(2)} 秒）──`);
  console.log('     语音          时长      反应时间    播完还剩   判定');
  for (const name of usedCues) {
    const rel = CONFIG.voice.dir + CONFIG.voice.cues[name];
    const p = resolve(ROOT, rel);
    if (!existsSync(p)) {
      bad += 1;
      console.log(`  ✗ ${name.padEnd(12)} 找不到文件：${rel}`);
      continue;
    }
    let dur = null;
    try {
      dur = parseAudioFile(p).durationSec;
    } catch (err) {
      bad += 1;
      console.log(`  ✗ ${name.padEnd(12)} 读不出来（${err.message}）—— 浏览器多半也解不了`);
      continue;
    }
    const reaction = leadSec; // 从开始播到动作，这就是反应时间
    const tail = leadSec - dur; // 播完离动作还剩多少
    maxCueSec = Math.max(maxCueSec, dur);
    const ok = reaction >= MIN_REACTION_SEC;
    if (!ok) bad += 1;
    const note = !ok
      ? '反应时间不够'
      : tail < 0
        ? '语音没播完就要做动作（还能用，但毛躁）'
        : '';
    console.log(
      `  ${ok ? '✓' : '✗'} ${name.padEnd(12)} ${dur.toFixed(3)}s   ` +
        `${reaction.toFixed(2)}s      ${tail >= 0 ? '+' : ''}${tail.toFixed(2)}s     ${note}`,
    );
  }
}

// 两条播报的间隔至少要容得下最长的那条语音，否则后一条会打断前一条。
// 这个阈值不能写死 —— 换一批录音，语音长度就变了。
const crowded = findCrowdedWarnings(warnings, spb, Math.max(1.4, maxCueSec));
if (crowded.length === 0) {
  console.log('  ✓ 播报之间没有挨得太近');
} else {
  for (const c of crowded) {
    console.log(
      `  ⚠ ${c.a.reason} 和 ${c.b.reason} 的播报只隔 ${c.gapSec.toFixed(2)} 秒 —— ` +
        `后一条会打断前一条。把其中一个的 warnBeats 调开，或者挪远一点`,
    );
  }
}

if (music && chartSec / music.durationSec < 0.6) {
  console.log(
    `  ⚠ 谱面只用了音乐的 ${((chartSec / music.durationSec) * 100).toFixed(0)}%，` +
      `最暗只到 ${(fadeAt(chartSec) * 100).toFixed(0)}% —— 到不了全黑阶段`,
  );
} else if (music && fadeAt(chartSec) >= 0.999) {
  console.log(`  ✓ 谱面长度足够走完渐暗（第 ${fadeSec} 秒起全黑）`);
}

console.log('');
process.exit(bad > 0 ? 1 : 0);
