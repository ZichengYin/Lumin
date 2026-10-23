/**
 * main.js 的无头集成测试。
 *
 * main.js 是「接线」的地方：时钟、谱面、音频、判定、渲染全在这里拼起来。
 * 单个模块都测过了，但接线接错了照样白搭——而且它只在浏览器里跑，
 * 报错也只出现在控制台里。
 *
 * 所以这里搭一套最小的假浏览器环境（假 canvas、假 AudioContext、假 fetch、
 * 手动驱动的 requestAnimationFrame），把**真实的 main.js 原样导入**，
 * 然后真的去驱动时间、真的去按空格，一路走完整条谱面。
 *
 * 谱面用的是仓库里真实的 levels/level01.json —— 顺手也验证了它没错。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from '../src/config.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CHART_PATH = resolve(ROOT, CONFIG.chart.url);

const CHART_JSON = existsSync(CHART_PATH)
  ? readFileSync(CHART_PATH, 'utf8')
  : JSON.stringify({
      name: '内置测试谱面',
      bpm: 120,
      timing: 'uniform',
      beatsPerTile: 1,
      leadInTurns: 1,
      angles: [0, -90, 0, 90, 0, -90, 0, 90, 0, -90, 0, 90],
    });

// ── 假的 2D 上下文 ──────────────────────────────────────────
function makeFakeCtx2d() {
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

// ── 假的浏览器环境 ──────────────────────────────────────────
function createBrowserEnv() {
  const rafQueue = [];
  const windowListeners = new Map();
  const canvasListeners = new Map();

  const on = (map, key, fn) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(fn);
  };
  const fire = (map, key, event = {}) => {
    for (const fn of map.get(key) ?? []) fn(event);
  };

  const ctx2d = makeFakeCtx2d();

  const canvas = {
    clientWidth: 1280,
    clientHeight: 720,
    width: 0,
    height: 0,
    getContext: () => ctx2d,
    addEventListener: (type, fn) => on(canvasListeners, type, fn),
    focus() {},
  };

  // 假的 AudioContext。
  //
  // ★ 关键：currentTime 必须由**闭包里的共享变量**提供，不能每个实例各存一份。
  //   因为 main.js 会自己 `new AudioContext()`，测试拿到的那个和它在用的不是同一个
  //   对象；如果各存一份，测试推进的时间 main.js 根本看不见，songTime 会永远停在
  //   前奏里。（这个坑第一次就踩了，日志里显示「第 −2.02 拍」正是它。）
  let audioTime = 0;
  const startedSources = [];
  const instances = [];

  /**
   * 假的 AudioParam。
   *
   * 真正的 AudioParam 除了 value 还有一整套调度方法
   * （cancelScheduledValues / setValueAtTime / linearRampToValueAtTime）。
   * 少了它们，duck() 一调用就抛，而它跑在 frame() 里 ——
   * 会把整个主循环带崩，表现成一堆毫不相干的测试失败。
   *
   * 这里把调度事件记下来，测试才能验「压低确实是渐变的」。
   */
  function makeParam(initial = 1) {
    return {
      _value: initial,
      events: [],
      get value() {
        return this._value;
      },
      set value(v) {
        this._value = v;
      },
      setValueAtTime(v, t) {
        this.events.push({ type: 'set', v, t });
        this._value = v;
        return this;
      },
      linearRampToValueAtTime(v, t) {
        // 渐变不立刻改 value —— 它是「安排在未来」的
        this.events.push({ type: 'ramp', v, t });
        return this;
      },
      cancelScheduledValues(t) {
        this.events.push({ type: 'cancel', t });
        return this;
      },
    };
  }

  class FakeAudioContext {
    constructor() {
      this.state = 'running';
      this.sampleRate = 44100;
      this.destination = { name: 'destination' };
      this.baseLatency = 0.005;
      this.outputLatency = 0.012;
      instances.push(this);
    }
    get currentTime() {
      return audioTime;
    }
    set currentTime(v) {
      audioTime = v;
    }
    createGain() {
      return { gain: makeParam(1), connect: (dest) => dest, disconnect() {} };
    }
    createBufferSource() {
      return {
        buffer: null,
        connect: (dest) => dest,
        disconnect() {},
        start(when) {
          startedSources.push(when);
        },
        stop() {},
      };
    }
    async resume() {
      this.state = 'running';
    }
    async decodeAudioData(buf) {
      // 音乐 32 秒（和占位音乐一致），语音 1.2 秒。
      // 靠 fetch 给的 buffer 大小区分 —— decodeAudioData 只拿得到 buffer。
      const isVoice = buf && buf.byteLength === 512;
      const duration = isVoice ? 1.2 : 32;
      return { duration, sampleRate: 44100, length: Math.round(duration * 44100) };
    }
  }

  const body = {
    classes: new Set(),
    classList: { add: (c) => body.classes.add(c) },
  };

  const fakeWindow = {
    devicePixelRatio: 2,
    innerWidth: 1280,
    innerHeight: 720,
    AudioContext: FakeAudioContext,
    addEventListener: (type, fn) => on(windowListeners, type, fn),
  };

  const fakeDocument = { body, getElementById: () => canvas };

  /** 可切换的 fetch 行为，方便测各种加载失败 */
  let fetchMode = 'ok';

  return {
    ctx2d,
    canvas,
    audio: {
      get currentTime() {
        return audioTime;
      },
      set currentTime(v) {
        audioTime = v;
      },
      startedSources,
      instances,
    },
    window: fakeWindow,
    body,
    setFetchMode(mode) {
      fetchMode = mode;
    },
    install() {
      globalThis.window = fakeWindow;
      globalThis.document = fakeDocument;
      globalThis.location = { search: '' };
      globalThis.fetch = async (url) => {
        const u = String(url);
        if (fetchMode === 'chart-404' && u.endsWith('.json')) {
          return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
        }
        if (fetchMode === 'audio-404' && !u.endsWith('.json')) {
          return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
        }
        if (u.endsWith('.json')) {
          return {
            ok: true,
            status: 200,
            json: async () => JSON.parse(CHART_JSON),
            arrayBuffer: async () => new ArrayBuffer(0),
          };
        }
        // 语音文件给一个小得多的 buffer，decodeAudioData 靠它区分音乐和语音
        const bytes = u.includes('/voice/') ? 512 : 4096;
        return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(bytes) };
      };
      globalThis.requestAnimationFrame = (cb) => {
        rafQueue.push(cb);
        return rafQueue.length;
      };
    },
    /** 跑一帧 */
    tick() {
      const cbs = rafQueue.splice(0);
      for (const cb of cbs) cb();
      return cbs.length;
    },
    key(code, extra = {}) {
      fire(windowListeners, 'keydown', { code, repeat: false, preventDefault() {}, ...extra });
    },
    pointerDown() {
      fire(canvasListeners, 'pointerdown', { preventDefault() {} });
    },
    resize() {
      fire(windowListeners, 'resize', {});
    },
  };
}

const env = createBrowserEnv();
env.install();

// 必须在装好全局之后才导入
await import('../src/main.js');

const Y = globalThis.window.YUGUANG;
const flush = () => new Promise((r) => setTimeout(r, 0));

// 让 loadLevel() 的 fetch 落地
await flush();

const chart = Y.chart;
const firstBeat = chart.segments[0].startBeat;
const spb = 60 / chart.bpm;

/** 把音频时钟直接拨到某个时刻 */
function setAudioTime(t) {
  env.audio.currentTime = t;
}

/** 让「曲内拍号」精确等于 beat 所需的音频时钟时刻 */
function ctxTimeForBeat(beat) {
  return Y.clock._startTime + Y.clock.offsetSec + beat * spb;
}

/** 跳到某个拍位并跑一帧 */
function goToBeat(beat) {
  setAudioTime(ctxTimeForBeat(beat));
  env.tick();
}

function badNumbersInFrame() {
  return env.ctx2d.__calls
    .flatMap((c) => c.args.map((a, i) => ({ m: c.method, i, a })))
    .filter((x) => typeof x.a === 'number' && !Number.isFinite(x.a));
}

/**
 * 重开一局，并推进到「音乐已经开始」。
 * `restart()` 里面的 `start()` 是异步的（要等音频解码），不等一下的话
 * `clock._startTime` 还是上一局的，后面所有按拍位换算的时刻都会错。
 */
async function freshRun() {
  Y.restart();
  await flush();
  // 0.2 拍：已经进音乐，但离第一块砖的窗口上界（0.5 拍）还有距离，
  // 不会在开局就触发自动 MISS。
  goToBeat(0.2);
}

// ────────────────────────────────────────────────────────────

test('启动：谱面载入完成，停在待机画面', () => {
  assert.ok(Y, 'window.YUGUANG 没有挂上，main.js 可能在中途抛异常了');
  assert.equal(Y.state.phase, 'idle', `期望 idle，实际 ${Y.state.phase}（错误：${Y.state.error}）`);
  assert.ok(chart, '谱面没有载入');
  assert.ok(chart.hitCount > 4, `谱面太短：${chart.hitCount}`);
  assert.equal(env.body.classes.has('ready'), true, '应该已经关掉「正在加载」兜底提示');

  env.ctx2d.__calls.length = 0;
  assert.ok(env.tick() > 0, 'requestAnimationFrame 没有被排上');
  assert.ok(env.ctx2d.__calls.some((c) => c.method === 'fillText'), '待机画面应该画了文字');
});

test('开始：start() 之后进入前奏，音频被安排在前奏结束时播放', async () => {
  await Y.start();

  assert.equal(Y.state.phase, 'leadin');
  assert.equal(Y.audio.ready, true, '音频没有被加载');

  // 前奏 = 第 0 段的时长；leadInTurns=1 → 360° → 2 拍 → 120BPM 下 1.0 秒
  const expectedLeadIn = -firstBeat * spb;
  assert.ok(Math.abs(expectedLeadIn - 1.0) < 1e-9, `前奏应为 1.0 秒，实际 ${expectedLeadIn}`);

  assert.equal(Y.clock._startTime, expectedLeadIn, 'startAt 用的应该就是 play() 返回的那个时刻');

  // ★ 不断言「只有一条音轨」—— 现在还有第二条同步音轨（人声 / 音效床）。
  //   真正要保证的是**它们共用同一个起播时刻**：差一点点，
  //   两条轨就会越走越偏，几十秒后人声能偏出半秒去。
  const started = env.audio.startedSources;
  assert.ok(started.length >= 1, '音乐至少要被安排播放');
  for (const t of started) {
    assert.equal(t, expectedLeadIn, '所有音轨必须共用同一个开始时刻');
  }

  setAudioTime(0.5);
  assert.ok(Y.clock.songTime < 0, '还没进音乐时 songTime 应为负');
});

test('前奏里画一帧不会炸，也不会产生 NaN', () => {
  setAudioTime(0.5);
  env.ctx2d.__calls.length = 0;
  assert.doesNotThrow(() => env.tick());
  assert.deepEqual(badNumbersInFrame(), []);
});

test('进音乐：拍号过零后自动从 leadin 切到 playing', () => {
  goToBeat(0.25);
  assert.equal(Y.state.phase, 'playing');
});

test('★ 逐块走完整条谱面：每一块在它的击打拍位上按都判 PERFECT 且时间差为 0', () => {
  let judged = 0;

  for (let i = 0; i < chart.hitCount; i++) {
    assert.equal(Y.state.nextHit, i, `应该轮到第 ${i} 块了，实际 ${Y.state.nextHit}`);

    const beat = chart.segments[i].hitBeat;
    goToBeat(beat);
    Y.state.result = null;
    Y.hit();

    assert.equal(
      Y.state.result.grade,
      'PERFECT',
      `第 ${i} 块（第 ${beat.toFixed(2)} 拍）没判成 PERFECT，而是 ${Y.state.result.grade}`,
    );
    assert.ok(
      Math.abs(Y.state.result.timeDiffMs) < 1e-6,
      `第 ${i} 块时间差应为 0，实际 ${Y.state.result.timeDiffMs}`,
    );
    judged += 1;
  }

  assert.equal(judged, chart.hitCount);
  assert.equal(Y.state.stats.count, chart.hitCount);
  assert.equal(Y.state.stats.PERFECT, chart.hitCount);
  assert.equal(Y.state.stats.MISS, 0);
  assert.equal(Y.state.stats.ghost, 0);
  assert.equal(Y.state.combo, chart.hitCount);
  assert.equal(Y.state.stats.maxCombo, chart.hitCount);
});

test('★ 判定用的是「按下那一瞬间」，不是上一帧画出来的状态', async () => {
  await freshRun();

  // 先把前 6 块正常打完
  for (let i = 0; i < 6; i++) {
    goToBeat(chart.segments[i].hitBeat);
    Y.hit();
  }
  assert.equal(Y.state.nextHit, 6);

  // 故意把画面留在很早的一帧……
  goToBeat(0.2);
  // ……然后不重新渲染，直接把音频时间拨到第 7 块的击打拍位再按
  setAudioTime(ctxTimeForBeat(chart.segments[6].hitBeat));
  Y.hit();

  assert.equal(Y.state.result.grade, 'PERFECT');
  assert.ok(Math.abs(Y.state.result.timeDiffMs) < 1e-6, `实际 ${Y.state.result.timeDiffMs}`);
  assert.equal(Y.state.nextHit, 7);
});

test('★ 偏早/偏晚 20ms 判得准', async () => {
  await freshRun();

  // 打完前 3 块
  for (let i = 0; i < 3; i++) {
    goToBeat(chart.segments[i].hitBeat);
    Y.hit();
  }

  // 第 4 块提前 20ms
  const seg = chart.segments[3];
  setAudioTime(ctxTimeForBeat(seg.hitBeat) - 0.02);
  Y.hit();
  assert.equal(Y.state.result.early, true);
  assert.ok(Math.abs(Y.state.result.timeDiffMs - 20) < 1e-6, `实际 ${Y.state.result.timeDiffMs}`);
  assert.equal(Y.state.result.grade, 'PERFECT', '20ms 应该还在 PERFECT 窗口内');

  // 第 5 块晚 20ms
  const seg5 = chart.segments[4];
  setAudioTime(ctxTimeForBeat(seg5.hitBeat) + 0.02);
  Y.hit();
  assert.equal(Y.state.result.early, false);
  assert.ok(Math.abs(Y.state.result.timeDiffMs + 20) < 1e-6, `实际 ${Y.state.result.timeDiffMs}`);
  assert.equal(Y.state.result.grade, 'PERFECT');
});

test('★ 漏掉不按 → 自动记 MISS，连击清零', async () => {
  await freshRun();

  for (let i = 0; i < 2; i++) {
    goToBeat(chart.segments[i].hitBeat);
    Y.hit();
  }
  assert.equal(Y.state.combo, 2);

  // 第 3 块完全跳过：时间直接推过它的 OK 窗口
  const target = 2;
  const seg = chart.segments[target];
  const past = seg.hitBeat + seg.windowBeats(CONFIG.windows.ok) + 0.01;
  goToBeat(past);

  assert.equal(Y.state.stats.MISS, 1, '应该自动记一次 MISS');
  assert.equal(Y.state.combo, 0, '连击应该清零');
  assert.equal(Y.state.nextHit, target + 1);
  assert.equal(Y.state.result.grade, 'MISS');
  assert.equal(Y.state.result.auto, true, '自动 MISS 要标记出来（画面上不显示角度差）');
  assert.equal(Y.state.result.angleDiffDeg, null);
});

test('★ 空按：离得太远时不消耗砖块，只记一次空按', async () => {
  await freshRun();

  const index = Y.state.nextHit;
  const seg = chart.segments[index];
  const wayEarly = seg.hitBeat - seg.windowBeats(CONFIG.windows.ok) - 0.15;

  goToBeat(wayEarly);
  const missBefore = Y.state.stats.MISS;
  Y.hit();

  assert.equal(Y.state.stats.ghost, 1, '应该记一次空按');
  assert.equal(Y.state.nextHit, index, '空按不该消耗砖块');
  assert.equal(Y.state.stats.count, 0, '空按不该计入命中数');
  assert.equal(Y.state.stats.MISS, missBefore, '空按不是 MISS');
  assert.equal(Y.state.result.ghost, true);

  // 之后再正常按这一块，依然能拿 PERFECT
  goToBeat(seg.hitBeat);
  Y.hit();
  assert.equal(Y.state.result.grade, 'PERFECT');
  assert.equal(Y.state.nextHit, index + 1);
});

test('操作：← → 调整手动偏移，方向与幅度都对', () => {
  const before = Y.userOffsetMs;
  env.key('ArrowRight');
  assert.equal(Y.userOffsetMs, before + 5);
  env.key('ArrowLeft');
  assert.equal(Y.userOffsetMs, before);
  env.key('ArrowLeft');
  assert.equal(Y.userOffsetMs, before - 5);
  env.key('ArrowRight', { shiftKey: true });
  assert.equal(Y.userOffsetMs, before - 4);

  assert.ok(
    Math.abs(Y.clock.offsetSec - (Y.audio.hardwareLatencySec + Y.userOffsetMs / 1000 + chart.audioOffsetSec)) <
      1e-9,
    '调完之后时钟的偏移要立刻跟上（含谱面的音频偏移）',
  );

  Y.userOffsetMs = 0;
});

test('操作：偏移会整体平移判定', async () => {
  await freshRun();

  // 先把前两块打完，让 nextHit 轮到第 3 块
  for (let i = 0; i < 2; i++) {
    goToBeat(chart.segments[i].hitBeat);
    Y.hit();
  }
  assert.equal(Y.state.nextHit, 2);

  const index = 2;
  const seg = chart.segments[index];

  // 先在当前偏移下，算出「正好踩在第 3 块上」的墙上时刻
  const when = ctxTimeForBeat(seg.hitBeat);
  setAudioTime(when);
  env.tick();
  Y.hit();
  assert.ok(
    Math.abs(Y.state.result.timeDiffMs) < 1e-6,
    `默认偏移下应为正中，实际 ${Y.state.result.timeDiffMs}`,
  );

  // 第 4 块的墙上时刻必须在改偏移**之前**算好 ——
  // ctxTimeForBeat 用的是当前的 offsetSec，改完再算就不是同一个时刻了
  const next = chart.segments[index + 1];
  const whenNext = ctxTimeForBeat(next.hitBeat);

  // 墙上时刻不动，只把补偿加到 30ms —— 判定应该整体变成「早了 30ms」
  Y.userOffsetMs = 30;
  setAudioTime(whenNext);
  env.tick();
  Y.hit();

  assert.equal(Y.state.result.early, true, '补偿之后同一时刻应该变成「早」');
  assert.ok(
    Math.abs(Y.state.result.timeDiffMs - 30) < 1e-6,
    `实际 ${Y.state.result.timeDiffMs}`,
  );

  Y.userOffsetMs = 0;
});

test('操作：鼠标点击等价于按空格', async () => {
  await freshRun();

  goToBeat(chart.segments[0].hitBeat);
  const before = Y.state.stats.count;
  env.pointerDown();
  assert.equal(Y.state.stats.count, before + 1);
  assert.equal(Y.state.result.grade, 'PERFECT');
});

test('★ 谱面走完 → 自动切到 finished 并停止音频', async () => {
  await freshRun();

  for (let i = 0; i < chart.hitCount; i++) {
    goToBeat(chart.segments[i].hitBeat);
    Y.hit();
  }
  assert.equal(Y.state.nextHit, chart.hitCount);
  assert.equal(Y.state.phase, 'playing', '还没超过最后一块的窗口，不该结束');

  const last = chart.segments[chart.hitCount - 1];
  goToBeat(last.hitBeat + last.windowBeats(CONFIG.windows.ok) + 0.01);

  assert.equal(Y.state.phase, 'finished');
  assert.equal(Y.audio.playing, false, '结束后应该停掉音源');
  assert.doesNotThrow(() => env.tick());
});

test('重来：R 之后回到 leadin 且成绩清零', async () => {
  await freshRun();
  goToBeat(chart.segments[0].hitBeat);
  Y.hit();
  assert.ok(Y.state.stats.count > 0, '重来之前应该已经有成绩');

  env.key('KeyR');
  await flush();

  assert.equal(Y.state.phase, 'leadin');
  assert.equal(Y.state.stats.count, 0);
  assert.equal(Y.state.history.length, 0);
  assert.equal(Y.state.combo, 0);
  assert.equal(Y.state.nextHit, 0);
});

test('结束态按空格 → 重新开始', async () => {
  await freshRun();

  for (let i = 0; i < chart.hitCount; i++) {
    goToBeat(chart.segments[i].hitBeat);
    Y.hit();
  }
  const last = chart.segments[chart.hitCount - 1];
  goToBeat(last.hitBeat + last.windowBeats(CONFIG.windows.ok) + 0.5);
  assert.equal(Y.state.phase, 'finished');

  Y.hit();
  await flush();
  assert.equal(Y.state.phase, 'leadin');
});

test('窗口尺寸变化后仍能正常画帧', () => {
  env.canvas.clientWidth = 800;
  env.canvas.clientHeight = 1400;
  env.ctx2d.__calls.length = 0;
  assert.doesNotThrow(() => {
    env.resize();
    env.tick();
  });
  assert.ok(Y.state.camera && Y.state.camera.focal > 0, '镜头应当按新视口重建');
  assert.ok(Y.state.track && Y.state.track.points.length > 0);
  assert.deepEqual(badNumbersInFrame(), []);
});

test('谱面加载失败：报错、进入 error 态，把错误画到屏幕上', async () => {
  env.setFetchMode('chart-404');
  await Y.loadLevel();

  assert.equal(Y.state.phase, 'error');
  assert.match(String(Y.state.error), /404/);
  assert.doesNotThrow(() => env.tick());
  assert.ok(
    env.ctx2d.__calls.some((c) => c.method === 'fillText' && String(c.args[0]).includes('404')),
    '错误信息应该被画到屏幕上',
  );

  // 恢复之后能重新载入
  env.setFetchMode('ok');
  await Y.loadLevel();
  assert.equal(Y.state.phase, 'idle');
  assert.ok(Y.chart);
});

test('音频加载失败：报错、留在待机', async () => {
  Y.state.phase = 'idle';
  Y.state.error = null;
  env.setFetchMode('audio-404');
  Y.audio.url = null; // 强制重新加载
  Y.audio.buffer = null;

  await Y.start();

  assert.equal(Y.state.phase, 'idle', '音频失败不该进入前奏');
  assert.match(String(Y.state.error), /404/);
  assert.doesNotThrow(() => env.tick());

  env.setFetchMode('ok');
});
