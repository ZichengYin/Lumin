/**
 * 世界层绘制：地面上的一切。
 *
 * 这里所有的几何都是**地面平面上的平面图形**，交给 `camera.project` 投到屏幕。
 * 因为地面上的一条直线投影后还是直线，所以四边形可以直接 fill，
 * 只有「圆」需要采样成多边形（透视下它会变成椭圆，这不是 bug，是对的）。
 *
 * 这个文件不持有任何状态：世界几何由 main.js 算好后传进来。
 */

import { CONFIG } from '../config.js';

const C = CONFIG.colors;

/** 把一串已经投影好的点连成闭合路径 */
function closedPath(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

/** 一条世界直线段的两个端点，投影后画成一条线 */
function worldLine(ctx, camera, cam, a, b) {
  const seg = camera.projectSegment(a, b, cam);
  if (!seg) return false;
  ctx.beginPath();
  ctx.moveTo(seg[0].x, seg[0].y);
  ctx.lineTo(seg[1].x, seg[1].y);
  ctx.stroke();
  return true;
}

/**
 * 把谱面的平面坐标（相邻砖块间距 1）换算成世界坐标（间距 = spacing）。
 * 谱面的 +y（在下）对应世界的 +z（向前）。
 */
export function buildWorldTrack(chart, spacing) {
  const points = chart.positions.map((p) => ({ x: p.x * spacing, z: p.y * spacing }));
  const hits = chart.segments.map((_, i) => ({
    x: (points[i].x + points[i + 1].x) / 2,
    z: (points[i].z + points[i + 1].z) / 2,
  }));
  // 物件也一起放大到世界尺度
  const props = (chart.props ?? []).map((p) => ({
    ...p,
    x: p.x * spacing,
    z: p.y * spacing,
    radius: p.radius === undefined ? undefined : p.radius * spacing,
  }));
  return { points, hits, spacing, props, angles: chart.angles };
}

/** 某一段的左右两条边线方向（单位向量，垂直于路段） */
function perpOf(a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  // 在 xz 平面上把方向转 90°
  return { x: -dz / len, z: dx / len };
}

/**
 * 某个落脚点处的「斜接」方向：把相邻两段的垂线平均一下。
 * 拐角处两侧边线才不会各画各的、留出缺口。
 */
function miterAt(points, i, lo, hi) {
  let x = 0;
  let z = 0;
  if (i - 1 >= lo) {
    const p = perpOf(points[i - 1], points[i]);
    x += p.x;
    z += p.z;
  }
  if (i + 1 <= hi) {
    const p = perpOf(points[i], points[i + 1]);
    x += p.x;
    z += p.z;
  }
  const len = Math.hypot(x, z);
  if (len < 1e-9) return { x: 0, z: 0 };
  return { x: x / len, z: z / len };
}

/**
 * 画一条地面折线，**遇到镜头后面的点就断开**，而不是整条丢掉。
 * 身后的路面正好在镜头附近，不能因为几个点不可见就把整条路抹掉。
 */
function strokeVisibleRuns(ctx, camera, cam, pts) {
  let drawing = false;
  ctx.beginPath();
  for (const p of pts) {
    const s = camera.project(p, cam);
    if (!s) {
      drawing = false;
      continue;
    }
    if (!drawing) {
      ctx.moveTo(s.x, s.y);
      drawing = true;
    } else {
      ctx.lineTo(s.x, s.y);
    }
  }
  ctx.stroke();
}

/**
 * 第 i 段该以多大透明度画出来。
 *
 * 本作有**两套**可见性，它们是叠加的，不是二选一：
 *
 *   ① 环境亮度（ambient）：整条路都看得见，一分钟内由 1 渐暗到 0。
 *      这是开场那段时间 —— 玩家先看清路长什么样。
 *   ② 涟漪（reveal）：击打后以角色为圆心的那一小圈，**不随渐暗衰减**。
 *      一分钟之后环境亮度归零，能看见的就只剩这一圈。
 *
 * 取两者的**较大值**：渐暗还没走完时到处都亮（涟漪看不出来，无所谓），
 * 渐暗走完之后就只有涟漪亮着。若改成相乘，一分钟后人敲下去也是黑的。
 *
 * 半径是**路面上的距离**（以格为单位），不是屏幕距离 ——
 * 所以不能靠 ctx.clip 画个屏幕圆，那样在透视下会歪掉。
 *
 * @param {object} track
 * @param {number} i 第几段
 * @param {{x:number,z:number,radius:number,alpha:number}|null} reveal
 * @param {number} ambient 环境亮度 0 ~ 1
 * @returns {number} 0 ~ 1
 */
function revealAlpha(track, i, reveal, ambient = 1) {
  if (!reveal) return ambient;
  const a = track.points[i];
  const b = track.points[i + 1];
  if (!a || !b) return ambient;
  const mx = (a.x + b.x) / 2;
  const mz = (a.z + b.z) / 2;
  const d = Math.hypot(mx - reveal.x, mz - reveal.z);
  if (d >= reveal.radius) return ambient;
  // 边缘柔化宽度由 currentReveal 算好传进来（**固定值**，不跟半径缩放）——
  // 见那边的注释：跟着半径缩放会让扩散看不出来。
  const soft = reveal.soft ?? Math.max(0.6, reveal.radius * 0.55);
  const patch = Math.min(1, (reveal.radius - d) / soft) * reveal.alpha;
  return Math.max(ambient, patch);
}

/**
 * 盲道：一条宽 `width` 的条带，沿着谱面铺过去。
 *
 * 填充按段画（相邻段正好共边，不会重叠），但**两侧边线整条一起描**——
 * 如果每段各自描边，远处几十段挤在几像素里，半透明会一层层叠上去，
 * 结果「远处比近处还亮」，远近感完全反过来。
 *
 * @param {object} track  buildWorldTrack 的结果
 * @param {number} from   从第几段开始画（含）
 * @param {number} to     画到第几段（含）
 * @param {{x,z,radius,alpha}|null} reveal 涟漪：只画这圈范围内的几段
 */
/**
 * 把一个三角形区域贴上图片（canvas 2D 的纹理映射基本操作）。
 *
 * 原理：先 `clip()` 到三角形的屏幕位置，再用一个仿射矩阵把图片的
 * 三个 UV 点映到这三个屏幕点上。**三个点对一个仿射变换永远有精确解**，
 * 所以三角形内部不会歪。
 *
 * 透视四边形做不到（仿射只能映射平行四边形），但切成两个三角形之后，
 * 每个三角形各自精确 —— 拼起来就有真正的近大远小。
 *
 * @param {{x:number,y:number}[]} p 三个屏幕点
 * @param {{x:number,y:number}[]} uv 对应的三个图片像素坐标
 */
function drawTexturedTriangle(ctx, img, p, uv) {
  const [p0, p1, p2] = p;
  const [u0, u1, u2] = uv;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  ctx.lineTo(p1.x, p1.y);
  ctx.lineTo(p2.x, p2.y);
  ctx.closePath();
  ctx.clip();

  // 解 A·u + t = p 的二维仿射变换
  const det = u0.x * (u1.y - u2.y) + u1.x * (u2.y - u0.y) + u2.x * (u0.y - u1.y);
  if (!(Math.abs(det) > 1e-9)) {
    ctx.restore();
    return;
  }
  const a = (p0.x * (u1.y - u2.y) + p1.x * (u2.y - u0.y) + p2.x * (u0.y - u1.y)) / det;
  const b = (p0.y * (u1.y - u2.y) + p1.y * (u2.y - u0.y) + p2.y * (u0.y - u1.y)) / det;
  const c = (p0.x * (u2.x - u1.x) + p1.x * (u0.x - u2.x) + p2.x * (u1.x - u0.x)) / det;
  const d = (p0.y * (u2.x - u1.x) + p1.y * (u0.x - u2.x) + p2.y * (u1.x - u0.x)) / det;
  const e = p0.x - a * u0.x - c * u0.y;
  const f = p0.y - b * u0.x - d * u0.y;

  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

export function texturedPath(ctx, camera, cam, track, { width, from = 0, to = Infinity, imgA, imgB, fade = 0, alpha = 1, centerIndex = null, fadeStartTiles = 3, fadeEndTiles = 10 }) {
  const half = width / 2;
  const lo = Math.max(0, from);
  const last = Math.min(to, track.points.length - 2);
  if (last < lo || alpha <= 0.002) return;

  const a1 = Math.max(0, Math.min(1, 1 - fade)) * alpha;
  const a2 = Math.max(0, Math.min(1, fade)) * alpha;
  const ref = imgA?.naturalWidth ? imgA : imgB;
  if (!ref?.naturalWidth) return;
  const w = ref.naturalWidth;
  const h = ref.naturalHeight;

  // ★ 用 ctx.transform 而不是 setTransform —— 后者会把 createCanvas 设的
  //   高清屏缩放（dpr）覆盖掉，画面就缩到左上角一小块了（踩过）。
  for (let i = lo; i <= last; i++) {
    const a = track.points[i];
    const b = track.points[i + 1];

    // ★ 四角用**斜接法线**（miterAt），不是每段自己的垂直法线。
    //
    //   用每段自己的法线时，相邻两格在转弯处各用各的方向，
    //   中间会裂开一个楔形缺口 —— 这就是「拐角点没有图片」。
    //   斜接法线在同一个顶点上被相邻两格共用，两条边正好重合，格子严丝合缝。
    //   （blindPath 描边线一直用的是斜接，这里之前漏了。）
    const nA = miterAt(track.points, i, lo, last + 1);
    const nB = miterAt(track.points, i + 1, lo, last + 1);

    const AL = camera.project({ x: a.x + nA.x * half, z: a.z + nA.z * half }, cam);
    const AR = camera.project({ x: a.x - nA.x * half, z: a.z - nA.z * half }, cam);
    const BL = camera.project({ x: b.x + nB.x * half, z: b.z + nB.z * half }, cam);
    const BR = camera.project({ x: b.x - nB.x * half, z: b.z - nB.z * half }, cam);
    if (!AL || !AR || !BL || !BR) continue;

    // 切成两个三角形只能解决"四边形不共面"，解决不了**沿对角线的折痕** ——
    // 对角线两侧各自精确，但两边接不上，看起来就是砖块被掰了一下。
    //
    // 再沿长度方向细分 SEG 段，每段两个三角形，折痕被摊薄到 1/SEG 以下。
    // 3 段在实际画面里就看不出来了；继续加收益很小、drawImage 次数线性涨。
    const SEG = 3;
    const lerp = (p, q, t) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });

    // 远处渐隐：离角色超过 fadeStartTiles 格开始变暗，到 fadeEndTiles 格完全消失。
    // 不用「画到某格就截断」，那样会在边界留下一条硬切。
    let distAlpha = 1;
    if (centerIndex !== null) {
      const d = i - centerIndex;
      const beyond = Math.abs(d) - fadeStartTiles;
      const span = Math.max(1, fadeEndTiles - fadeStartTiles);
      if (beyond > 0) distAlpha = Math.max(0, 1 - beyond / span);
      if (distAlpha <= 0.002) continue;
    }

    for (const [img, al] of [
      [imgA, a1 * distAlpha],
      [imgB, a2 * distAlpha],
    ]) {
      if (!img?.complete || !img.naturalWidth || al <= 0.002) continue;
      ctx.save();
      ctx.globalAlpha = al;
      for (let s = 0; s < SEG; s++) {
        const t0 = s / SEG;
        const t1 = (s + 1) / SEG;
        const L0 = lerp(AL, BL, t0);
        const R0 = lerp(AR, BR, t0);
        const L1 = lerp(AL, BL, t1);
        const R1 = lerp(AR, BR, t1);
        const v0 = h * t0;
        const v1 = h * t1;

        drawTexturedTriangle(ctx, img, [L0, R0, L1], [{ x: 0, y: v0 }, { x: w, y: v0 }, { x: 0, y: v1 }]);
        drawTexturedTriangle(ctx, img, [R0, R1, L1], [{ x: w, y: v0 }, { x: w, y: v1 }, { x: 0, y: v1 }]);
      }
      ctx.restore();
    }
  }
}

export function blindPath(ctx, camera, cam, track, { width, from = 0, to = Infinity, reveal = null, ambient = 1 }) {
  const half = width / 2;
  const lo = Math.max(0, from);
  const last = Math.min(to, track.points.length - 2);
  if (last < lo) return;

  ctx.save();

  // ① 填充：逐段四边形
  const drawn = [];
  for (let i = lo; i <= last; i++) {
    const al = revealAlpha(track, i, reveal, ambient);
    if (al <= 0.002) continue;

    const a = track.points[i];
    const b = track.points[i + 1];
    const n = perpOf(a, b);

    const quad = [
      { x: a.x + n.x * half, z: a.z + n.z * half },
      { x: b.x + n.x * half, z: b.z + n.z * half },
      { x: b.x - n.x * half, z: b.z - n.z * half },
      { x: a.x - n.x * half, z: a.z - n.z * half },
    ].map((p) => camera.project(p, cam));

    if (quad.some((p) => !p)) continue;

    ctx.globalAlpha = al;
    closedPath(ctx, quad);
    ctx.fillStyle = C.ground;
    ctx.fill();
    drawn.push(i);
  }

  // ② 边线。只要整条路的亮度不一致（有涟漪，或者渐暗还没到全黑前的
  //    每一段其实都一样 —— 那走下面的整条描法），就得一段段描。
  //    整条连续描会一路画出显示范围之外。
  if (reveal) {
    ctx.strokeStyle = C.groundEdge;
    ctx.lineWidth = 1;
    for (const i of drawn) {
      const al = revealAlpha(track, i, reveal, ambient);
      const a = track.points[i];
      const b = track.points[i + 1];
      const n = perpOf(a, b);
      for (const s of [1, -1]) {
        const p1 = camera.project({ x: a.x + n.x * half * s, z: a.z + n.z * half * s }, cam);
        const p2 = camera.project({ x: b.x + n.x * half * s, z: b.z + n.z * half * s }, cam);
        if (!p1 || !p2) continue;
        ctx.globalAlpha = al;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
    }
    ctx.restore();
    return;
  }

  const left = [];
  const right = [];
  for (let i = lo; i <= last + 1; i++) {
    const n = miterAt(track.points, i, lo, last + 1);
    const p = track.points[i];
    left.push({ x: p.x + n.x * half, z: p.z + n.z * half });
    right.push({ x: p.x - n.x * half, z: p.z - n.z * half });
  }

  ctx.globalAlpha = ambient;
  ctx.strokeStyle = C.groundEdge;
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  strokeVisibleRuns(ctx, camera, cam, left);
  strokeVisibleRuns(ctx, camera, cam, right);

  ctx.restore();
}

/**
 * 盲道上一格一格的凸起纹理。
 *
 * 用**世界里等距**的横线画，所以透视会自动把它们挤到地平线附近——
 * 玩家不用数字就能从疏密看出远近，这是「2D 缩放模拟远近感」最直观的部分。
 */
export function blindPathGrid(ctx, camera, cam, track, { width, cell = 1.5, from = 0, to = Infinity, reveal = null, ambient = 1 }) {
  const half = width / 2;
  const last = Math.min(to, track.points.length - 2);

  ctx.save();
  ctx.strokeStyle = C.groundGrid;
  ctx.lineWidth = 1;

  for (let i = Math.max(0, from); i <= last; i++) {
    const al = revealAlpha(track, i, reveal, ambient);
    if (al <= 0.002) continue;
    ctx.globalAlpha = al;
    const a = track.points[i];
    const b = track.points[i + 1];
    const n = perpOf(a, b);
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.round(segLen / cell));

    for (let k = 0; k <= steps; k++) {
      // 段的首尾留给落点标记去画，这里跳过
      if (k === 0 || k === steps) continue;
      const t = k / steps;
      const cx = a.x + (b.x - a.x) * t;
      const cz = a.z + (b.z - a.z) * t;
      worldLine(
        ctx,
        camera,
        cam,
        { x: cx + n.x * half, z: cz + n.z * half },
        { x: cx - n.x * half, z: cz - n.z * half },
      );
    }
  }
  ctx.restore();
}

/**
 * 落点标记：每一次击打的那个点（两块砖的中点）。
 * 这是玩家要瞄准的地方，所以用比网格亮的颜色画一道短横线。
 */
export function hitMarks(ctx, camera, cam, track, { width, from = 0, to = Infinity, reveal = null, ambient = 1 }) {
  // 辅助线**不超出路宽** —— 出头的话会压在旁边的地上，看着像路面的一部分
  const half = width / 2;
  const last = Math.min(to, track.hits.length - 1);

  ctx.save();
  ctx.strokeStyle = C.hitMark;
  ctx.lineWidth = 2;
  ctx.lineCap = 'butt';

  for (let i = Math.max(0, from); i <= last; i++) {
    const al = revealAlpha(track, i, reveal, ambient);
    if (al <= 0.002) continue;
    ctx.globalAlpha = al;
    const n = perpOf(track.points[i], track.points[i + 1]);
    const h = track.hits[i];
    worldLine(
      ctx,
      camera,
      cam,
      { x: h.x + n.x * half, z: h.z + n.z * half },
      { x: h.x - n.x * half, z: h.z - n.z * half },
    );
  }
  ctx.restore();
}

/** 盲人脚下那圈：盲杖扫过的轨迹。透视下它是椭圆，这是对的 */
export function sweepRing(ctx, camera, cam, center, radius, { alpha = 1 } = {}) {
  const pts = camera.projectGroundCircle(center, radius, cam);
  if (!pts) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = C.sweepRing;
  ctx.lineWidth = 1.5;
  closedPath(ctx, pts);
  ctx.stroke();
  ctx.restore();
}

/** 盲人的落点（脚下那个小圆），半径 = 人物半径 */
export function footprint(ctx, camera, cam, center, radius) {
  const pts = camera.projectGroundCircle(center, radius, cam);
  if (!pts) return;
  ctx.save();
  ctx.fillStyle = C.footprint;
  closedPath(ctx, pts);
  ctx.fill();
  ctx.restore();
}

/** 盲杖：从盲人中心到末端的一条线 */
export function cane(ctx, camera, cam, center, tipAngle, radius) {
  const tip = {
    x: center.x + Math.cos(tipAngle) * radius,
    z: center.z + Math.sin(tipAngle) * radius,
  };
  ctx.save();
  ctx.strokeStyle = C.cane;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  worldLine(ctx, camera, cam, center, tip);

  // 末端加一个小点，扫到哪儿一眼能看清
  const p = camera.project(tip, cam);
  if (p) {
    ctx.fillStyle = C.caneTip;
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(2, p.scale * 0.18), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * 盲人。
 *
 * 素材是**俯视剪影**，所以它应该像一张贴纸躺在地面上，而不是立起来的广告牌。
 * 用 camera.groundFrame 取投影在该点的局部线性近似，直接当 Canvas 变换用，
 * 于是透视的压扁、拉长全都自动正确。
 *
 * @param {HTMLImageElement} image
 * @param {number} worldSize 素材高度对应的世界尺寸
 */
export function character(ctx, camera, cam, pos, worldYaw, image, worldSize, { invert = false } = {}) {
  if (!image || !image.complete || !image.naturalWidth) return;
  const m = camera.groundFrame(pos, worldYaw, cam);
  if (!m) return;

  const k = worldSize / image.naturalHeight; // 素材像素 → 世界单位
  ctx.save();
  // 素材是「黑剪影 + 白描边」，在纯黑背景上黑的部分等于不存在。
  // 反转亮度之后就变成「白剪影 + 暗描边」，形状和姿势才读得出来。
  if (invert) ctx.filter = 'invert(1)';
  // 用 transform（乘以当前矩阵）而不是 setTransform，才不会把高分屏的缩放抹掉
  ctx.transform(m.a * k, m.b * k, -m.c * k, -m.d * k, m.e, m.f);
  ctx.translate(-image.naturalWidth / 2, -image.naturalHeight / 2);
  ctx.drawImage(image, 0, 0);
  ctx.restore();
}

/**
 * 井盖：地面上一个圆。全黑阶段它就是唯一的形状提示。
 *
 * 有贴图时按地面圆裁成椭圆贴图，并在「失明前(1)」和「漆黑(2)」之间交叉淡入；
 * 没有贴图就退回描边圆。
 */
export function manhole(ctx, camera, cam, center, radius, { alpha = 1, imgA = null, imgB = null, fade = 0 } = {}) {
  const pts = camera.projectGroundCircle(center, radius, cam);
  if (!pts) return;

  const has = [imgA, imgB].some((m) => m?.complete && m?.naturalWidth);
  if (has) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const w = maxX - minX;
    const h = maxY - minY;
    if (w > 0 && h > 0) {
      ctx.save();
      for (const [img, k] of [
        [imgA, Math.max(0, 1 - fade)],
        [imgB, Math.max(0, fade)],
      ]) {
        if (!img?.complete || !img.naturalWidth || k <= 0.002) continue;
        ctx.save();
        ctx.globalAlpha = k * alpha;
        closedPath(ctx, pts);
        ctx.clip();
        ctx.drawImage(img, minX, minY, w, h);
        ctx.restore();
      }
      ctx.restore();
      return;
    }
  }

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = C.manhole;
  ctx.lineWidth = 2.5;
  closedPath(ctx, pts);
  ctx.stroke();
  ctx.restore();
}

/** 地面上的折线描边。任何一段落到镜头后面就整条丢掉 */
function groundPolyline(ctx, camera, cam, pts) {
  const screen = pts.map((p) => camera.project(p, cam));
  if (screen.some((p) => !p)) return false;
  ctx.beginPath();
  ctx.moveTo(screen[0].x, screen[0].y);
  for (let i = 1; i < screen.length; i++) ctx.lineTo(screen[i].x, screen[i].y);
  ctx.stroke();
  return true;
}

/**
 * 提示物（井盖 / 转向箭头）的透明度。
 *
 * · 看得见路的那些分钟里恒为 1 —— 它就是路面上的一个井盖，不该忽隐忽现，
 *   玩家要靠这段时间建立「井盖 → 路要绕」这个因果。
 * · 全黑之后按距离淡入：从黑暗里渐渐长出来，而不是突然冒出来。
 *   （太远的井盖在地面上被压成一条白线，那反而更抢眼，淡掉更好。）
 */
export function hintAlpha(camera, cam, pos, fade) {
  if (fade <= 0) return 1;
  const p = camera.project(pos, cam);
  if (!p) return 0;
  const span = Math.max(1e-6, CONFIG.world.hintFar - CONFIG.world.hintNear);
  const t = (p.ahead - CONFIG.world.hintNear) / span;
  const ramp = 1 - Math.max(0, Math.min(1, t));
  return Math.max(0, Math.min(1, 1 - fade + fade * ramp));
}

/**
 * 转向箭头：地面上一个「先直走、再拐弯」的折线箭头，拐的方向就是该转的方向。
 *
 * 画在转弯发生的那一格上，箭杆用**入射方向**（上一段的方向），
 * 折角用**谱面实际转过的角度** —— 这样箭头和路的形状永远一致，
 * 谱面从 45° 改成 90° 时箭头会自己跟着变，不用两头维护。
 *
 * @param {number} inAngleRad 入射方向（弧度，和谱面角度同一套约定）
 * @param {number} turnRad    实际转角（带符号，正 = 右转）
 * @param {number} size       箭杆长度（世界单位）
 */
export function turnArrow(ctx, camera, cam, pos, inAngleRad, turnRad, size, { alpha = 1 } = {}) {
  const bend = turnRad;
  const stem = size * 1.0;
  const a1 = inAngleRad + bend;

  const p0 = { x: pos.x - Math.cos(inAngleRad) * stem, z: pos.z - Math.sin(inAngleRad) * stem };
  const p1 = { x: pos.x, z: pos.z };
  const p2 = { x: pos.x + Math.cos(a1) * size * 0.7, z: pos.z + Math.sin(a1) * size * 0.7 };

  const head = size * 0.34;
  const halfW = size * 0.22;
  const tip = { x: p2.x + Math.cos(a1) * head, z: p2.z + Math.sin(a1) * head };
  const wingA = {
    x: p2.x + Math.cos(a1 + Math.PI / 2) * halfW,
    z: p2.z + Math.sin(a1 + Math.PI / 2) * halfW,
  };
  const wingB = {
    x: p2.x + Math.cos(a1 - Math.PI / 2) * halfW,
    z: p2.z + Math.sin(a1 - Math.PI / 2) * halfW,
  };

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = C.turnArrow;
  ctx.fillStyle = C.turnArrow;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  groundPolyline(ctx, camera, cam, [p0, p1, p2]);

  const tri = [tip, wingA, wingB].map((p) => camera.project(p, cam));
  if (!tri.some((p) => !p)) {
    closedPath(ctx, tri);
    ctx.fill();
  }
  ctx.restore();
}
