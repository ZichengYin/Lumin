/**
 * 谱面几何的单元测试。
 *
 * 多砖块最容易错、而且错了最难查的地方有两个：
 *
 *   1. **跨砖块的位置连续性。** 行星从绕 P₀ 换成绕 P₁ 的那一瞬间，位置必须
 *      严丝合缝地接上。差一点点，画面就会看到行星"跳"一下。
 *   2. **落点时刻。** 第 i 次击打必须发生在累计拍数算出来的那个拍位上，
 *      否则整首歌都会系统性偏移。
 *
 * 这两条下面的测试都钉死了。另外还用暴力搜索检查了「转过多少度之后正好到达
 * 目标方向」，不依赖我自己推的公式。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChart,
  sweepOf,
  wrap360,
  isUturn,
  segmentAtBeat,
  segmentAngleAtBeat,
  planetStateAtBeat,
  hitBeatOf,
  hitPoint,
  verifyChart,
  DEG_PER_BEAT,
} from '../src/core/chart.js';
import { TAU, toRad, toDeg } from '../src/core/geometry.js';

const ORBIT_R_UNITS = 0.5;

/** 行星在「绕某一段的砖块」时的世界坐标（单位坐标，相邻砖块间距 = 1） */
function planetWorldForSegment(chart, seg, beat) {
  const angle = segmentAngleAtBeat(chart, seg, beat);
  const tile = chart.positions[seg.tileIndex];
  return {
    x: tile.x + ORBIT_R_UNITS * Math.cos(angle),
    y: tile.y + ORBIT_R_UNITS * Math.sin(angle),
  };
}

const basic = (over = {}) => ({
  bpm: 120,
  timing: 'uniform',
  beatsPerTile: 1,
  leadInTurns: 1,
  angles: [0, -90, 0, 90, 0, -90, 0, 90],
  ...over,
});

// ── 基础工具 ────────────────────────────────────────────────

test('wrap360 规整到 [0, 360)', () => {
  assert.equal(wrap360(0), 0);
  assert.equal(wrap360(90), 90);
  assert.equal(wrap360(-90), 270);
  assert.equal(wrap360(360), 0);
  assert.equal(wrap360(-360), 0);
  assert.equal(wrap360(-450), 270);
  assert.ok(Math.abs(wrap360(45.5) - 45.5) < 1e-12);
});

test('sweepOf：直线 180°，转向越急转过越少', () => {
  // 直线前进：来向和去向相同
  assert.equal(sweepOf(0, 0), 180);
  assert.equal(sweepOf(123, 123), 180);

  // 极角递增方向：+90° 的转向 → 转过 270°（慢）；-90° → 转过 90°（快）
  assert.equal(sweepOf(0, 90, 1), 270);
  assert.equal(sweepOf(0, -90, 1), 90);

  // 方向反过来，快慢也对调
  assert.equal(sweepOf(0, 90, -1), 90);
  assert.equal(sweepOf(0, -90, -1), 270);
});

test('isUturn：只有方向差正好 180° 才算掉头', () => {
  assert.equal(isUturn(0, 180), true);
  assert.equal(isUturn(180, 0), true);
  assert.equal(isUturn(45, 225), true);
  assert.equal(isUturn(0, 0), false);
  assert.equal(isUturn(0, 179.9), false);
  assert.equal(isUturn(0, 90), false);
});

test('sweepOf 的结果永远是 (0, 360)，掉头才是 0', () => {
  for (let prev = 0; prev < 360; prev += 15) {
    for (let next = 0; next < 360; next += 15) {
      const s = sweepOf(prev, next);
      assert.ok(s >= 0 && s < 360, `sweepOf(${prev}, ${next}) = ${s}`);
      if (s === 0) assert.equal(isUturn(prev, next), true);
    }
  }
});

test('★ sweepOf 的暴力验证：从起点转过 sweep 度，正好落在去向方向', () => {
  for (let direction of [1, -1]) {
    for (let prev = 0; prev < 360; prev += 30) {
      for (let next = 0; next < 360; next += 30) {
        if (isUturn(prev, next)) continue;
        const sweep = sweepOf(prev, next, direction);
        const start = prev + 180; // 从砖块看去，上一段的完美点在这个方向
        const end = start + direction * sweep;
        const diff = ((end - next + 540) % 360) - 180;
        assert.ok(
          Math.abs(diff) < 1e-9,
          `方向 ${direction}：${prev}° → ${next}°，从 ${start}° 转 ${sweep}° 到了 ${end}°，` +
            `但目标方向是 ${next}°`,
        );
      }
    }
  }
});

// ── 构建与校验 ──────────────────────────────────────────────

test('buildChart：拒绝空谱面、非法 BPM、原地掉头', () => {
  assert.throws(() => buildChart(basic({ angles: [] })), /至少要有 1 个方向角/);
  assert.throws(() => buildChart(basic({ bpm: 0 })), /bpm 非法/);
  assert.throws(() => buildChart(basic({ bpm: NaN })), /bpm 非法/);
  assert.throws(() => buildChart(basic({ angles: ['x', 0] })), /不是数字/);

  // 掉头必须被拒绝，而且要给出人话解释
  assert.throws(() => buildChart(basic({ angles: [0, 180, 0] })), /原地掉头/);
  assert.throws(() => buildChart(basic({ angles: [0, 0, 180] })), /原地掉头/);

  // 0° 转向（直线）是合法的
  assert.doesNotThrow(() => buildChart(basic({ angles: [0, 0, 0] })));
});

test('buildChart：自检对正常谱面全部通过', () => {
  for (const timing of ['uniform', 'auto']) {
    const chart = buildChart(basic({ timing }));
    assert.deepEqual(verifyChart(chart), [], `${timing} 模式自检不通过`);
  }

  // 各种角度组合都不该出问题
  const weird = [0, 37, -120, 200, 200, -45, 45, 179, -179, 0];
  assert.deepEqual(verifyChart(buildChart(basic({ angles: weird }))), []);
  assert.deepEqual(verifyChart(buildChart(basic({ angles: weird, timing: 'auto' }))), []);
});

test('buildChart：砖块等距，间距恒为 1', () => {
  const chart = buildChart(basic({ angles: [0, 45, -30, 170, -95, 12] }));
  for (let i = 0; i < chart.positions.length - 1; i++) {
    const a = chart.positions[i];
    const b = chart.positions[i + 1];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    assert.ok(Math.abs(d - 1) < 1e-12, `第 ${i} 段长度是 ${d}，应为 1`);
  }
  assert.equal(chart.tileCount, chart.angles.length + 1);
  assert.equal(chart.hitCount, chart.angles.length);
});

test('buildChart：uniform 模式下每块砖固定拍数，落点整齐', () => {
  const chart = buildChart(basic({ angles: [0, -90, 0, 90, 0] }));

  // 第 0 段是前奏，拍数由 leadInTurns 决定，不参与"每块砖几拍"
  chart.segments.slice(1).forEach((seg, k) => {
    assert.equal(seg.beats, 1, `第 ${k + 1} 段拍数应为 1`);
  });
  chart.segments.forEach((seg, i) => {
    assert.ok(Math.abs(seg.hitBeat - i) < 1e-12, `第 ${i} 次击打应在第 ${i} 拍`);
  });
  assert.equal(chart.durationBeats, 4);
});

test('buildChart：uniform 的 beatsPerTile 生效，逐块覆盖也生效', () => {
  const chart = buildChart(
    basic({ angles: [0, -90, 0, 90], beatsPerTile: 2, beats: [null, 0.5] }),
  );
  assert.equal(chart.segments[0].beats, 2); // 第 0 段是前奏，恒为 2（leadInTurns=1）
  assert.equal(chart.segments[1].beats, 0.5); // 覆盖
  assert.equal(chart.segments[2].beats, 2); // 默认
  assert.equal(chart.segments[3].beats, 2);

  assert.ok(Math.abs(chart.segments[1].hitBeat - 0.5) < 1e-12);
  assert.ok(Math.abs(chart.segments[2].hitBeat - 2.5) < 1e-12);
});

test('★ buildChart：auto 模式下角速度恒定（ADOFAI 的手感）', () => {
  const chart = buildChart(
    basic({ timing: 'auto', angles: [0, -90, 0, 90, 0, -45, 45, 180] }),
  );

  const turnsPerBeat = chart.segments.slice(1).map((s) => s.sweep / s.beats);
  for (const t of turnsPerBeat) {
    assert.ok(
      Math.abs(t - DEG_PER_BEAT) < 1e-9,
      `每拍转过 ${t}°，应为 ${DEG_PER_BEAT}°`,
    );
  }

  // 于是换算出的「一圈多少毫秒」对所有砖块都一样，判定窗口在毫秒上也是恒定的
  const msPerTurns = chart.segments.slice(1).map((s) => s.msPerTurn);
  for (const m of msPerTurns) {
    assert.ok(Math.abs(m - 2 * chart.beatMs) < 1e-9, `一圈 ${m} ms，应恒为 2 拍`);
  }
});

test('buildChart：auto 模式下直线 1 拍，急转弯 0.5 拍', () => {
  const chart = buildChart(basic({ timing: 'auto', angles: [0, 0, -90] }));
  assert.ok(Math.abs(chart.segments[1].beats - 1) < 1e-12, '直线应为 1 拍');
  assert.ok(Math.abs(chart.segments[2].beats - 0.5) < 1e-12, '-90° 转向应为 0.5 拍');
});

test('buildChart：前奏是绕第一块砖转 leadInTurns 整圈', () => {
  const chart = buildChart(basic({ leadInTurns: 2 }));
  const first = chart.segments[0];
  assert.equal(first.sweep, 720);
  assert.equal(first.beats, 4); // 720 / 180
  assert.equal(first.startBeat, -4);
  assert.equal(first.hitBeat, 0);
  assert.equal(first.tileIndex, 0);
});

// ── ★ 位置连续性 ────────────────────────────────────────────

test('★ 跨砖块的位置连续性：切换瞬间行星不跳', () => {
  // 注意别放 180° 掉头，否则 buildChart 会（正确地）拒绝
  const chart = buildChart(basic({ angles: [0, -90, 0, 90, 0, -90, -45, 120, 20] }));

  for (let i = 0; i < chart.hitCount - 1; i++) {
    const here = chart.segments[i];
    const next = chart.segments[i + 1];
    const atHandoff = here.endBeat; // == next.startBeat

    const fromHere = planetWorldForSegment(chart, here, atHandoff);
    const fromNext = planetWorldForSegment(chart, next, atHandoff);

    const gap = Math.hypot(fromHere.x - fromNext.x, fromHere.y - fromNext.y);
    assert.ok(
      gap < 1e-12,
      `第 ${i} → ${i + 1} 块交接处跳了 ${gap}：` +
        `从上一段看是 (${fromHere.x.toFixed(6)}, ${fromHere.y.toFixed(6)})，` +
        `从下一段看是 (${fromNext.x.toFixed(6)}, ${fromNext.y.toFixed(6)})`,
    );

    // 而且交接点必须正好是两块砖的中点
    const mid = hitPoint(chart, i);
    assert.ok(Math.abs(mid.x - fromHere.x) < 1e-12);
    assert.ok(Math.abs(mid.y - fromHere.y) < 1e-12);
  }
});

test('★ 交接点离两块砖都正好半个单位（＝轨道半径）', () => {
  const chart = buildChart(basic({ angles: [0, -90, 0, 90, 30, -140, 75] }));
  for (let i = 0; i < chart.hitCount; i++) {
    const mid = hitPoint(chart, i);
    for (const j of [i, i + 1]) {
      const d = Math.hypot(mid.x - chart.positions[j].x, mid.y - chart.positions[j].y);
      assert.ok(Math.abs(d - ORBIT_R_UNITS) < 1e-12, `击打点离第 ${j} 块砖 ${d}，应为 0.5`);
    }
  }
});

test('★ 行星全程连续：沿整条谱面逐帧采样，位置不能有跳变', () => {
  const chart = buildChart(basic({ angles: [0, -90, 0, 90, -45, 130, 0, 0, 90] }));

  const worldAt = (beat) => {
    const seg = segmentAtBeat(chart, beat);
    return planetWorldForSegment(chart, seg, beat);
  };

  const start = chart.segments[0].startBeat;
  const end = chart.durationBeats;
  const steps = 4000;
  let prev = worldAt(start);
  let maxJump = 0;

  for (let k = 1; k <= steps; k++) {
    const beat = start + ((end - start) * k) / steps;
    const cur = worldAt(beat);
    const jump = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    if (jump > maxJump) maxJump = jump;
    prev = cur;
  }

  // 每一步的位移应该接近步长（半个单位的弧长 / 步数），不该出现突跳
  const totalArcRough = (Math.abs(end - start) * Math.PI) / 2; // 上界估计
  const expectedStep = totalArcRough / steps;
  assert.ok(
    maxJump < expectedStep * 3,
    `最大单步位移 ${maxJump.toFixed(6)}，预期量级 ${expectedStep.toFixed(6)} —— 可能有跳变`,
  );
});

// ── 查询 ────────────────────────────────────────────────────

test('segmentAtBeat：区间内、边界、越界都正确', () => {
  const chart = buildChart(basic({ angles: [0, -90, 0, 90] })); // 前奏 [-2,0]，之后每拍一段
  const segs = chart.segments;

  assert.equal(segmentAtBeat(chart, -5).index, 0, '前奏之前 → 第 0 段');
  assert.equal(segmentAtBeat(chart, -2).index, 0);
  assert.equal(segmentAtBeat(chart, -0.5).index, 0);
  assert.equal(segmentAtBeat(chart, 0).index, 1, '第 0 拍交接 → 第 1 段');
  assert.equal(segmentAtBeat(chart, 0.5).index, 1);
  assert.equal(segmentAtBeat(chart, 1).index, 2);
  assert.equal(segmentAtBeat(chart, 2.999).index, 3);
  assert.equal(segmentAtBeat(chart, 3).index, 3);
  assert.equal(segmentAtBeat(chart, 99).index, 3, '曲终之后停在最后一段');

  // 和暴力查找对齐
  for (let beat = -3; beat <= 5; beat += 0.13) {
    let expected = 0;
    for (let i = segs.length - 1; i >= 0; i--) {
      if (beat >= segs[i].startBeat) {
        expected = i;
        break;
      }
    }
    assert.equal(segmentAtBeat(chart, beat).index, expected, `beat=${beat}`);
  }
});

test('hitBeatOf：累计拍位正确', () => {
  const chart = buildChart(basic({ angles: [0, -90, 0, 90] }));
  assert.equal(hitBeatOf(chart, 0), 0);
  assert.equal(hitBeatOf(chart, 1), 1);
  assert.equal(hitBeatOf(chart, 2), 2);
  assert.equal(hitBeatOf(chart, 3), 3);
  assert.throws(() => hitBeatOf(chart, 4), /没有第 4 次击打/);
});

test('★ 每一段转到自己的击打拍位时，极角正好等于目标方向', () => {
  for (const timing of ['uniform', 'auto']) {
    const chart = buildChart(basic({ timing, angles: [0, -90, 0, 90, -45, 130] }));
    for (const seg of chart.segments) {
      const angle = segmentAngleAtBeat(chart, seg, seg.hitBeat);
      const diff = ((toDeg(angle) - seg.targetAngleDeg + 540) % 360) - 180;
      assert.ok(Math.abs(diff) < 1e-9, `${timing} 第 ${seg.index} 段：偏了 ${diff}°`);
    }
  }
});

test('★ planetStateAtBeat：在击打拍位上，行星世界坐标正好落在该次的完美点', () => {
  for (const timing of ['uniform', 'auto']) {
    const chart = buildChart(basic({ timing, angles: [0, -90, 0, 90, -45, 130] }));
    for (let i = 0; i < chart.hitCount; i++) {
      const beat = hitBeatOf(chart, i);
      const ps = planetStateAtBeat(chart, beat);
      const world = {
        x: ps.tile.x + ORBIT_R_UNITS * Math.cos(ps.planetAngle),
        y: ps.tile.y + ORBIT_R_UNITS * Math.sin(ps.planetAngle),
      };
      const mid = hitPoint(chart, i);
      const gap = Math.hypot(world.x - mid.x, world.y - mid.y);
      assert.ok(gap < 1e-12, `${timing} 第 ${i} 块：行星离完美点 ${gap}`);
    }
  }
});

test('交接瞬间的归属：正好在击打拍位上时，已经算作在绕下一块砖了', () => {
  const chart = buildChart(basic({ angles: [0, -90, 0, 90] }));
  // 第 0 拍是第 0 次击打，同时也是第 1 段的起点 —— 行星到达中点的同一瞬间就交接
  assert.equal(segmentAtBeat(chart, 0).index, 1);
  assert.equal(segmentAtBeat(chart, -1e-9).index, 0);
  assert.equal(segmentAtBeat(chart, 1).index, 2);
  assert.equal(segmentAtBeat(chart, 1 - 1e-9).index, 1);
});

test('planetStateAtBeat：极角从起点单调推进到终点', () => {
  const chart = buildChart(basic({ angles: [0, -90, 0, 90] }));
  for (const seg of chart.segments) {
    const steps = 50;
    let prev = segmentAngleAtBeat(chart, seg, seg.startBeat);
    for (let k = 1; k <= steps; k++) {
      const beat = seg.startBeat + (seg.beats * k) / steps;
      const cur = segmentAngleAtBeat(chart, seg, beat);
      const delta = cur - prev;
      assert.ok(
        Math.sign(delta) === Math.sign(seg.omega) || Math.abs(delta) < 1e-12,
        `第 ${seg.index} 段走到一半方向反了`,
      );
      prev = cur;
    }
    // 总转动量必须等于 sweep
    const total = Math.abs(toDeg(segmentAngleAtBeat(chart, seg, seg.endBeat) - segmentAngleAtBeat(chart, seg, seg.startBeat)));
    assert.ok(Math.abs(total - seg.sweep) < 1e-9, `第 ${seg.index} 段一共转了 ${total}°，应为 ${seg.sweep}°`);
  }
});

test('planetStateAtBeat：进度被夹在 [0, 1]，越界不会算出离谱的值', () => {
  const chart = buildChart(basic({ angles: [0, -90, 0, 90] }));
  const before = planetStateAtBeat(chart, chart.segments[0].startBeat - 100);
  assert.equal(before.progress, 0);
  assert.ok(Number.isFinite(before.planetAngle));

  const after = planetStateAtBeat(chart, chart.durationBeats + 100);
  assert.equal(after.progress, 1);
  assert.ok(Number.isFinite(after.planetAngle));
});

test('msPerTurn 与 omega 自洽', () => {
  const chart = buildChart(basic({ timing: 'auto', angles: [0, -90, 0, 90] }));
  for (const seg of chart.segments) {
    const fromOmega = TAU / Math.abs(seg.omega);
    assert.ok(Math.abs(fromOmega - seg.msPerTurn) < 1e-9, `第 ${seg.index} 段 msPerTurn 和 omega 对不上`);
  }
});

test('windowBeats：换算出的毫秒和角度差对得上', () => {
  const chart = buildChart(basic({ angles: [0, -90, 0, 90] }));
  for (const seg of chart.segments) {
    const ms = seg.windowBeats(22.5) * chart.beatMs;
    const expected = (22.5 / 360) * seg.msPerTurn;
    assert.ok(Math.abs(ms - expected) < 1e-9, `第 ${seg.index} 段窗口换算不一致`);
  }
});

test('单块砖的谱面也能用（角度数组长度 1）', () => {
  const chart = buildChart(basic({ angles: [0] }));
  assert.equal(chart.hitCount, 1);
  assert.equal(chart.tileCount, 2);
  assert.deepEqual(verifyChart(chart), []);
  assert.equal(hitBeatOf(chart, 0), 0);
});
