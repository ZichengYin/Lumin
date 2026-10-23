/**
 * 曲内时钟 + 「时钟 → 谱面 → 判定」这条完整链路的测试。
 *
 * 最重要的一条是「判定与帧率无关」。音游最常见的致命 bug 就是位置靠
 * `x += v * dt` 累加，跑一会儿就和音乐错开了，而且错开之后永远回不来。
 * 下面的测试就是为了防止有人把实现改成那种写法。
 *
 * 谱面几何本身的测试在 chart.test.mjs 里。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SongClock, secondsPerBeat, beatsToSeconds, secondsToBeats, beatFraction } from '../src/core/clock.js';
import { buildChart, planetStateAtBeat, segmentAngleAtBeat } from '../src/core/chart.js';
import { toRad } from '../src/core/geometry.js';
import { judgeHit, GRADE } from '../src/core/judge.js';

const WINDOWS = { perfect: 22.5, good: 45, ok: 90 };
const BPM = 120; // 每拍 0.5 秒

/** 一条全直线的谱面：每段 180°、正好 1 拍，落点在 0,1,2,… 拍上 */
const straightChart = (bpm = BPM) =>
  buildChart({ bpm, timing: 'auto', angles: Array.from({ length: 32 }, () => 0) });

/** 完全复刻 main.js 的判定路径 */
function judgeHitIndex(chart, index, beat) {
  const seg = chart.segments[index];
  const planetAngle = segmentAngleAtBeat(chart, seg, beat);
  return judgeHit(planetAngle, toRad(seg.targetAngleDeg), seg.omega, {
    windows: WINDOWS,
    msPerTurn: seg.msPerTurn,
  });
}

// ── 时钟本身 ────────────────────────────────────────────────

test('时钟：拍与秒的换算可逆', () => {
  assert.equal(secondsPerBeat(120), 0.5);
  assert.equal(secondsPerBeat(60), 1);
  assert.equal(beatsToSeconds(4, 120), 2);
  assert.equal(secondsToBeats(2, 120), 4);
  assert.ok(Math.abs(secondsToBeats(beatsToSeconds(7.3, 140), 140) - 7.3) < 1e-12);
});

test('时钟：beatFraction 对负数也要正确', () => {
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-12, `${msg}：${a} ≠ ${b}`);

  assert.equal(beatFraction(0), 0);
  assert.equal(beatFraction(2.25), 0.25);
  assert.equal(beatFraction(-1), 0);
  assert.equal(beatFraction(-1.25), 0.75);

  // 这几个不能写精确相等：3.999 - 3 在二进制浮点里是 0.9990000000000001
  near(beatFraction(3.999), 0.999, 'beatFraction(3.999)');
  near(beatFraction(-0.001), 0.999, 'beatFraction(-0.001)');
  near(beatFraction(-0.25), 0.75, 'beatFraction(-0.25)');
});

test('时钟：songTime / beat 的基本行为', () => {
  let now = 0;
  const clock = new SongClock({ now: () => now, bpm: BPM });

  assert.equal(clock.running, false);
  assert.equal(clock.songTime, 0, '没开始播放时应为 0');

  clock.startAt(10);
  assert.equal(clock.running, true);

  now = 10;
  assert.equal(clock.songTime, 0);
  assert.equal(clock.beat, 0);

  now = 12;
  assert.equal(clock.songTime, 2);
  assert.equal(clock.beat, 4);

  // 前奏：音频还没开始，songTime 是负的
  now = 9.5;
  assert.ok(Math.abs(clock.songTime + 0.5) < 1e-12);
  assert.ok(Math.abs(clock.beat + 1) < 1e-12);

  clock.stop();
  assert.equal(clock.running, false);
  assert.equal(clock.songTime, 0);
});

test('偏移：正值表示补偿音频延迟，判定跟着「你听到的」走', () => {
  let now = 0;
  const clock = new SongClock({ now: () => now, bpm: BPM, offsetSec: 0 });
  clock.startAt(0);

  now = 1.0;
  assert.equal(clock.songTime, 1.0);

  // 耳机把声音延迟了 50ms：同一时刻，我们「听到的」还停在 0.95 秒处
  clock.offsetSec = 0.05;
  assert.ok(Math.abs(clock.songTime - 0.95) < 1e-12);

  // 所以想在第 1.0 秒（曲内）按下，墙上时钟要等到 1.05 秒
  now = 1.05;
  assert.ok(Math.abs(clock.songTime - 1.0) < 1e-12);

  // 负偏移 → songTime 变大 → 判定整体往前推
  clock.offsetSec = -0.02;
  now = 1.0;
  assert.ok(Math.abs(clock.songTime - 1.02) < 1e-12);
});

// ── ★ 帧率无关 ──────────────────────────────────────────────

test('★ 整个画面状态只是「音频时间」的纯函数，与到达路径无关', () => {
  const chart = straightChart();
  const startAt = 3.14159;
  const offsetSec = 0.023;
  const T = 27.5;

  const snapshotAt = (t) => {
    const clock = new SongClock({ now: () => t, bpm: BPM, offsetSec });
    clock.startAt(startAt);
    const beat = clock.beat;
    const ps = planetStateAtBeat(chart, beat);
    return { songTime: clock.songTime, beat, index: ps.index, planetAngle: ps.planetAngle };
  };

  const reference = snapshotAt(T);

  // 用各种离谱的步长「走到」T —— 稳定 240fps、卡成 5fps、长时间停顿后暴走、
  // 甚至一步跳过去，结果都必须一模一样。累加式实现会在这里挂掉。
  const stepPatterns = [
    Array.from({ length: 400 }, () => 1 / 240),
    Array.from({ length: 50 }, () => 0.05),
    [5, 0.2, 12, 0.3, 9.9],
  ];
  for (const [k, steps] of stepPatterns.entries()) {
    let t = 0;
    for (const dt of steps) {
      t += dt;
      snapshotAt(t);
    }
    const got = snapshotAt(T);
    assert.deepEqual(got, reference, `步长模式 #${k} 得到了不同的画面状态`);
  }

  // 必须等于解析解，不能只是「自己和自己一致」
  assert.ok(Math.abs(reference.beat - secondsToBeats(T - startAt - offsetSec, BPM)) < 1e-12);
});

// ── ★ 时钟 → 谱面 → 判定 ────────────────────────────────────

test('★ 集成：重拍上按下 → PERFECT 且时间差为 0', () => {
  const chart = straightChart();
  let now = 0;
  const clock = new SongClock({ now: () => now, bpm: BPM, offsetSec: 0 });
  const startAt = 2.0; // 音频在 2 秒后开始，前面是前奏
  clock.startAt(startAt);

  for (let index = 0; index < 8; index++) {
    const hitBeat = chart.segments[index].hitBeat;
    now = startAt + hitBeat * 0.5; // 正好踩在这一块上
    const r = judgeHitIndex(chart, index, clock.beat);

    assert.equal(r.grade, GRADE.PERFECT, `第 ${index} 块应判 PERFECT`);
    assert.ok(Math.abs(r.timeDiffMs) < 1e-9, `第 ${index} 块时间差应为 0，实际 ${r.timeDiffMs}`);
  }
});

test('★ 集成：偏 20ms 按下 → 判为早/晚 20ms', () => {
  const chart = straightChart();
  let now = 0;
  const clock = new SongClock({ now: () => now, bpm: BPM, offsetSec: 0 });
  clock.startAt(0);

  const index = 4;
  const hitBeat = chart.segments[index].hitBeat; // 第 4 拍
  const read = (wallTime) => {
    now = wallTime;
    return judgeHitIndex(chart, index, clock.beat);
  };

  const early = read(hitBeat * 0.5 - 0.02);
  assert.equal(early.early, true);
  assert.ok(Math.abs(early.timeDiffMs - 20) < 1e-6, `实际 ${early.timeDiffMs}`);
  assert.equal(early.grade, GRADE.PERFECT); // 窗口 62.5ms

  const late = read(hitBeat * 0.5 + 0.02);
  assert.equal(late.early, false);
  assert.ok(Math.abs(late.timeDiffMs + 20) < 1e-6, `实际 ${late.timeDiffMs}`);
  assert.equal(late.grade, GRADE.PERFECT);

  // 偏 100ms 就掉出 PERFECT（窗口 62.5ms），但还在 OK（250ms）内
  const off = read(hitBeat * 0.5 + 0.1);
  assert.equal(off.grade, GRADE.GOOD);

  // 偏 300ms 直接 MISS
  assert.equal(read(hitBeat * 0.5 + 0.3).grade, GRADE.MISS);
});

test('★ 集成：改了偏移之后，判定跟着整体平移', () => {
  const chart = straightChart();
  let now = 0;
  const clock = new SongClock({ now: () => now, bpm: BPM, offsetSec: 0 });
  clock.startAt(0);
  const index = 4;

  const judgeNow = () => judgeHitIndex(chart, index, clock.beat);

  // 墙上时钟 2.000 秒 = 第 4 拍，正中
  now = 2.0;
  assert.ok(Math.abs(judgeNow().timeDiffMs) < 1e-9);

  // 补偿 30ms 之后，同样在 2.000 秒按下就变成「早了 30ms」
  clock.offsetSec = 0.03;
  const shifted = judgeNow();
  assert.equal(shifted.early, true);
  assert.ok(Math.abs(shifted.timeDiffMs - 30) < 1e-6, `实际 ${shifted.timeDiffMs}`);
});

test('★ 集成：判定用的时刻由调用者决定，不受中间渲染过几次影响', () => {
  const chart = straightChart();
  let now = 0;
  const clock = new SongClock({ now: () => now, bpm: BPM, offsetSec: 0 });
  clock.startAt(0);

  const index = 20;
  const hitTime = chart.segments[index].hitBeat * 0.5;

  // 先在很早的地方"渲染"很多帧
  for (let k = 0; k < 500; k++) {
    now = k * 0.001;
    judgeHitIndex(chart, index, clock.beat);
  }

  // 然后直接跳到击打时刻按下 —— 结果必须还是完美
  now = hitTime;
  const r = judgeHitIndex(chart, index, clock.beat);
  assert.equal(r.grade, GRADE.PERFECT);
  assert.ok(Math.abs(r.timeDiffMs) < 1e-9, `实际 ${r.timeDiffMs}`);
});
