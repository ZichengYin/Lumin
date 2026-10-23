/**
 * 导航播报清单 + 路面物件落位检查。
 *
 * 抽成独立模块是因为**游戏、预览工具、测试三边都要用**：
 * 如果各算各的，工具里显示「第 4.5 拍播报」而游戏实际在第 5 拍播，
 * 这种偏差肉眼看不出来，但作者会被彻底带偏。
 *
 * 纯逻辑，不碰 DOM / 不碰 AudioContext，可以在 Node 里直接测。
 */

function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/**
 * 井盖落位检查：离最近一段路的中线有多远、需要多远、还剩多少余量。
 *
 * 余量 <= 0 就是**穿模** —— 路从井盖上碾过去。这是这个功能最容易翻车的地方：
 * 几何上差一点点，画面上就是路压在井盖上，而且不盯着看根本发现不了。
 *
 * @returns {Array<{prop, distance, segment, need, clearance}>}
 */
export function manholeClearance(chart, { tileSpacing, pathWidth }) {
  const half = pathWidth / 2 / tileSpacing; // 半个路宽，换成谱面单位
  const out = [];

  for (const prop of (chart.props ?? []).filter((p) => p.type === 'manhole')) {
    let best = Infinity;
    let bestSeg = -1;
    for (let i = 0; i < chart.hitCount; i++) {
      const d = distToSegment(prop, chart.positions[i], chart.positions[i + 1]);
      if (d < best) {
        best = d;
        bestSeg = i;
      }
    }
    const need = half + prop.radius;
    out.push({ prop, distance: best, segment: bestSeg, need, clearance: best - need });
  }
  return out;
}

/** 物件类型 → 语音名 */
export const CUE_OF_TYPE = {
  manhole: 'obstacle',
  turn: 'turn-left', // 只是兜底，转向实际按转角判断
};

/**
 * 左右转的判断。
 *
 * ⚠️ **转角的符号和「左右」是反的，这里是踩过坑的。**
 *
 * 谱面坐标 y 向下，正角度是从 +x 转向 +y；但镜头是看着角色的**朝向前方**，
 * 换算到镜头坐标后横向分量是 `sin(a − b)`：转弯后方向 b 比 a 大时它是负的，
 * 也就是落在**屏幕左边**。
 *
 * 所以 d > 0 = 左转，d < 0 = 右转。
 * 截图证据：level01 的井盖绕行用 `-90, 0, 90`（d = -90），画面上确实是往右凸出去的。
 * 直觉上很容易当成「正角度 = 右」，反过来会让语音和画面对不上。
 */
export function turnCue(chart, tile) {
  const last = chart.angles.length - 1;
  let d = chart.angles[Math.min(tile, last)] - chart.angles[Math.max(0, tile - 1)];
  while (d > 180) d -= 360;
  while (d <= -180) d += 360;
  if (d > 0) return 'turn-left';
  if (d < 0) return 'turn-right';
  return null; // 没转弯就不该有箭头，也不该有播报
}

/** 转角 → `props.dir` 用的记号。1 = 右转 / -1 = 左转（和上面的反号一致） */
export function dirOfTurn(chart, tile) {
  const cue = turnCue(chart, tile);
  if (cue === 'turn-right') return 1;
  if (cue === 'turn-left') return -1;
  return 0;
}

/**
 * 某个物件「玩家必须做出反应」的那一拍。
 *
 *   · 转向：就是这一格的起点 —— 他在这一格上完成转身
 *   · 井盖：要早一格 —— 绕行的第一个拐点在这一格的前一格
 *     （绕行是「拐出去 → 走一格 → 拐回来」，中间那一格放井盖）
 */
export function actionBeat(chart, prop) {
  if (prop.tile === null || prop.tile === undefined) return null;
  const anchor = prop.type === 'manhole' ? Math.max(0, prop.tile - 1) : prop.tile;
  const seg = chart.segments[anchor];
  return seg ? seg.startBeat : null;
}

/**
 * 生成播报清单，按拍号从小到大排好。
 *
 * @param {object} chart
 * @param {object} opts
 * @param {number} opts.leadBeats 提前多少拍播报
 * @returns {Array<{cue:string, beat:number, index:number, reason:string}>}
 */
export function buildWarnings(chart, { leadBeats = 5 } = {}) {
  const out = [];

  for (const prop of chart.props ?? []) {
    const beat0 = actionBeat(chart, prop);
    if (beat0 === null) continue; // 用绝对坐标写的物件没有拍号可言

    const cue = prop.type === 'manhole' ? 'obstacle' : turnCue(chart, prop.tile);
    if (!cue) continue;

    const lead = Number.isFinite(prop.warnBeats) ? prop.warnBeats : leadBeats;
    out.push({
      cue,
      // 负数也没关系 —— 前奏里就该响的提示，会在前奏期间播出去
      beat: beat0 - lead,
      actionBeat: beat0,
      index: prop.index,
      /** 给作者看的说明 */
      reason:
        prop.type === 'manhole'
          ? `井盖（P${prop.tile}）`
          : `转向（P${prop.tile}${cue === 'turn-right' ? ' 右' : ' 左'}）`,
    });
  }

  return out.sort((a, b) => a.beat - b.beat);
}

/**
 * 找两条播报挨得太近的情况。
 *
 * 语音最长的约 1.4 秒。两条挨得比这更近，后一条会把前一条**打断** ——
 * 结果是玩家只听到一半，甚至完全没听到前一个提示。
 * 这是谱面作者最容易踩、又最难自己发现的坑（要正好听到那一段才发现）。
 *
 * @returns {Array<{a:object, b:object, gapBeats:number, gapSec:number}>}
 */
export function findCrowdedWarnings(warnings, beatSec, minGapSec = 1.4) {
  const out = [];
  for (let i = 1; i < warnings.length; i++) {
    const gapSec = (warnings[i].beat - warnings[i - 1].beat) * beatSec;
    if (gapSec < minGapSec) {
      out.push({ a: warnings[i - 1], b: warnings[i], gapBeats: warnings[i].beat - warnings[i - 1].beat, gapSec });
    }
  }
  return out;
}
