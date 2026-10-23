/**
 * 2D 界面层的冒烟测试。
 *
 * 世界层（地面、盲道、盲人）的测试在 render.test.mjs 里；这里只管
 * `render/draw.js` 那几样不随透视变化的东西：HUD、判定大字、提示层、结算。
 *
 * 老规矩：全跑一遍，保证不抛异常、不产生 NaN 坐标。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as draw from '../src/render/draw.js';
import { CONFIG, msPerBeat, angleDegToMs } from '../src/config.js';

/** 假的 Canvas 2D 上下文：记录所有调用，返回安全的占位对象 */
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

function findBadNumbers(ctx) {
  const bad = [];
  for (const { method, args } of ctx.__calls) {
    for (const [i, a] of args.entries()) {
      if (typeof a === 'number' && !Number.isFinite(a)) bad.push(`${method}(...) 第 ${i} 个参数 = ${a}`);
    }
  }
  return bad;
}

function emptyStats() {
  return {
    PERFECT: 0,
    GOOD: 0,
    OK: 0,
    MISS: 0,
    ghost: 0,
    sumAbs: 0,
    sumAbsMs: 0,
    weighted: 0,
    count: 0,
    maxCombo: 0,
  };
}

function makeHud(over = {}) {
  return {
    bpm: 120,
    msPerBeat: msPerBeat(120),
    windowsMs: {
      perfect: angleDegToMs(CONFIG.windows.perfect, 1000),
      good: angleDegToMs(CONFIG.windows.good, 1000),
      ok: angleDegToMs(CONFIG.windows.ok, 1000),
    },
    tileIndex: 7,
    hitCount: 32,
    combo: 6,
    offsetMs: 18.4,
    autoLatencyMs: 12.4,
    userOffsetMs: 6,
    songTime: 4.2,
    duration: 32,
    beat: 8.4,
    stats: {
      ...emptyStats(),
      PERFECT: 12,
      GOOD: 3,
      OK: 1,
      sumAbs: 88.4,
      sumAbsMs: 122.8,
      weighted: 14.25,
      count: 16,
      maxCombo: 9,
    },
    history: [
      { grade: 'PERFECT', angleDiffDeg: 4.2 },
      { grade: 'GOOD', angleDiffDeg: -31.5 },
      { grade: 'MISS', angleDiffDeg: null, auto: true },
      { grade: 'PERFECT', angleDiffDeg: -2.0 },
    ],
    ...over,
  };
}

test('界面：画满一屏不抛异常，且不产生 NaN', () => {
  const ctx = makeCtx();
  assert.doesNotThrow(() => {
    draw.clear(ctx, 1280, 720);
    draw.dim(ctx, 1280, 720, 0.5);
    draw.progressBar(ctx, 1280, 0.42);
    draw.hitText(ctx, 1280, 720, { grade: 'GOOD', angleDiffDeg: -12.5, timeDiffMs: -20 }, 1);
    draw.hud(ctx, 1280, 720, makeHud());
  });
  assert.deepEqual(findBadNumbers(ctx), []);
  assert.ok(ctx.__calls.length > 30, `绘制调用太少（${ctx.__calls.length}）`);
});

test('界面：各种极端画布尺寸下都不炸', () => {
  for (const [W, H] of [
    [320, 240],
    [1920, 1080],
    [3840, 2160],
    [600, 1200],
    [2000, 400],
  ]) {
    const ctx = makeCtx();
    assert.doesNotThrow(() => {
      draw.clear(ctx, W, H);
      draw.hitText(ctx, W, H, { grade: 'PERFECT', angleDiffDeg: 0, timeDiffMs: 0 }, 1);
      draw.progressBar(ctx, W, 0.5);
      draw.hud(ctx, W, H, makeHud());
    }, `${W}×${H} 抛异常`);
    assert.deepEqual(findBadNumbers(ctx), [], `${W}×${H} 下有 NaN`);
  }
});

test('界面：dim 的透明度被夹在 [0,1]，NaN 当成不画', () => {
  for (const a of [-1, 0, 0.5, 1, 2, NaN, Infinity]) {
    const ctx = makeCtx();
    assert.doesNotThrow(() => draw.dim(ctx, 1280, 720, a), `alpha=${a} 抛异常`);
    assert.deepEqual(findBadNumbers(ctx), [], `alpha=${a} 产生 NaN`);
  }
  const zero = makeCtx();
  draw.dim(zero, 1280, 720, 0);
  assert.equal(zero.__calls.length, 0, 'alpha 为 0 时不该画');
});

test('界面：提示层能显示错误、能折行、能处理超长文本', () => {
  const ctx = makeCtx();
  assert.doesNotThrow(() => {
    draw.startPrompt(ctx, 1280, 720, {
      title: '余光',
      lines: ['占位音乐 · 120 BPM', '跟着重拍按空格'],
      hint: '空格 或 点击 开始',
    });
    draw.startPrompt(ctx, 1280, 720, { title: '余光', lines: ['正在加载谱面…'] });
    draw.startPrompt(ctx, 1280, 720, {
      title: '余光',
      lines: [],
      error: '加载谱面失败：HTTP 404 — levels/level01.json　'.repeat(4),
      hint: '空格 / 点击 重试',
    });
  });
  assert.deepEqual(findBadNumbers(ctx), []);
});

test('界面：结算画面在有成绩和零成绩下都能画', () => {
  const ctx = makeCtx();
  assert.doesNotThrow(() => {
    draw.finishedOverlay(ctx, 1280, 720, {
      stats: { ...emptyStats(), PERFECT: 40, GOOD: 8, OK: 2, MISS: 1, count: 51, maxCombo: 22, weighted: 47.9 },
      hitCount: 51,
    });
    draw.finishedOverlay(ctx, 1280, 720, { stats: emptyStats(), hitCount: 32 });
  });
  assert.deepEqual(findBadNumbers(ctx), []);
});

test('界面：判定大字——没有结果 / alpha 为 0 什么都不画', () => {
  const none = makeCtx();
  draw.hitText(none, 1280, 720, null, 1);
  assert.equal(none.__calls.length, 0);

  const zero = makeCtx();
  draw.hitText(zero, 1280, 720, { grade: 'PERFECT', angleDiffDeg: 0, timeDiffMs: 0 }, 0);
  assert.equal(zero.__calls.length, 0);
});

test('界面：自动漏掉的 MISS（没有角度差）只画等级一行', () => {
  const auto = makeCtx();
  draw.hitText(auto, 1280, 720, { grade: 'MISS', angleDiffDeg: null, timeDiffMs: null, auto: true }, 1);
  const autoTexts = auto.__calls.filter((c) => c.method === 'fillText');
  assert.equal(autoTexts.length, 1, '自动 MISS 应该只画一行字');
  assert.equal(autoTexts[0].args[0], 'MISS');

  const pressed = makeCtx();
  draw.hitText(pressed, 1280, 720, { grade: 'GOOD', angleDiffDeg: -31.5, timeDiffMs: -87.5, early: false }, 1);
  assert.equal(pressed.__calls.filter((c) => c.method === 'fillText').length, 2, '正常判定应该画两行');
});

test('界面：HUD 在前奏 / 零成绩 / 无历史下都能画', () => {
  const ctx = makeCtx();
  assert.doesNotThrow(() => {
    draw.hud(ctx, 1280, 720, makeHud({ songTime: -0.75, beat: -1.5, tileIndex: 0, combo: 0 }));
    draw.hud(ctx, 1280, 720, makeHud({ history: [], stats: emptyStats(), combo: 0 }));
  });
  assert.deepEqual(findBadNumbers(ctx), []);
  assert.ok(ctx.__calls.some((c) => c.method === 'fillText'));
});

test('界面：进度条在越界和非法值下都不炸', () => {
  for (const p of [-1, 0, 0.5, 1, 2, NaN, Infinity]) {
    const ctx = makeCtx();
    assert.doesNotThrow(() => draw.progressBar(ctx, 1280, p), `progress=${p} 抛异常`);
    assert.deepEqual(findBadNumbers(ctx), [], `progress=${p} 产生 NaN`);
  }
});

test('界面：每个等级的文字颜色都能查到，不会 undefined', () => {
  for (const grade of ['PERFECT', 'GOOD', 'OK', 'MISS']) {
    assert.ok(CONFIG.gradeStyle[grade], `配色里缺少 ${grade}`);
    assert.ok(CONFIG.gradeStyle[grade].text);
    assert.match(CONFIG.gradeStyle[grade].color, /^(#[0-9a-f]{6}|rgba?\()/i);
  }
});
