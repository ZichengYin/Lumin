/**
 * 导航播报清单 + 物件落位检查的测试。
 *
 * 这两个都是**游戏、工具、测试三边共用**的规则。要是各算各的，
 * 工具里显示「第 4.5 拍播报」而游戏实际在第 5 拍播 —— 这种偏差肉眼看不出来，
 * 但作者会照着错的信息去调谱面。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildChart } from '../src/core/chart.js';
import { buildWarnings, turnCue, actionBeat, manholeClearance, findCrowdedWarnings } from '../src/core/warnings.js';
import { createCamera } from '../src/render/camera.js';
import { CONFIG } from '../src/config.js';

const BASE = { bpm: 120, timing: 'uniform', beatsPerTile: 1, leadInTurns: 1 };

/**
 * 直行 4 格 → 右转 90° → 直行 4 格。
 * 每格 1 拍，前奏 2 拍，所以第 0 拍是第一格，第 4 拍是转弯。
 */
function straightThenTurn() {
  return buildChart({ ...BASE, angles: [0, 0, 0, 0, 90, 90, 90, 90] });
}

test('转向语音：右边左由谱面实际转角决定，不看 props 里的 dir', () => {
  const chart = straightThenTurn();
  assert.equal(turnCue(chart, 4), 'turn-left', '0° → 90° 是左转（符号和左右是反的，见模块注释）');
  assert.equal(turnCue(chart, 3), null, '0° → 0° 没转，不该有播报');

  const right = buildChart({ ...BASE, angles: [0, 0, 0, 0, -90, -90] });
  assert.equal(turnCue(right, 4), 'turn-right');

  // 故意写一个和实际相反的 dir，语音仍应按实际转角走
  const chart2 = buildChart({
    ...BASE,
    angles: [0, 0, 0, 0, 90, 90],
    props: [{ type: 'turn', tile: 4, dir: 1 }],
  });
  assert.equal(buildWarnings(chart2)[0].cue, 'turn-left', 'dir 只是给作者看的，不能拿它当真相');
});

/**
 * 这条测试的意义：把「左/右」这个标签**钉在画面事实上**，而不是再写一遍约定。
 *
 * 之前就是靠「正角度 = 右」的直觉写反了 —— 单元测试里再写一遍同样的直觉，
 * 只会把错误约定固化下来。所以这里真的建一个镜头，把转弯后要去的那一格
 * 投到屏幕上，看它落在中心左边还是右边。
 */
test('左右转必须和画面对得上（这一条挡的是「语音和画面相反」）', () => {
  const S = CONFIG.world.tileSpacing;
  const W = 1280;
  const cam = createCamera({
    width: W,
    height: 720,
    horizonRatio: CONFIG.camera.horizonRatio,
    charScreenY: CONFIG.camera.charScreenY,
    charRadiusRatio: CONFIG.camera.charRadiusRatio,
    charDistance: CONFIG.camera.charDistance,
  });

  /** 转弯后要去的那一格，落在屏幕中心左边（负）还是右边（正） */
  function sideAfterTurn(chart, tile) {
    const inRad = (chart.angles[tile - 1] * Math.PI) / 180;
    const yaw = Math.PI / 2 - inRad; // 和 main.js 的 chartAngleToYaw 一致
    const here = { x: chart.positions[tile].x * S, z: chart.positions[tile].y * S };
    const camera = {
      x: here.x - Math.sin(yaw) * CONFIG.camera.charDistance,
      z: here.z - Math.cos(yaw) * CONFIG.camera.charDistance,
      yaw,
    };
    const next = chart.positions[tile + 1];
    const p = cam.project({ x: next.x * S, z: next.y * S }, camera);
    assert.ok(p, '转弯后那一格必须能被投影出来');
    return p.x - W / 2;
  }

  // angles[1]=0 → angles[2]=90，转角 +90°
  const plus = buildChart({ ...BASE, angles: [0, 0, 90, 90, 0, 0] });
  const plusSide = sideAfterTurn(plus, 2);
  assert.ok(plusSide < 0, `转角 +90° 时下一格应当落在屏幕左边，实际 ${plusSide.toFixed(1)}px`);
  assert.equal(turnCue(plus, 2), 'turn-left', '落在左边就必须说左转');

  // angles[3]=90 → angles[4]=0，转角 -90°
  const minus = buildChart({ ...BASE, angles: [0, 0, 90, 90, 0, 0] });
  const minusSide = sideAfterTurn(minus, 4);
  assert.ok(minusSide > 0, `转角 -90° 时下一格应当落在屏幕右边，实际 ${minusSide.toFixed(1)}px`);
  assert.equal(turnCue(minus, 4), 'turn-right', '落在右边就必须说右转');
});

test('动作拍：转向看这一格的起点，井盖早一格', () => {
  const chart = straightThenTurn();
  // 转弯发生在 P4 —— 玩家在「第 4 格」上完成转身，
  // 而他是走到 P4 的那一刻开始的，也就是 segments[4].startBeat。
  // （不要硬编码成 4：前奏占了第 0 段 2 拍，所有拍号整体偏移。）
  assert.equal(actionBeat(chart, { type: 'turn', tile: 4 }), chart.segments[4].startBeat);

  // 井盖摆在 P4，但绕行的第一个拐点在 P3 —— 玩家要更早一拍开始转
  const manhole = buildChart({
    ...BASE,
    angles: [0, 0, 0, -90, 0, 90, 0],
    props: [{ type: 'turn', tile: 4, radius: 0.27 }],
  });
  const got = actionBeat(manhole, manhole.props[0]);
  assert.equal(got, manhole.segments[3].startBeat, '井盖的动作拍取的是前一格');
  assert.ok(got < manhole.segments[4].startBeat, '必须比井盖所在那格更早');
});

test('播报清单：按拍号排序，提前量正确', () => {
  // 第 4 格和第 9 格都真的转弯：0→90 是右转，90→0 是左转
  const chart = buildChart({
    ...BASE,
    angles: [0, 0, 0, 0, 90, 90, 90, 90, 90, 0, 0, 0],
    props: [
      { type: 'turn', tile: 4, radius: 0.27 },
      { type: 'turn', tile: 9, dir: -1 },
    ],
  });
  const w = buildWarnings(chart, { leadBeats: 5 });
  assert.equal(w.length, 2, `两个物件都该有播报，实际 ${w.length}`);
  assert.ok(w[0].beat < w[1].beat, '要按拍号从小到大排好 —— 游戏是按顺序消费这张表的');
  for (const x of w) assert.equal(x.actionBeat - x.beat, 5, '播报拍 = 动作拍 − 提前量');
});

test('播报清单：warnBeats 可以单独覆盖某一条的提前量', () => {
  // 两处都真的转弯：P4 是 0→90（右），P6 是 90→0（左）
  const chart = buildChart({
    ...BASE,
    angles: [0, 0, 0, 0, 90, 90, 0, 0],
    props: [
      { type: 'turn', tile: 4, dir: 1 },
      { type: 'turn', tile: 6, dir: -1, warnBeats: 8 },
    ],
  });
  const w = buildWarnings(chart, { leadBeats: 5 });
  assert.equal(w.length, 2);
  const a = w.find((x) => x.index === 0);
  const b = w.find((x) => x.index === 1);
  assert.equal(a.actionBeat - a.beat, 5, '没写 warnBeats 的用全局提前量');
  assert.equal(b.actionBeat - b.beat, 8, '写了 warnBeats 的用自己的');
});

test('播报清单：没有 props 就是空表，不是 undefined', () => {
  assert.deepEqual(buildWarnings(straightThenTurn()), []);
});

test('播报清单：转弯那格如果其实没转，就不生成播报', () => {
  const chart = buildChart({
    ...BASE,
    angles: [0, 0, 0, 0, 0, 0],
    props: [{ type: 'turn', tile: 3, dir: 1 }],
  });
  assert.deepEqual(buildWarnings(chart), [], '没转弯却挂了箭头 —— 不该播报，也不该画箭头');
});

test('井盖落位：紧贴路面的井盖报出负余量', () => {
  // 直路，井盖就放在路中间 —— 必然穿模
  const chart = buildChart({
    ...BASE,
    angles: [0, 0, 0, 0, 0, 0],
    props: [{ type: 'turn', tile: 2, along: 0.5, lateral: 0, radius: 0.27 }],
  });
  const r = manholeClearance(chart, { tileSpacing: 6, pathWidth: 1.5 });
  assert.equal(r.length, 1);
  assert.ok(r[0].clearance < 0, `压在路上了，余量应当为负，实际 ${r[0].clearance}`);
});

test('井盖落位：正常绕行的井盖余量为正', () => {
  const chart = buildChart({
    ...BASE,
    angles: [0, 0, 0, -90, 0, 90, 0],
    props: [{ type: 'turn', tile: 4, along: 0.5, lateral: 0.5, radius: 0.27 }],
  });
  const r = manholeClearance(chart, { tileSpacing: 6, pathWidth: 1.5 });
  assert.ok(r[0].clearance > 0, `应当有余量，实际 ${r[0].clearance}`);
  // 让出的方口是 1 格，半边 0.5，减去半个路宽 0.125，再减井盖半径
  assert.ok(Math.abs(r[0].clearance - (0.5 - 0.125 - 0.27)) < 1e-9);
});

test('播报拥挤：挨得太近的会被指出来（后一条会打断前一条）', () => {
  const w = [
    { beat: 0, reason: 'A' },
    { beat: 1, reason: 'B' }, // 1 拍 = 0.5 秒，太近
    { beat: 10, reason: 'C' },
  ];
  const c = findCrowdedWarnings(w, 0.5, 1.4);
  assert.equal(c.length, 1);
  assert.equal(c[0].a.reason, 'A');
  assert.equal(c[0].b.reason, 'B');
  assert.ok(Math.abs(c[0].gapSec - 0.5) < 1e-9);
});

test('播报拥挤：间隔够宽就没问题', () => {
  const w = [
    { beat: 0, reason: 'A' },
    { beat: 4, reason: 'B' },
  ];
  assert.deepEqual(findCrowdedWarnings(w, 0.5, 1.4), []);
});
