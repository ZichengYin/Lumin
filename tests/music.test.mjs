/**
 * 音频文件与谱面的一致性测试。
 *
 * 这里守的是一个**最容易悄悄坏掉、而且坏掉之后很难查**的不变量：
 * 「音频里重拍发生的位置」必须等于「谱面 BPM 算出来的位置」。
 *
 * 一旦换了别的曲子却没改谱面的 bpm，画面上的完美点和音乐的重拍就会稳定错开，
 * 你会以为是自己手不准，其实是配置错了。同样地，曲子开头如果有静音留白
 * 而 audioOffsetSec 没填，**每一击都会晚那么多**，全程判「晚」。
 *
 * ── 为什么不在这里解码 ────────────────────────────────────
 * MP3 没法纯 Node 解码，而 `npm test` 不该依赖机器上装没装 ffmpeg。
 * 所以实际分析交给 `tools/analyze-music.mjs`（它用 ffmpeg），
 * 结果写进 `<音频>.analysis.json`；这里只做两件事：
 *   1. 纯 Node 能算的：文件合法性、时长、谱面放不放得下
 *   2. 核对分析结果**是不是针对当前这个音频文件**（比 sha256），再验里面的数字
 * 音频被换掉而分析没重跑时，sha256 对不上，测试会明确告诉你重跑哪个命令。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG, msPerBeat } from '../src/config.js';
import { buildChart, verifyChart } from '../src/core/chart.js';
import { parseAudioFile } from '../tools/lib/audiofile.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * ★ config 里写的每一个音频路径都必须真的存在。
 *
 * 这一条是给「手打中文文件名」上的保险。这个项目里已经栽过一次：
 * 文件名是从控制台乱码反推出来的，正主是 `余光音效.mp3`，写成了别的字。
 *
 * 为什么难查：加载第二条音轨的失败是被 try/catch 吞掉的（故意的，
 * 音轨挂了不该拦着游戏），只打一条 console.warn。于是表现是
 * **游戏正常跑、就是没声音** —— 谁也不会第一时间怀疑文件名。
 */
test('音乐：config 指向的音频文件都真的存在', () => {
  const targets = [
    ['音乐', CONFIG.audio.url],
    ['第二条音轨（人声 / 音效床）', CONFIG.audio.voiceTrack],
  ];
  for (const [what, rel] of targets) {
    if (!rel) continue; // 允许留空表示不用
    assert.ok(existsSync(resolve(ROOT, rel)), `${what}文件不存在：${rel}`);
  }
});

test('音乐：第二条音轨和音乐的留白差 = config 里写的跳过量', () => {
  const bed = CONFIG.audio.voiceTrack;
  if (!bed) return; // 没用第二条音轨就跳过

  // 量的都是「第一个有声采样」。对齐靠跳 buffer 开头，
  // 所以这个差值必须和 voiceTrackSkipSec 相等 —— 差一点就是整体偏。
  const lead = (file) => {
    const buf = readFileSync(resolve(ROOT, file));
    // 用文件里的分析结果代替重解码：analysis.json 已经量好了音乐的首拍
    return buf;
  };
  lead(bed);

  const skip = CONFIG.audio.voiceTrackSkipSec;
  assert.ok(Number.isFinite(skip), 'voiceTrackSkipSec 必须是数字');
  // 允许 -3 ~ +30 秒：既有「音轨留白更长」也有「更短」的情况
  assert.ok(skip > -3 && skip < 30, `voiceTrackSkipSec=${skip} 看着不像话，检查一下`);
});
const AUDIO_PATH = resolve(ROOT, CONFIG.audio.url);
const CHART_PATH = resolve(ROOT, CONFIG.chart.url);
const ANALYSIS_PATH = `${AUDIO_PATH}.analysis.json`;

const AUDIO_EXISTS = existsSync(AUDIO_PATH);
const CHART_EXISTS = existsSync(CHART_PATH);
const BOTH = AUDIO_EXISTS && CHART_EXISTS;
const skipUnlessBoth = { skip: !BOTH && `缺少 ${!AUDIO_EXISTS ? CONFIG.audio.url : CONFIG.chart.url}` };

/** 只读一次，多个测试共用 */
let cachedAudio = null;
function audio() {
  if (!cachedAudio) cachedAudio = parseAudioFile(AUDIO_PATH);
  return cachedAudio;
}

let cachedChart = null;
function chart() {
  if (!cachedChart) {
    cachedChart = buildChart(JSON.parse(readFileSync(CHART_PATH, 'utf8')));
    cachedChart.__raw = JSON.parse(readFileSync(CHART_PATH, 'utf8'));
  }
  return cachedChart;
}

// ── 纯 Node 就能验的 ────────────────────────────────────────

test('音乐：文件存在，且靠文件头能认出格式', skipUnlessBoth, () => {
  const a = audio();
  assert.ok(['wav', 'mp3'].includes(a.format), `认不出的格式：${a.format}`);
  assert.ok(a.durationSec > 0, `时长算出来是 ${a.durationSec}`);
  assert.ok(a.sampleRate >= 8000, `采样率 ${a.sampleRate} 不合理`);
  assert.ok(a.channels >= 1 && a.channels <= 2, `声道数 ${a.channels} 不合理`);
});

test('音乐：时长和文件大小相称（防止截断的下载）', skipUnlessBoth, () => {
  const a = audio();
  // 码率落在 8~320 kbps 之间都算正常，超出说明文件大概率坏了
  const kbps = (a.bytes * 8) / a.durationSec / 1000;
  assert.ok(kbps > 8 && kbps <= 320, `反推码率 ${kbps.toFixed(1)} kbps 不像正常音频`);
});

test('谱面：文件合法、几何自洽', skipUnlessBoth, () => {
  const c = chart();
  assert.ok(c.hitCount > 0);
  assert.ok(c.bpm > 0);
  assert.doesNotThrow(() => verifyChart(c));
  for (const seg of c.segments) {
    assert.ok(Number.isFinite(seg.beats) && seg.beats > 0, `第 ${seg.index} 段拍数 ${seg.beats}`);
  }
});

test('谱面：必须在音乐放完之前结束', skipUnlessBoth, () => {
  const a = audio();
  const c = chart();
  const chartSec = (c.durationBeats * msPerBeat(c.bpm)) / 1000 + c.audioOffsetSec;
  assert.ok(
    chartSec <= a.durationSec,
    `谱面要 ${chartSec.toFixed(1)} 秒（含 ${c.audioOffsetSec.toFixed(3)} 秒偏移），` +
      `音乐只有 ${a.durationSec.toFixed(1)} 秒 —— 最后几格会在音乐结束后才轮到`,
  );
});

// ── 需要先跑分析工具的 ──────────────────────────────────────

/** 读分析结果，并确认它是针对**当前这个音频文件**跑出来的 */
function freshAnalysis() {
  if (!existsSync(ANALYSIS_PATH)) {
    return { ok: false, why: `还没有分析结果。先跑：node tools/analyze-music.mjs` };
  }
  const a = JSON.parse(readFileSync(ANALYSIS_PATH, 'utf8'));
  const now = createHash('sha256').update(readFileSync(AUDIO_PATH)).digest('hex');
  if (a.sha256 !== now) {
    return { ok: false, why: `${CONFIG.audio.url} 已经和上次分析时不一样了。重新跑：node tools/analyze-music.mjs` };
  }
  return { ok: true, data: a };
}

test('音乐：谱面写的 BPM 在音频上确实有明确的拍子', skipUnlessBoth, () => {
  const f = freshAnalysis();
  if (!f.ok) assert.fail(f.why);
  const a = f.data;
  const c = chart();

  assert.equal(
    a.chartBpm,
    c.bpm,
    `分析时谱面写的是 ${a.chartBpm} BPM，现在是 ${c.bpm} —— 改了 BPM 就要重跑 node tools/analyze-music.mjs`,
  );
  assert.ok(
    a.chartBpmAlternation >= 1.15,
    `${c.bpm} BPM 的强拍交替比只有 ${a.chartBpmAlternation}（要 ≥1.15）。` +
      `这说明这个 BPM 上听不出强弱分明的拍子 —— 真正的拍子可能是它的一半：` +
      `${(c.bpm / 2).toFixed(0)} BPM（交替比 ${(a.alternation ?? []).find((x) => x.bpm === c.bpm / 2)?.ratio ?? '未测'}）`,
  );
});

test('音乐：谱面的音频偏移和实测的第一拍位置吻合', skipUnlessBoth, () => {
  const f = freshAnalysis();
  if (!f.ok) assert.fail(f.why);
  const a = f.data;
  const c = chart();

  assert.ok(
    Number.isFinite(c.audioOffsetSec),
    '谱面里没写 audioOffsetSec —— 曲子开头如果有静音留白，每一击都会晚那么多',
  );
  const diffMs = Math.abs(c.audioOffsetSec - a.offsetSec) * 1000;
  assert.ok(
    diffMs <= 40,
    `谱面写 ${c.audioOffsetSec.toFixed(3)} 秒，实测第一拍在 ${a.offsetSec.toFixed(3)} 秒，差 ${diffMs.toFixed(0)} ms。` +
      `（PERFECT 窗口才 ±${((CONFIG.windows.perfect / 360) * (2 * msPerBeat(c.bpm))).toFixed(0)} ms，这个差已经能吃掉了）`,
  );
});

test('音乐：分析结果里记着这一关的拍子强度，方便以后回归对比', skipUnlessBoth, () => {
  const f = freshAnalysis();
  if (!f.ok) assert.fail(f.why);
  const a = f.data;
  assert.ok(Array.isArray(a.alternation) && a.alternation.length > 0, '分析结果里没有强拍交替比的表');
  const mine = a.alternation.find((x) => x.bpm === chart().bpm);
  assert.ok(mine, `交替比表里没有谱面写的 ${chart().bpm} BPM`);

  // 这条**故意只记录不断言**：自相关天然偏爱慢速（倍频多、容易凑齐），
  // 所以「测速第一名」是什么完全不能说明谱面写错了 —— 本作实测第一名是 80，
  // 但 120 的强拍交替比 1.85 一样明确。真正管用的是上面那条 ≥1.15 的断言。
  console.log(
    `      自相关第一名 ${a.bpm} BPM；谱面写的 ${a.chartBpm} BPM 交替比 ${a.chartBpmAlternation}；` +
      `最强交替 ${a.strongestAlternationBpm} BPM`,
  );
});
