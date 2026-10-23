/**
 * 导航语音。
 *
 * 这是全黑阶段**唯一**能提前告诉你「前面要转弯 / 有障碍」的东西。
 * 路看不见之后，玩家能依靠的只有：
 *   · 这一段路本身的节奏（转弯的拍长是 1.5 或 0.5 拍，直行是 1 拍）
 *   · 这个播报
 *   · 井盖和箭头那点白色符号
 *
 * ── 两个设计要点 ──────────────────────────────────────────
 *
 * ① **语音走自己的 gain，直接连 destination。**
 *    压低音乐时用的是音乐那条链路的 gain，所以播报不会被一起压掉。
 *    如果图省事共用一个 gain，就会出现「一播报，人声也变小了」。
 *
 * ② **播报时刻由拍号反算，不靠帧检查。**
 *    `play(name, when)` 的 when 来自 `clock.audioTimeForBeat()`，
 *    交给 Web Audio 精确调度；每帧检查的话会带上 ±16ms 的帧率抖动。
 */

/**
 * 淡入 / 淡出时长（秒）。
 *
 * 为什么必须有：录音文件多半是在**非零振幅处剪的**，
 * 第一个采样不是 0。播放时从 0 跳到那个值就是一个台阶 ——
 * 听起来是"啪"的一声，在安静的段落里特别刺耳。
 * 打断正在播的那条也是同一个道理。
 *
 * 12ms 足够消掉台阶，又短到听不出"渐入"。
 */
const FADE_IN_SEC = 0.012;
const FADE_OUT_SEC = 0.03;

export class VoiceEngine {
  /**
   * @param {import('./audio.js').AudioEngine} audio 共用它的 AudioContext
   */
  constructor(audio) {
    this.audio = audio;
    /** name -> AudioBuffer */
    this.buffers = new Map();
    /** 加载失败的条目，出错只提示一次 */
    this.failed = new Set();
    /** 语音专用的输出增益，绕开音乐的 gain */
    this.gain = null;
    /** @type {AudioBufferSourceNode|null} */
    this.current = null;
    /** 当前这条的包络节点（淡入淡出用） */
    this.currentEnv = null;
    /** 当前这条（或最后一条）语音的结束时刻 */
    this.endsAt = -Infinity;
    /** 一共成功加载了几条 */
    this.loaded = 0;
  }

  /** 有没有语音可用。一条都没加载上就安静地什么都不做 */
  get ready() {
    return this.loaded > 0;
  }

  /** 现在有没有语音正在响 */
  get busy() {
    return this.audio.now < this.endsAt;
  }

  /** 这条语音多长（秒）。没加载上就是 0 */
  duration(name) {
    return this.buffers.get(name)?.duration ?? 0;
  }

  /**
   * 加载一组语音。
   * @param {Record<string, string>} cues 名字 -> 地址
   */
  async load(cues) {
    const ctx = this.audio.ctx;
    if (!ctx) throw new Error('VoiceEngine.load() 必须在 await audio.init() 之后调用');

    if (!this.gain) {
      this.gain = ctx.createGain();
      this.gain.gain.value = 1;
      this.gain.connect(ctx.destination);
    }

    await Promise.all(
      Object.entries(cues).map(async ([name, url]) => {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const raw = await res.arrayBuffer();
          this.buffers.set(name, await ctx.decodeAudioData(raw));
          this.loaded += 1;
        } catch (err) {
          this.failed.add(name);
          // 语音缺失不该让游戏起不来，安静降级
          console.warn(`[余光] 导航语音加载失败：${name}（${url}）— ${err?.message ?? err}`);
        }
      }),
    );
    return this.loaded;
  }

  /**
   * 播一条。
   *
   * 会把正在播的那条**打断**：如果两条提示凑得太近，更需要听到的是
   * 更靠后的那一个（也就是新播的这条）。
   *
   * ★ 两头都做了淡入淡出。录音多半是在**非零振幅处剪的** ——
   *   文件第一个采样不是 0，播放时从 0 跳到那个值就是一个台阶，
   *   听起来是"啪"的一声。打断时的硬切同理。
   *
   * @param {string} name
   * @param {number|null} when 音频时钟时刻；null = 立刻
   * @returns {number} 这条语音的时长（秒），没播成返回 0
   */
  play(name, when = null) {
    const buf = this.buffers.get(name);
    const ctx = this.audio.ctx;
    if (!buf || !ctx || !this.gain) return 0;

    this.stop();
    // when 可能已经过去了（掉帧、或者刚开局），那就立刻播
    const startAt = Math.max(ctx.currentTime, when ?? 0);
    const endAt = startAt + buf.duration;

    // 独立的包络节点：这样打断它不会影响别的语音
    const env = ctx.createGain();
    const g = env.gain;
    const fadeIn = Math.min(FADE_IN_SEC, buf.duration / 4);
    const fadeOut = Math.min(FADE_OUT_SEC, buf.duration / 4);
    g.setValueAtTime(0, startAt);
    g.linearRampToValueAtTime(1, startAt + fadeIn);
    g.setValueAtTime(1, endAt - fadeOut);
    g.linearRampToValueAtTime(0, endAt);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(env).connect(this.gain);
    src.start(startAt);

    this.current = src;
    this.currentEnv = env;
    this.endsAt = endAt;
    return buf.duration;
  }

  /**
   * 掐掉正在播的那条。默认淡出 —— 硬切一样会"啪"。
   * @param {number} fadeSec 淡出时长
   */
  stop(fadeSec = FADE_OUT_SEC) {
    const src = this.current;
    const env = this.currentEnv;
    const ctx = this.audio.ctx;
    if (!src) return;

    this.current = null;
    this.currentEnv = null;

    if (env && ctx) {
      const t = ctx.currentTime;
      try {
        env.gain.cancelScheduledValues(t);
        env.gain.setValueAtTime(env.gain.value, t);
        env.gain.linearRampToValueAtTime(0, t + fadeSec);
      } catch {
        // 参数已经排不进去了（上下文已关），退化成硬切
      }
    }
    try {
      // 淡出之后再真正停，否则会把 ramp 掐断
      src.stop(ctx ? ctx.currentTime + fadeSec : 0);
    } catch {
      // 已经停了就无所谓
    }
    try {
      src.disconnect();
    } catch {
      // 同上
    }
  }

  /** 把已经排好的播报全部撤销（重开一局时用） */
  reset() {
    this.stop(0.005);
    this.endsAt = -Infinity;
  }
}
