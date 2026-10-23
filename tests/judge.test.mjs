/**
 * 判定逻辑单元测试。
 *
 *   npm test        或        node --test tests/
 *
 * 判定是纯数学，跟画面无关，所以必须先在这里验证正确，再去调手感。
 * 以后每次改判定窗口，跑一遍这个文件就知道有没有把别的东西碰坏。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { judgeHit, classify, GRADE, angleToMs } from '../src/core/judge.js';
import { wrapRad, wrapDeg, toRad, toDeg, TAU } from '../src/core/geometry.js';

const WINDOWS = { perfect: 22.5, good: 45, ok: 90 };
const MS_PER_TURN = 500; // 120 BPM，转一圈 500ms，1° = 1.389ms

const opts = { windows: WINDOWS, msPerTurn: MS_PER_TURN };
const CCW = 1; // 极角递增方向
const CW = -1;

/** 造一个「行星比完美点早了 earlyDeg 度」的场景 */
const earlyBy = (earlyDeg, dir = CCW) => ({
  planet: dir * toRad(-earlyDeg),
  target: 0,
  omega: dir,
});

test('几何：wrapRad 规整到 (-π, π]', () => {
  assert.equal(wrapRad(0), 0);
  assert.ok(Math.abs(wrapRad(toRad(350)) - toRad(-10)) < 1e-12);
  assert.ok(Math.abs(wrapRad(toRad(-350)) - toRad(10)) < 1e-12);
  assert.ok(Math.abs(wrapRad(TAU) - 0) < 1e-12);
  assert.ok(Math.abs(wrapRad(-Math.PI) - Math.PI) < 1e-12);
});

test('几何：wrapDeg 规整到 (-180, 180]', () => {
  assert.equal(wrapDeg(0), 0);
  assert.equal(wrapDeg(190), -170);
  assert.equal(wrapDeg(-190), 170);
  assert.equal(wrapDeg(180), 180);
});

test('classify：窗口边界取「小于等于」，正好压在边界上算更宽松的那档', () => {
  assert.equal(classify(0, WINDOWS), GRADE.PERFECT);
  assert.equal(classify(22.5, WINDOWS), GRADE.PERFECT);
  assert.equal(classify(22.51, WINDOWS), GRADE.GOOD);
  assert.equal(classify(45, WINDOWS), GRADE.GOOD);
  assert.equal(classify(45.01, WINDOWS), GRADE.OK);
  assert.equal(classify(90, WINDOWS), GRADE.OK);
  assert.equal(classify(90.01, WINDOWS), GRADE.MISS);
  assert.equal(classify(180, WINDOWS), GRADE.MISS);
});

test('angleToMs：500ms 一圈时，360° = 500ms', () => {
  assert.equal(angleToMs(360, MS_PER_TURN), 500);
  assert.equal(angleToMs(180, MS_PER_TURN), 250);
  assert.equal(angleToMs(-90, MS_PER_TURN), -125);
});

test('正好踩在完美点上：角度差 0、PERFECT', () => {
  const r = judgeHit(0, 0, CCW, opts);
  assert.equal(r.grade, GRADE.PERFECT);
  assert.equal(r.angleDiffDeg, 0);
  assert.equal(r.timeDiffMs, 0);
  assert.equal(r.absAngleDeg, 0);
  assert.equal(r.early, true); // 0 归到「早」这一侧，显示时是 +0.0°
});

test('按早了：角度差为正，时间差也是正', () => {
  for (const d of [5, 10, 22.5]) {
    const s = earlyBy(d);
    const r = judgeHit(s.planet, s.target, s.omega, opts);
    assert.ok(Math.abs(r.angleDiffDeg - d) < 1e-9, `${d}° 应判为早 ${d}°`);
    assert.equal(r.early, true);
    assert.ok(r.timeDiffMs > 0);
    assert.equal(r.grade, GRADE.PERFECT);
  }
});

test('按晚了：角度差为负，时间差也是负', () => {
  for (const d of [5, 10, 22.5]) {
    const s = { planet: toRad(d), target: 0, omega: CCW };
    const r = judgeHit(s.planet, s.target, s.omega, opts);
    assert.ok(Math.abs(r.angleDiffDeg + d) < 1e-9, `越过 ${d}° 应判为晚 ${d}°`);
    assert.equal(r.early, false);
    assert.ok(r.timeDiffMs < 0);
    assert.equal(r.grade, GRADE.PERFECT);
  }
});

test('公转方向反过来，早晚符号不能跟着翻', () => {
  // 逆时针：行星在 -10°（还没到 0°）→ 早 10°
  const ccw = judgeHit(toRad(-10), 0, CCW, opts);
  assert.ok(Math.abs(ccw.angleDiffDeg - 10) < 1e-9);
  assert.equal(ccw.early, true);

  // 顺时针：行星在 +10°（往 0° 走，还没到）→ 同样是早 10°
  const cw = judgeHit(toRad(10), 0, CW, opts);
  assert.ok(Math.abs(cw.angleDiffDeg - 10) < 1e-9);
  assert.equal(cw.early, true);

  // 顺时针：行星在 -10°（已经越过 0°）→ 晚 10°
  const cwLate = judgeHit(toRad(-10), 0, CW, opts);
  assert.ok(Math.abs(cwLate.angleDiffDeg + 10) < 1e-9);
  assert.equal(cwLate.early, false);
});

test('跨 ±180° 不能被算成 350° 的误差', () => {
  // 行星在 -170°，完美点在 170°，逆时针走：刚刚越过完美点 20°
  const r = judgeHit(toRad(-170), toRad(170), CCW, opts);
  assert.ok(Math.abs(r.angleDiffDeg + 20) < 1e-9, `应为晚 20°，实际 ${r.angleDiffDeg}`);
  assert.equal(r.early, false);
  assert.equal(r.grade, GRADE.PERFECT);
});

test('误差永远落在 (-180, 180] 内', () => {
  for (let deg = -180; deg <= 180; deg += 7) {
    for (const dir of [CCW, CW]) {
      const r = judgeHit(toRad(deg), 0, dir, opts);
      assert.ok(r.angleDiffDeg > -180.0001 && r.angleDiffDeg <= 180.0001, `${deg}° dir=${dir} → ${r.angleDiffDeg}`);
      assert.equal(r.absAngleDeg, Math.abs(r.angleDiffDeg));
      assert.equal(r.absTimeMs, Math.abs(r.timeDiffMs));
    }
  }
});

test('判定等级随误差单调变差', () => {
  const order = { PERFECT: 0, GOOD: 1, OK: 2, MISS: 3 };
  let prev = -1;
  for (const d of [0, 10, 22.5, 30, 45, 60, 90, 120, 179]) {
    const s = earlyBy(d);
    const r = judgeHit(s.planet, s.target, s.omega, opts);
    const rank = order[r.grade];
    assert.ok(rank >= prev, `${d}° 的等级不该比更小的误差更好`);
    prev = rank;
  }
});

test('角度差与毫秒的换算和 BPM 保持一致', () => {
  // 90 BPM 转一圈 666.67ms，22.5° 应该是 41.67ms
  const msTurn = (60000 / 90) * 1;
  const r = judgeHit(0, 0, CCW, { windows: WINDOWS, msPerTurn: msTurn });
  assert.equal(r.grade, GRADE.PERFECT);

  const s = earlyBy(22.5);
  const r2 = judgeHit(s.planet, s.target, s.omega, { windows: WINDOWS, msPerTurn: msTurn });
  assert.ok(Math.abs(r2.absTimeMs - 41.667) < 0.01, `实际 ${r2.absTimeMs}`);
});

test('角度和弧度的互转可逆', () => {
  for (const d of [-180, -90, -35, 0, 35, 90, 180]) {
    assert.ok(Math.abs(toDeg(toRad(d)) - d) < 1e-12);
  }
});
