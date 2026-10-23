/**
 * 判定核心 —— 全项目最重要、也最该被单独测试的一段代码。
 *
 * 它是纯函数：给定「行星现在在哪」和「完美点在哪」，算出角度差和判定等级。
 * 不碰 Canvas、不碰时钟、不碰输入，所以能用 `npm test` 直接验证。
 *
 * ── 角度差的符号约定 ──────────────────────────────────────
 *   正数 = 早（行星还没转到完美点，你就按了）
 *   负数 = 晚（行星已经越过完美点，你才按）
 *
 * ── 为什么不能简单相减 ────────────────────────────────────
 * 行星在不停转圈，-170° 和 170° 只差 20°，不是 340°。而且玩家「按早了 340°」
 * 和「按晚了 20°」在体感上是同一件事。所以这里统一取「离完美点最近的那一次」，
 * 把误差压到 (-180°, 180°]，超出这个范围本来就是 MISS，不影响判级。
 */

import { TAU, toDeg } from './geometry.js';

/** 判定等级 */
export const GRADE = Object.freeze({
  PERFECT: 'PERFECT',
  GOOD: 'GOOD',
  OK: 'OK',
  MISS: 'MISS',
});

/**
 * 浮点容差。
 *
 * 角度在「度 → 弧度 → 度」往返一次就会带上 1e-15 量级的误差，
 * 于是正好等于 22.5 的一次按键会算成 22.500000000000004，掉进 GOOD。
 * 加一个远小于任何真实误差的容差，让边界表现和文档写的一致。
 */
const EPS = 1e-9;

/**
 * 按角度差绝对值给等级。纯查表，无副作用。
 * @param {number} absAngleDeg 角度差绝对值（度），必须 ≥ 0
 * @param {{perfect:number, good:number, ok:number}} w 判定窗口（度）
 * @returns {'PERFECT'|'GOOD'|'OK'|'MISS'}
 */
export function classify(absAngleDeg, w) {
  if (absAngleDeg <= w.perfect + EPS) return GRADE.PERFECT;
  if (absAngleDeg <= w.good + EPS) return GRADE.GOOD;
  if (absAngleDeg <= w.ok + EPS) return GRADE.OK;
  return GRADE.MISS;
}

/** 角度差（度）→ 时间差（毫秒） */
export function angleToMs(angleDeg, msPerTurn) {
  return (angleDeg / 360) * msPerTurn;
}

/**
 * 核心判定。
 *
 * @param {number} planetAngle 按下瞬间，行星相对砖块的极角（弧度）
 * @param {number} targetAngle 完美按下时的极角（弧度），即「砖块 → 下一砖块」的方向
 * @param {number} omega       行星角速度（弧度/毫秒，带符号；只用它的符号判断公转方向）
 * @param {{windows:{perfect:number,good:number,ok:number}, msPerTurn:number}} opts
 * @returns {{
 *   grade: string,
 *   angleDiffDeg: number,  // 正 = 早，负 = 晚
 *   timeDiffMs: number,    // 正 = 早，负 = 晚
 *   absAngleDeg: number,
 *   absTimeMs: number,
 *   early: boolean,
 * }}
 */
export function judgeHit(planetAngle, targetAngle, omega, { windows, msPerTurn }) {
  const travel = Math.sign(omega) || 1;

  // 沿「公转方向」从行星当前位置到完美点还要转多少，规整到 [0, 2π)
  const raw = (targetAngle - planetAngle) * travel;
  const along = ((raw % TAU) + TAU) % TAU;

  // along ≈ 0        → 正好踩在完美点
  // along 是个小正数  → 还差一点才到，按早了
  // along 接近 2π     → 刚刚越过去，按晚了
  const signed = along <= Math.PI ? along : along - TAU;

  const angleDiffDeg = toDeg(signed);
  const timeDiffMs = angleToMs(angleDiffDeg, msPerTurn);

  return {
    grade: classify(Math.abs(angleDiffDeg), windows),
    angleDiffDeg,
    timeDiffMs,
    absAngleDeg: Math.abs(angleDiffDeg),
    absTimeMs: Math.abs(timeDiffMs),
    early: angleDiffDeg >= 0,
  };
}
