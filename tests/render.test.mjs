/**
 * 镜头投影与世界层绘制的测试。
 *
 * 投影这块的价值在于**它有精确解**：地平线在哪、盲人落在屏幕哪个位置、
 * 脚下的圈该有多宽，全都能算出来，所以可以直接断言数值，而不是「看起来差不多」。
 *
 * 世界层绘制则沿用假 Canvas 上下文的老办法：所有东西跑一遍，
 * 保证不抛异常、不产生 NaN 坐标。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCamera, shortestAngle } from '../src/render/camera.js';
import * as world from '../src/render/world.js';
import { CONFIG } from '../src/config.js';
import { buildChart } from '../src/core/chart.js';

const W = 1280;
const H = 720;
const OPTS = {
  width: W,
  height: H,
  horizonRatio: 0.44,
  charScreenY: 0.66,
  charRadiusRatio: 0.028,
  charDistance: 13,
};

/** 镜头在原点，看向 +z */
const CAM = { x: 0, z: 0, yaw: 0 };

function makeCtx() {
  const calls = [];
  const gradient = { addColorStop() {} };
  const store = {};
  return new Proxy(store, {
    get(target, prop) {
      if (prop === '__calls') return calls;
      if (prop in target) return target[prop];
      return (...args) => {
        calls.push({ method: prop, args });
        if (prop === 'createRadialGradient' || prop === 'createLinearGradient') return gradient;
        if (prop === 'measureText') return { width: 42 };
        return undefined;
      };
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

function badNumbers(ctx) {
  const bad = [];
  for (const { method, args } of ctx.__calls) {
    for (const [i, a] of args.entries()) {
      if (typeof a === 'number' && !Number.isFinite(a)) bad.push(`${method}(...) 第 ${i} 个参数 = ${a}`);
    }
  }
  return bad;
}

// ── 投影的解析性质 ──────────────────────────────────────────

test('镜头：解出来的参数和你要的三个比例一致', () => {
  const cam = createCamera(OPTS);

  // 盲人在 depth = charDistance 处，屏幕半径应当正好是 charRadiusRatio * 视口高
  assert.ok(Math.abs(cam.scaleAt(cam.charDistance) - 0.028 * H) < 1e-9);

  // 盲人脚下的点应当落在 charScreenY 那条线上
  const feet = cam.project({ x: 0, z: cam.charDistance }, CAM);
  assert.ok(Math.abs(feet.y - 0.66 * H) < 1e-9, `实际 ${feet.y}，应为 ${0.66 * H}`);
  assert.ok(Math.abs(feet.x - W / 2) < 1e-9, '正前方的点必须在水平正中');

  // 极远处应当收敛到地平线
  const far = cam.project({ x: 0, z: 1e7 }, CAM);
  assert.ok(Math.abs(far.y - cam.horizonY) < 1e-3, `实际 ${far.y}，地平线 ${cam.horizonY}`);
  assert.ok(Math.abs(cam.horizonY - 0.44 * H) < 1e-9);
});

test('镜头：越近越靠下、越大；越远越靠上、越小', () => {
  const cam = createCamera(OPTS);
  let prevY = Infinity;
  let prevScale = Infinity;
  for (const z of [5, 8, 13, 20, 40, 90]) {
    const p = cam.project({ x: 0, z }, CAM);
    assert.ok(p.y < prevY, `z=${z} 应当比更近的点靠上`);
    assert.ok(p.scale < prevScale, `z=${z} 应当比更近的点小`);
    prevY = p.y;
    prevScale = p.scale;
  }
});

test('镜头：横向偏移按 1/z 收缩', () => {
  const cam = createCamera(OPTS);
  const a = cam.project({ x: 5, z: 10 }, CAM);
  const b = cam.project({ x: 5, z: 20 }, CAM);
  const offA = a.x - W / 2;
  const offB = b.x - W / 2;
  assert.ok(Math.abs(offA / offB - 2) < 1e-9, '距离翻倍，横向偏移应当减半');
});

test('镜头：镜头后面和贴脸的点直接丢掉，不返回 NaN', () => {
  const cam = createCamera(OPTS);
  for (const z of [-1, -100, 0, 0.1]) {
    assert.equal(cam.project({ x: 0, z }, CAM), null, `z=${z} 应当被丢掉`);
  }
  assert.ok(cam.project({ x: 0, z: 1 }, CAM) !== null);
});

test('镜头：yaw 转向之后，前方的点依然在正中', () => {
  const cam = createCamera(OPTS);
  for (const yawDeg of [0, 37, 90, -120, 179]) {
    const yaw = (yawDeg * Math.PI) / 180;
    const here = { x: 3, z: -7, yaw };
    const ahead = {
      x: here.x + Math.sin(yaw) * 13,
      z: here.z + Math.cos(yaw) * 13,
    };
    const p = cam.project(ahead, here);
    assert.ok(Math.abs(p.x - W / 2) < 1e-6, `yaw=${yawDeg}° 时前方点偏了 ${p.x - W / 2}px`);
    assert.ok(Math.abs(p.y - 0.66 * H) < 1e-6);
  }
});

test('镜头：charDistance 只改透视强度，不改盲人的屏幕大小', () => {
  // 它的单位是「盲人半径」，所以它同时就是世界尺度。改它等于换视场角：
  // 越小越广角（近处的东西摊得越开），越大越像长焦（画面越平）。
  for (const d of [6, 13, 40, 200]) {
    const cam = createCamera({ ...OPTS, charDistance: d });
    const feet = cam.project({ x: 0, z: d }, CAM);
    assert.ok(Math.abs(feet.y - 0.66 * H) < 1e-9, `charDistance=${d} 时盲人不在 charScreenY 上`);
    assert.ok(
      Math.abs(cam.scaleAt(d) - 0.028 * H) < 1e-9,
      '盲人的屏幕大小必须与 charDistance 无关',
    );
  }

  const wide = createCamera({ ...OPTS, charDistance: 6 });
  const tele = createCamera({ ...OPTS, charDistance: 60 });
  assert.ok(wide.focal < tele.focal);

  // 同样的「相对位置」投到同样的屏幕位置
  const nearOff = wide.project({ x: 3, z: 6 }, CAM).x - W / 2;
  const farOff = tele.project({ x: 3, z: 60 }, CAM).x - W / 2;
  assert.ok(Math.abs(nearOff - farOff) < 1e-9);

  // 但再往前同样的比例，广角那份收缩得更狠 —— 这就是"透视强度"
  const wideRatio = wide.scaleAt(9) / wide.scaleAt(6);
  const teleRatio = tele.scaleAt(63) / tele.scaleAt(60);
  assert.ok(wideRatio < teleRatio, `广角 ${wideRatio} 应当比长焦 ${teleRatio} 收缩更快`);
});

test('地面圆：投影后是椭圆，宽高比符合解析解', () => {
  const cam = createCamera(OPTS);
  const d = cam.charDistance;
  const r = 3;
  const pts = cam.projectGroundCircle({ x: 0, z: d }, r, CAM, 360);
  assert.equal(pts.length, 360);

  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const halfW = (Math.max(...xs) - Math.min(...xs)) / 2;
  const halfH = (Math.max(...ys) - Math.min(...ys)) / 2;

  // 横向最宽处：对 r·sinθ/(d + r·cosθ) 求极值，得 cosθ = -r/d。
  // 采样点不一定正好落在这个角度上，所以留一点容差（360 边形，误差 ~1e-3 px）。
  const theta = Math.acos(-r / d);
  const expected = (cam.focal * (r * Math.sin(theta))) / (d + r * Math.cos(theta));
  assert.ok(Math.abs(halfW - expected) < 0.01, `半宽 ${halfW}，解析解 ${expected}`);

  // 纵向是近端与远端的投影之差
  const near = cam.project({ x: 0, z: d - r }, CAM);
  const far = cam.project({ x: 0, z: d + r }, CAM);
  assert.ok(Math.abs(halfH - (near.y - far.y) / 2) < 1e-6, `半高 ${halfH}`);

  // 这个配置下纵向被压扁——这正是"地面圆在透视下是椭圆"的体现
  assert.ok(halfH < halfW, `半高 ${halfH} 应当小于半宽 ${halfW}`);
  assert.ok(halfH / halfW > 0.5, '但也不该压得太扁，否则读不出是个圆');
});

test('地面圆：一部分跑到镜头后面时整体丢掉，而不是画出一半', () => {
  const cam = createCamera(OPTS);
  const pts = cam.projectGroundCircle({ x: 0, z: 1 }, 5, CAM);
  assert.equal(pts, null, '圆跨过镜头时必须整块丢掉');
});

test('精灵矩阵：物体的「前」映射到屏幕上方，「右」映射到屏幕右方', () => {
  const cam = createCamera(OPTS);
  const m = cam.groundFrame({ x: 0, z: 13 }, 0, CAM);
  assert.ok(m, '正前方的地盘必须有解');

  // 图片坐标 (ix, iy)：iy 向下。物体的「前」是图片的上方 → iy 取负。
  // 沿图片 +y 走一步，屏幕上应当往下（dy > 0，因为那是物体的"后方"）
  assert.ok(m.d > 0, `图片 +y 应当映射到屏幕下方，实际 d=${m.d}`);
  // 沿图片 +x 走一步，屏幕上应当往右
  assert.ok(m.a > 0, `图片 +x 应当映射到屏幕右方，实际 a=${m.a}`);
  // 而且横向尺度应当接近该深度的缩放
  assert.ok(Math.abs(m.a - cam.scaleAt(13)) < 1e-6);
  // 纵向被透视压扁
  assert.ok(m.d < m.a, `纵向 ${m.d} 应当小于横向 ${m.a}`);
});

test('shortestAngle：永远走最短的那一边', () => {
  const D = Math.PI / 180;
  assert.ok(Math.abs(shortestAngle(0, 90 * D) - 90 * D) < 1e-12);
  assert.ok(Math.abs(shortestAngle(0, 270 * D) + 90 * D) < 1e-12);
  assert.ok(Math.abs(shortestAngle(350 * D, 10 * D) - 20 * D) < 1e-12);
  assert.ok(Math.abs(shortestAngle(10 * D, 350 * D) + 20 * D) < 1e-12);
  assert.equal(shortestAngle(1, 1), 0);
});

// ── 世界层绘制 ──────────────────────────────────────────────

const TEST_CHART = buildChart({
  bpm: 120,
  timing: 'uniform',
  beatsPerTile: 1,
  angles: [0, 0, -30, 0, 30, 0, 0, -45, 0, 45, 0, 0, 0, 0, 0, 0],
});

function makeTrack() {
  return world.buildWorldTrack(TEST_CHART, CONFIG.world.tileSpacing);
}

test('世界：buildWorldTrack 的间距等于 tileSpacing', () => {
  const track = makeTrack();
  assert.equal(track.points.length, TEST_CHART.positions.length);
  assert.equal(track.hits.length, TEST_CHART.hitCount);
  for (let i = 0; i < track.points.length - 1; i++) {
    const d = Math.hypot(
      track.points[i + 1].x - track.points[i].x,
      track.points[i + 1].z - track.points[i].z,
    );
    assert.ok(Math.abs(d - CONFIG.world.tileSpacing) < 1e-9, `第 ${i} 段长 ${d}`);
  }
  // 落点应当正好在两块砖中间
  const h = track.hits[3];
  assert.ok(Math.abs(h.x - (track.points[3].x + track.points[4].x) / 2) < 1e-12);
});

test('世界：整条路跑一遍所有绘制，不抛异常、不产生 NaN', () => {
  const cam = createCamera(OPTS);
  const track = makeTrack();
  const spacing = CONFIG.world.tileSpacing;
  const ctx = makeCtx();

  for (let i = 0; i < TEST_CHART.hitCount; i++) {
    const pos = track.points[i];
    const yaw = Math.PI / 2 - (TEST_CHART.angles[i] * Math.PI) / 180;
    const c = { x: pos.x - Math.sin(yaw) * cam.charDistance, z: pos.z - Math.cos(yaw) * cam.charDistance, yaw };
    const range = { from: Math.max(0, i - 4), to: i + 12, width: CONFIG.world.pathWidth };

    assert.doesNotThrow(() => {
      world.blindPath(ctx, cam, c, track, range);
      world.blindPathGrid(ctx, cam, c, track, { ...range, cell: CONFIG.world.pathCell });
      world.hitMarks(ctx, cam, c, track, range);
      world.sweepRing(ctx, cam, c, pos, spacing / 2);
      world.footprint(ctx, cam, c, pos, CONFIG.world.charRadius);
      world.cane(ctx, cam, c, pos, 0.7, spacing / 2);
      world.manhole(ctx, cam, c, { x: pos.x + 6, z: pos.z }, 2);
    }, `第 ${i} 格抛异常了`);

    ctx.__calls.length = 0;
  }
});

test('世界：镜头正好站在某一格上时，那一格附近不该画出离谱的数字', () => {
  const cam = createCamera(OPTS);
  const track = makeTrack();
  const ctx = makeCtx();

  // 镜头贴着第 5 格（前方 0.5 个世界单位处就是镜头）
  const c = { x: track.points[5].x, z: track.points[5].z, yaw: 0 };
  world.blindPath(ctx, cam, c, track, { from: 0, to: 10, width: CONFIG.world.pathWidth });
  world.hitMarks(ctx, cam, c, track, { from: 0, to: 10, width: CONFIG.world.pathWidth });
  assert.deepEqual(badNumbers(ctx), []);
});

test('世界：没有素材 / 素材没加载完时，character 安静地什么都不做', () => {
  const cam = createCamera(OPTS);
  for (const img of [null, undefined, { complete: false, naturalWidth: 0 }]) {
    const ctx = makeCtx();
    assert.doesNotThrow(() =>
      world.character(ctx, cam, CAM, { x: 0, z: 13 }, 0, img, 2.6),
    );
    assert.equal(ctx.__calls.length, 0, '不该产生任何绘制调用');
  }
});

test('世界：反转亮度时确实设了 filter，而且用完会还原', () => {
  const cam = createCamera(OPTS);
  const ctx = makeCtx();
  const img = { complete: true, naturalWidth: 658, naturalHeight: 723 };
  world.character(ctx, cam, CAM, { x: 0, z: 13 }, 0, img, 2.6, { invert: true });
  assert.ok(ctx.__calls.some((c) => c.method === 'drawImage'), '应该画了素材');
  assert.equal(ctx.filter, 'invert(1)');
  assert.ok(ctx.__calls.some((c) => c.method === 'restore'), '必须 restore，否则 filter 会漏给后面的绘制');
});
