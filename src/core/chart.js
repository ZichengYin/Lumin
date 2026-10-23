/**
 * 谱面模型 + 轨迹几何。
 *
 * 这是多砖块的核心。它把「一串方向角」翻译成：
 *   - 每块砖在平面上的位置
 *   - 行星在第 i 块砖上要转过多少度、花多少拍、什么时候该按
 *   - 给定任意时刻，行星在哪、当前是第几块砖
 *
 * 全部是纯函数 / 纯数据，不碰浏览器，也不碰 Canvas。
 *
 * ── 几何（和 ADOFAI 同一套）────────────────────────────────
 *
 *   砖块等距排列，相邻两块间距 2R（R = 轨道半径）。
 *   行星绕**当前砖块**转，半径恒为 R。
 *
 *   设第 i 段的方向是 dᵢ（从砖块 i 指向砖块 i+1）：
 *
 *     · 上一段的完美点是 Mᵢ₋₁ = 砖块 i 与 i-1 的中点，
 *       从砖块 i 看过去，方向正好是 dᵢ₋₁ + 180°
 *     · 本段的完美点是 Mᵢ = 砖块 i 与 i+1 的中点，方向是 dᵢ
 *     · 所以第 i 段要转过的角度就是「从 dᵢ₋₁+180° 转到 dᵢ」
 *
 *   行星**永远朝同一个方向转**（`direction`），转过的角度落在 (0°, 360°)。
 *   于是：直线前进 = 180°，急转弯 < 180°（快），缓弯 > 180°（慢）。
 *   dᵢ = dᵢ₋₁ + 180°（原地掉头）会让转过角度变成 0 —— 没有任何反应时间，
 *   所以构建谱面时会直接拒绝。
 *
 * ── 两种配速方式 ───────────────────────────────────────────
 *
 *   `timing: "auto"`    ADOFAI 的做法：时长由转角推出来，beats = 转角 / 180。
 *                       结果是**角速度恒为每拍 180°**，行星匀速旋转，
 *                       直线慢、急转弯快。好看，但节奏由几何决定。
 *
 *   `timing: "uniform"` 每块砖固定 `beatsPerTile` 拍（默认 1）。
 *                       节奏整齐、落点可控，代价是角速度会随转角变化。
 *                       想要「每一拍正好一块砖」就用这个。
 *
 * 单块砖可以用 `beats` 字段覆盖上面两种。
 */

import { TAU, toRad } from './geometry.js';

/** ADOFAI 风格的基准转速：每拍 180° */
export const DEG_PER_BEAT = 180;

/** 规整到 [0, 360) */
export function wrap360(deg) {
  const x = deg % 360;
  const r = x < 0 ? x + 360 : x;
  // -360 % 360 得到 -0，而 Object.is(-0, 0) 是 false，会让 `=== 0` 之外的
  // 严格比较莫名失败。这里归一成 +0。
  return r === 0 ? 0 : r;
}

/**
 * 行星在第 i 段上要转过的角度（正数，单位度）。
 *
 * @param {number} prevDirDeg 上一段的方向（砖块 i-1 → i）
 * @param {number} dirDeg     本段的方向（砖块 i → i+1）
 * @param {1|-1} direction    +1 极角递增 / -1 递减
 * @returns {number} (0, 360) 开区间；返回 0 表示这是一次掉头，非法
 */
export function sweepOf(prevDirDeg, dirDeg, direction = 1) {
  // 起点方向：从砖块 i 看向上一段的完美点
  const start = prevDirDeg + 180;
  const delta = direction > 0 ? dirDeg - start : start - dirDeg;
  return wrap360(delta);
}

/** 一次掉头（方向差 180°）会让转动量变成 0，谱面不允许 */
export function isUturn(prevDirDeg, dirDeg) {
  return sweepOf(prevDirDeg, dirDeg, 1) === 0;
}

/**
 * 把原始的谱面数据编译成一个算好的谱面对象。
 *
 * @param {object} raw
 * @param {number} raw.bpm
 * @param {number[]} raw.angles  每段的方向角（度）。n 个方向 → n 次击打、n+1 块砖。
 * @param {'uniform'|'auto'} [raw.timing='uniform']
 * @param {number} [raw.beatsPerTile=1]  uniform 模式下每块砖几拍
 * @param {number} [raw.leadInTurns=1]   开场空转几整圈（每圈 2 拍）
 * @param {1|-1} [raw.direction=1]
 */
export function buildChart(raw) {
  const bpm = requirePositive(raw.bpm, 'bpm');
  const beatMs = 60000 / bpm;
  const direction = raw.direction === -1 ? -1 : 1;
  const timing = raw.timing ?? 'uniform';
  const beatsPerTile = raw.beatsPerTile ?? 1;
  const leadInTurns = raw.leadInTurns ?? 1;

  if (!Array.isArray(raw.angles) || raw.angles.length < 1) {
    throw new Error('谱面至少要有 1 个方向角');
  }
  const angles = raw.angles.map((v, i) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`第 ${i} 个方向角不是数字：${v}`);
    return n;
  });

  for (let i = 1; i < angles.length; i++) {
    if (isUturn(angles[i - 1], angles[i])) {
      throw new Error(
        `第 ${i} 段和第 ${i - 1} 段方向相差 180°（原地掉头），` +
          `这会让行星需要转过的角度变成 0，玩家没有任何反应时间。` +
          `改掉其中一个方向角。`,
      );
    }
  }

  // ── 编译每一段 ────────────────────────────────────────────
  const segments = [];
  let cursor = 0;

  for (let i = 0; i < angles.length; i++) {
    const isFirst = i === 0;

    // 第 0 段是前奏：绕第一块砖空转几整圈，结束在第一次击打上
    const sweep = isFirst
      ? 360 * leadInTurns
      : sweepOf(angles[i - 1], angles[i], direction);

    const beats = isFirst
      ? sweep / DEG_PER_BEAT
      : resolveBeats(raw, i, sweep, timing, beatsPerTile);

    if (!(beats > 0)) {
      throw new Error(`第 ${i} 段的拍数算出来是 ${beats}，必须为正`);
    }

    const startBeat = isFirst ? -beats : cursor;
    const endBeat = startBeat + beats;

    // 起始极角（度）。第一段从「目标方向往回退一整段」开始
    const startAngleDeg = isFirst
      ? angles[0] - direction * sweep
      : angles[i - 1] + 180;

    const msTotal = beats * beatMs;
    const omega = (direction * toRad(sweep)) / msTotal; // 弧度/毫秒，带符号
    const msPerTurn = direction * toRad(sweep) !== 0 ? TAU / Math.abs(omega) : 0;

    segments.push({
      index: i,
      tileIndex: i,
      nextTileIndex: i + 1,
      sweep, // 转动角度（度，正数）
      beats,
      startBeat,
      endBeat,
      hitBeat: endBeat,
      startAngleDeg,
      targetAngleDeg: angles[i],
      omega,
      msPerTurn,
      /** 判定窗口换算成拍：windowDeg / 360 * msPerTurn / beatMs */
      windowBeats: (windowDeg) => (windowDeg / 360) * (msPerTurn / beatMs),
    });

    cursor = endBeat;
  }

  // ── 砖块位置（单位：相邻间距 = 1，渲染时再乘 2R）────────────
  const positions = [{ x: 0, y: 0 }];
  for (let i = 0; i < angles.length; i++) {
    const a = toRad(angles[i]);
    const prev = positions[positions.length - 1];
    positions.push({ x: prev.x + Math.cos(a), y: prev.y + Math.sin(a) });
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of positions) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  const last = segments[segments.length - 1];

  return {
    bpm,
    beatMs,
    direction,
    timing,
    angles,
    segments,
    positions,
    props: normalizeProps(raw.props, positions, angles),
    /**
     * 音频偏移（秒）。正值 = 把谱面整体往后推。
     *
     * 为什么需要它：曲子开头常常不是从第 0 个采样就开始打拍子
     * （导出留白、淡入、弱起小节）。本作的《向光》前面就有约 105ms 静音；
     * 不补的话**每一击都会晚 105ms**——比 PERFECT 窗口（±62.5ms）还大，
     * 也就是全程判「晚」。这个数用 tools/analyze-music.mjs 量出来。
     */
    audioOffsetSec: Number.isFinite(raw.audioOffsetSec) ? raw.audioOffsetSec : 0,
    hitCount: segments.length,
    tileCount: positions.length,
    /** 第 0 拍 = 第一次击打；负数 = 前奏 */
    durationBeats: last.endBeat,
    bounds: { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY },
  };
}

/**
 * 支持的物件类型。
 *
 * `manhole`       井盖（编辑器里标 **a**）
 * `obstacle-left` 左侧障碍（编辑器里标 **b**）
 * `turn`          转向箭头（暂时保留，导航层取消后已经不用了）
 */
export const PROP_TYPES = ['manhole', 'obstacle-left', 'turn'];

/**
 * 把谱面里的 `props` 规整成带具体坐标的列表（仍然是谱面坐标，间距 = 1）。
 *
 * 位置有两种写法，任选其一：
 *
 *   ① 挂在某一格上（推荐，改谱面角度时不会失准）
 *      { "tile": 12, "along": 0.5, "lateral": -0.64 }
 *      `along` = 沿这一格的方向走多远（格距 = 1，所以 0.5 是正中间）
 *      `lateral` = 再往行进方向的右手边垂直偏多少（负数就是左手边）
 *
 *   ② 直接给绝对坐标（改角度时会被留在原地，慎用）
 *      { "x": 8.82, "y": 0 }
 */
function normalizeProps(rawProps, positions, angles) {
  if (rawProps === undefined || rawProps === null) return [];
  if (!Array.isArray(rawProps)) throw new Error('props 必须是数组');

  return rawProps.map((p, i) => {
    const type = String(p?.type ?? '');
    if (!PROP_TYPES.includes(type)) {
      throw new Error(`第 ${i} 个 props 的类型不认识：${JSON.stringify(p?.type)}（只支持 ${PROP_TYPES.join(' / ')}）`);
    }

    let x;
    let y;

    if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
      x = p.x;
      y = p.y;
    } else {
      const tile = p.tile;
      if (!Number.isInteger(tile) || tile < 0 || tile >= positions.length) {
        throw new Error(
          `第 ${i} 个 props（${type}）的 tile 非法：${JSON.stringify(tile)}，` +
            `应当在 0 ~ ${positions.length - 1} 之间`,
        );
      }
      const along = Number.isFinite(p.along) ? p.along : 0.5;
      const lateral = Number.isFinite(p.lateral) ? p.lateral : 0;
      // 用这一格自己的方向来定位；最后一格没有「下一段」，退回上一段的方向
      const dirDeg = angles[Math.min(tile, angles.length - 1)];
      const a = toRad(dirDeg);
      const fx = Math.cos(a);
      const fy = Math.sin(a);
      // 行进方向的右手边（屏幕坐标 y 向下，所以是这个符号）
      const rx = -Math.sin(a);
      const ry = Math.cos(a);
      x = positions[tile].x + fx * along + rx * lateral;
      y = positions[tile].y + fy * along + ry * lateral;
    }

    const base = {
      type,
      index: i,
      x,
      y,
      /**
       * ★ `along` / `lateral` 必须**保留下来**。
       *
       *   它们不只是用来算 x/y 的中间量：`buildWorldTrack` 换算世界坐标时
       *   会**重新用一遍**这两个值。之前这里没带出来，那边读到 undefined，
       *   于是每个物件的世界坐标都变成 NaN —— 表现是物件渲染在错误的位置、
       *   而且被投影成又高又细的白条（NaN 传进透视公式之后的样子）。
       */
      along: Number.isFinite(p.along) ? p.along : 0.5,
      lateral: Number.isFinite(p.lateral) ? p.lateral : 0,
      /** 挂在第几格上（用绝对坐标写的物件没有这一项） */
      tile: Number.isInteger(p.tile) ? p.tile : null,
      /**
       * 单独覆盖全局的播报提前量（单位：拍）。
       * 不写就用 CONFIG.voice.leadBeats。
       * ★ 别漏了这一项 —— 漏掉的话作者在 JSON 里写了 warnBeats，
       *   解析时被丢掉、渲染和播报都用默认值，而且**不会有任何报错**。
       */
      warnBeats: Number.isFinite(p.warnBeats) ? p.warnBeats : undefined,
    };

    if (type === 'manhole') {
      const radius = Number.isFinite(p.radius) ? p.radius : 0.33;
      if (!(radius > 0)) throw new Error(`第 ${i} 个井盖的 radius 非法：${p.radius}`);
      return { ...base, radius };
    }

    // turn：方向由 dir 给，1 = 右转 / -1 = 左转。
    // 宽容一点：按符号判断，字符串 'left' / 'right' 也认。
    // （注意：箭头实际折多少度是从谱面转角算出来的，dir 只是给作者看的记录）
    const raw = p.dir;
    const dir = typeof raw === 'string' ? (raw.toLowerCase() === 'left' ? -1 : 1) : raw < 0 ? -1 : 1;
    return { ...base, dir };
  });
}

function resolveBeats(raw, index, sweep, timing, beatsPerTile) {
  const override = raw.beats?.[index];
  if (override !== undefined && override !== null) {
    const n = Number(override);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`第 ${index} 段的 beats 覆盖值非法：${override}`);
    }
    return n;
  }
  if (timing === 'auto') return sweep / DEG_PER_BEAT;
  return beatsPerTile;
}

function requirePositive(v, name) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`谱面的 ${name} 非法：${v}`);
  return n;
}

// ── 查询 ────────────────────────────────────────────────────

/**
 * 找出某个拍位落在哪一段。用二分查找，几百块砖也是一瞬间。
 * 前奏之前返回第 0 段，曲子结束之后返回最后一段。
 */
export function segmentAtBeat(chart, beat) {
  const segs = chart.segments;
  if (beat <= segs[0].startBeat) return segs[0];
  if (beat >= segs[segs.length - 1].endBeat) return segs[segs.length - 1];

  let lo = 0;
  let hi = segs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs[mid].startBeat <= beat) lo = mid;
    else hi = mid - 1;
  }
  return segs[lo];
}

/** 第 i 次击打发生在第几拍 */
export function hitBeatOf(chart, i) {
  const seg = chart.segments[i];
  if (!seg) throw new Error(`没有第 ${i} 次击打（总共 ${chart.hitCount} 次）`);
  return seg.hitBeat;
}

/**
 * 给定拍位，算出行星此刻的完整状态。
 * 渲染和判定共用这一个函数，保证两边不会算出不同答案。
 *
 * @returns {{
 *   segment: object, index: number, tile: {x:number,y:number},
 *   planetAngle: number, targetAngle: number,
 *   omega: number, msPerTurn: number, progress: number,
 * }}
 */
export function planetStateAtBeat(chart, beat) {
  const seg = segmentAtBeat(chart, beat);
  const span = seg.endBeat - seg.startBeat;
  const raw = span > 0 ? (beat - seg.startBeat) / span : 0;
  const progress = Math.max(0, Math.min(1, raw));

  const planetAngle = toRad(seg.startAngleDeg) + seg.omega * span * chart.beatMs * progress;

  return {
    segment: seg,
    index: seg.index,
    tile: chart.positions[seg.tileIndex],
    nextTile: chart.positions[seg.nextTileIndex],
    planetAngle,
    targetAngle: toRad(seg.targetAngleDeg),
    omega: seg.omega,
    msPerTurn: seg.msPerTurn,
    progress,
  };
}

/** 第 i 次击打的完美点（单位坐标下的中点） */
export function hitPoint(chart, i) {
  const a = chart.positions[i];
  const b = chart.positions[i + 1];
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * 第 seg 段在任意拍位上的行星极角（弧度）。
 *
 * 允许外推到该段区间之外。因为玩家可能按得很早——那一刻行星名义上还在上一块砖上，
 * 但判定要按**这一块**的转速折算，所以需要这个外推值，才能和 `judgeHit` 对上。
 */
export function segmentAngleAtBeat(chart, seg, beat) {
  return toRad(seg.startAngleDeg) + seg.omega * (beat - seg.startBeat) * chart.beatMs;
}

/**
 * 把谱面编译结果反过来检查一遍：每一步的结束极角必须正好等于目标方向，
 * 每一步的起始位置必须正好是上一段的完美点。测试和调试用。
 */
export function verifyChart(chart) {
  const problems = [];
  for (const seg of chart.segments) {
    const endAngleDeg = seg.startAngleDeg + chart.direction * seg.sweep;
    // 角度按 360 取模比较
    const diff = wrap360(endAngleDeg) - wrap360(seg.targetAngleDeg);
    const norm = ((diff + 540) % 360) - 180;
    if (Math.abs(norm) > 1e-9) {
      problems.push(
        `第 ${seg.index} 段：转过 ${seg.sweep}° 后极角 ${wrap360(endAngleDeg).toFixed(3)}°，` +
          `但目标方向是 ${wrap360(seg.targetAngleDeg).toFixed(3)}°`,
      );
    }
    if (seg.index > 0) {
      const prev = chart.segments[seg.index - 1];
      const expectedStart = wrap360(prev.targetAngleDeg + 180);
      const actualStart = wrap360(seg.startAngleDeg);
      const d = ((actualStart - expectedStart + 540) % 360) - 180;
      if (Math.abs(d) > 1e-9) {
        problems.push(
          `第 ${seg.index} 段的起点 ${actualStart.toFixed(3)}° ` +
            `不是上一段的完美点 ${expectedStart.toFixed(3)}°`,
        );
      }
    }
  }
  return problems;
}
