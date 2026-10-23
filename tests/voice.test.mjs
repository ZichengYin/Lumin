/**
 * 导航语音的测试。
 *
 * 语音是全黑阶段唯一的提前提示，它坏掉的表现是「游戏能玩，但你不知道前面有东西」——
 * 这种「静默降级」最难发现，所以这里把每条边界都钉住。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VoiceEngine } from '../src/audio/voice.js';
import { AudioEngine } from '../src/audio/audio.js';

/** 假的 AudioParam：把调度事件记下来，能验「是渐变不是硬切」 */
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
      this.events.push({ type: 'ramp', v, t });
      return this;
    },
    cancelScheduledValues(t) {
      this.events.push({ type: 'cancel', t });
      return this;
    },
  };
}

/** 假的 AudioContext，记下每个音源什么时候开始、什么时候被停 */
function makeEnv({ decodeFails = [] } = {}) {
  const sources = [];
  const gains = [];
  const ctx = {
    currentTime: 0,
    destination: { name: 'destination' },
    createGain() {
      // connect 要返回目的地 —— play() 里是 src.connect(env).connect(gain) 这么链的
      const g = { gain: makeParam(1), connect: (dest) => dest, disconnect() {} };
      gains.push(g);
      return g;
    },
    createBufferSource() {
      const src = {
        buffer: null,
        startedAt: null,
        stopped: false,
        stopAt: null,
        connect: (dest) => dest,
        disconnect() {},
        start(t) {
          this.startedAt = t;
        },
        stop(t) {
          this.stopped = true;
          this.stopAt = t;
        },
      };
      sources.push(src);
      return src;
    },
    async decodeAudioData() {
      return { duration: 1.2, sampleRate: 22050, length: Math.round(1.2 * 22050) };
    },
  };
  const audio = {
    ctx,
    get now() {
      return ctx.currentTime;
    },
  };
  return { ctx, audio, sources, gains, decodeFails };
}

/** 装上假的 fetch（默认全部成功） */
function installFetch({ fail = [] } = {}) {
  const old = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (fail.some((f) => u.includes(f))) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(512) };
  };
  return () => {
    globalThis.fetch = old;
  };
}

test('语音：没加载之前 ready 为 false，play 安静地什么都不做', () => {
  const { audio, sources } = makeEnv();
  const v = new VoiceEngine(audio);
  assert.equal(v.ready, false);
  assert.equal(v.duration('obstacle'), 0);
  assert.equal(v.play('obstacle'), 0, '没加载上就该返回 0，而不是抛异常');
  assert.equal(sources.length, 0);
});

test('语音：加载之后 ready / duration 都对', async () => {
  const restore = installFetch();
  try {
    const { audio } = makeEnv();
    const v = new VoiceEngine(audio);
    const n = await v.load({ obstacle: 'x/obstacle.wav', 'turn-left': 'x/turn-left.wav' });
    assert.equal(n, 2);
    assert.equal(v.ready, true);
    assert.ok(Math.abs(v.duration('obstacle') - 1.2) < 1e-9);
    assert.equal(v.failed.size, 0);
  } finally {
    restore();
  }
});

test('语音：某一条加载失败，其它照常可用（静默降级）', async () => {
  const restore = installFetch({ fail: ['turn-right'] });
  try {
    const { audio } = makeEnv();
    const v = new VoiceEngine(audio);
    const n = await v.load({
      obstacle: 'v/obstacle.wav',
      'turn-left': 'v/turn-left.wav',
      'turn-right': 'v/turn-right.wav',
    });
    assert.equal(n, 2, '两条成功');
    assert.equal(v.ready, true, '缺一条不该整体不可用');
    assert.ok(v.failed.has('turn-right'));
    assert.equal(v.play('turn-right'), 0, '缺的那条播不出来，但不抛异常');
    assert.ok(v.duration('turn-left') > 0);
  } finally {
    restore();
  }
});

test('语音：play 用给定的音频时刻排程，不是「立刻」', async () => {
  const restore = installFetch();
  try {
    const { audio, ctx, sources } = makeEnv();
    const v = new VoiceEngine(audio);
    await v.load({ obstacle: 'x.wav' });

    ctx.currentTime = 10;
    const dur = v.play('obstacle', 12.5);
    assert.ok(Math.abs(dur - 1.2) < 1e-9);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].startedAt, 12.5, '要精确排在给的那一刻上');
  } finally {
    restore();
  }
});

test('语音：给了一个已经过去的时刻，就立刻播', async () => {
  const restore = installFetch();
  try {
    const { audio, ctx, sources } = makeEnv();
    const v = new VoiceEngine(audio);
    await v.load({ obstacle: 'x.wav' });

    ctx.currentTime = 10;
    v.play('obstacle', 3); // 早就过去了
    assert.equal(sources[0].startedAt, 10, '不能排到过去，否则 Web Audio 行为不确定');
  } finally {
    restore();
  }
});

test('语音：新的播报会打断旧的 —— 更近的那个障碍更要紧', async () => {
  const restore = installFetch();
  try {
    const { audio, sources } = makeEnv();
    const v = new VoiceEngine(audio);
    await v.load({ obstacle: 'x.wav', 'turn-left': 'y.wav' });

    v.play('obstacle');
    assert.equal(sources.length, 1);
    assert.equal(sources[0].stopped, false);

    v.play('turn-left');
    assert.equal(sources.length, 2);
    assert.equal(sources[0].stopped, true, '旧的必须被停掉，否则两条语音会叠在一起');
    assert.equal(sources[1].stopped, false);
  } finally {
    restore();
  }
});

test('语音：busy 在播放期间为真，结束后为假；reset 立刻归零', async () => {
  const restore = installFetch();
  try {
    const { audio, ctx } = makeEnv();
    const v = new VoiceEngine(audio);
    await v.load({ obstacle: 'x.wav' });

    ctx.currentTime = 5;
    v.play('obstacle'); // 1.2 秒
    assert.equal(v.busy, true);
    ctx.currentTime = 5.5;
    assert.equal(v.busy, true, '还在播');
    ctx.currentTime = 6.5;
    assert.equal(v.busy, false, '已经播完');

    ctx.currentTime = 20;
    v.play('obstacle');
    assert.equal(v.busy, true);
    v.reset();
    assert.equal(v.busy, false, '重开一局要把播报状态清干净');
  } finally {
    restore();
  }
});

test('语音：两头都有淡入淡出 —— 否则录音的硬剪会"啪"一声', async () => {
  const restore = installFetch();
  try {
    const { audio, ctx, gains } = makeEnv();
    const v = new VoiceEngine(audio);
    await v.load({ obstacle: 'x.wav' });

    ctx.currentTime = 0;
    const start = 10;
    v.play('obstacle', start); // 假 buffer 1.2 秒

    // 最后建的那个 gain 是这条语音的包络（第一个是 VoiceEngine 自己的输出）
    const env = gains[gains.length - 1];
    const sets = env.gain.events.filter((e) => e.type === 'set');
    const ramps = env.gain.events.filter((e) => e.type === 'ramp');

    assert.equal(sets[0].v, 0, '必须从 0 开始 —— 直接满音量就是一个台阶，就是那声噪音');
    assert.equal(sets[0].t, start, '淡入的起点就是播放时刻');
    assert.ok(ramps[0].v === 1 && ramps[0].t > start && ramps[0].t - start < 0.05, '淡入要短');
    assert.ok(Math.abs(ramps[1].v) < 1e-9, '结尾淡出到 0');
    assert.ok(Math.abs(ramps[1].t - (start + 1.2)) < 1e-9, '淡出正好在语音结束时归零');
  } finally {
    restore();
  }
});

test('语音：打断旧的那条也是淡出，不是硬切', async () => {
  const restore = installFetch();
  try {
    const { audio, ctx, gains } = makeEnv();
    const v = new VoiceEngine(audio);
    await v.load({ obstacle: 'x.wav', 'turn-left': 'y.wav' });

    ctx.currentTime = 0;
    v.play('obstacle', 0);
    const firstEnv = gains[gains.length - 1];
    firstEnv.gain.events.length = 0;

    ctx.currentTime = 0.3;
    v.play('turn-left', 0.3);

    const ramps = firstEnv.gain.events.filter((e) => e.type === 'ramp');
    assert.ok(ramps.length > 0, '被打断的那条要收到一个淡出 ramp');
    assert.ok(Math.abs(ramps[ramps.length - 1].v) < 1e-9, '淡到 0');
  } finally {
    restore();
  }
});

test('压低：currentTime 不是 0 时，也不能把增益设成时刻值', () => {
  // ★ 这一条对应一个真实发生过的 bug：
  //   duck() 里把「从哪个增益值开始」误写成了 Math.max(currentTime, 增益值)，
  //   于是 from 永远等于 currentTime（几十秒），音乐增益被设成几十倍 —— 一声音爆，
  //   而且正好发生在语音播报前，听起来像「播报前的杂音」。
  //   原来的测试用 currentTime = 0，两个数撞在一起，所以没抓到。
  const a = new AudioEngine();
  a.ctx = { currentTime: 42.5 };
  a.gain = { gain: makeParam(1) };
  a.setVolume(0.85);

  a.duck(0.5, 1.5);

  const sets = a.gain.gain.events.filter((e) => e.type === 'set');
  for (const e of sets) {
    assert.ok(
      e.v >= 0 && e.v <= 1,
      `增益被设成了 ${e.v} —— 它必须是一个 0~1 的数，不能是时刻`,
    );
  }
  assert.ok(Math.abs(sets[0].v - 0.85) < 1e-9, `应当从当前增益 0.85 开始，实际 ${sets[0].v}`);
  assert.ok(Math.abs(sets[1].v - 0.85 * 0.5) < 1e-9, '压到 42.5%');
});

// ── 压低音乐 ────────────────────────────────────────────────

test('压低：是渐变不是硬切，而且会恢复到原音量', () => {
  const a = new AudioEngine();
  a.ctx = { currentTime: 0 };
  a.gain = { gain: makeParam(1) };
  a.setVolume(0.8);

  a.duck(0.25, 1.5);

  const ev = a.gain.gain.events;
  assert.equal(ev[0].type, 'cancel', '先取消未完成的调度，否则多次压低会互相打架');
  assert.equal(ev[0].t, 0);
  const set = ev.find((e) => e.type === 'set');
  assert.ok(set, '要有起始点');
  assert.ok(Math.abs(set.v - 0.8) < 1e-9, '从当前音量 0.8 开始');
  const ramps = ev.filter((e) => e.type === 'ramp');
  assert.equal(ramps.length, 2, '下去一次、回来一次');
  assert.ok(Math.abs(ramps[0].v - 0.8 * 0.25) < 1e-9, `压低到 ${0.8 * 0.25}`);
  assert.ok(Math.abs(ramps[1].v - 0.8) < 1e-9, '恢复到玩家设定的音量');
  assert.ok(ramps[0].t > 0 && ramps[0].t < 0.2, '淡下去要快，但不能是 0');
});

test('压低：setVolume 之后再用旧音量恢复就是错的，所以它记着玩家的音量', () => {
  const a = new AudioEngine();
  a.ctx = { currentTime: 0 };
  a.gain = { gain: makeParam(1) };

  a.setVolume(0.5);
  a.duck(0.2, 1);
  a.setVolume(0.9);
  a.gain.gain.events.length = 0;
  a.duck(0.2, 1);

  const ramps = a.gain.gain.events.filter((e) => e.type === 'ramp');
  assert.ok(Math.abs(ramps[1].v - 0.9) < 1e-9, '要恢复到最新的音量 0.9，不是老的 0.5');
});

test('压低：没有 ctx / gain 时不抛异常（音频还没初始化）', () => {
  const a = new AudioEngine();
  assert.doesNotThrow(() => a.duck(0.3, 1));
  a.ctx = { currentTime: 0 };
  assert.doesNotThrow(() => a.duck(0.3, 1));
});
