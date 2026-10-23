/**
 * 音频引擎：加载、播放，以及提供那个唯一可信的时钟。
 *
 * 分工很明确 —— 这个文件只管「声音」和「现在音频播到第几秒」，
 * 至于那一秒对应第几拍、行星该在哪，全在 `core/clock.js` 里算。
 *
 * 两个浏览器现实：
 *
 *  1. **必须在用户手势里创建 / 恢复 AudioContext**，否则它一直是 suspended，
 *     你按空格什么都不会发生。所以游戏得有个「点击开始」。
 *  2. **`currentTime` 不是「你听到的时间」。** 浏览器把音频交给系统、系统再送到
 *     耳机，这中间有几十毫秒。`outputLatency` 就是这段延迟的估计值，
 *     减去它才能让判定贴合「你耳朵听到的」而不是「浏览器以为的」。
 */

export class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {AudioBuffer|null} */
    this.buffer = null;
    /** @type {GainNode|null} */
    this.gain = null;
    /** @type {AudioBufferSourceNode|null} */
    this.source = null;
    /** 音频真正开始播放的 ctx 时刻 */
    this.startedAt = null;
    /** 加载的音频地址，出错时报给玩家看 */
    this.url = null;
    /** 玩家设定的音量。duck() 之后要恢复到这个值 */
    this.volume = 1;
    /** 当前的压低调度结束时刻，用来避免多次压低互相打架 */
    this._duckUntil = -Infinity;

    // ── 第二条同步音轨（人声 / 音效床）────────────────────
    // 把一堆零散提示音在 DAW 里合成一条整轨，和音乐一起起播。
    // 好处是不用一个个对时机；代价是两条轨必须严格对齐 —— 见 bedSkipSec。
    /** @type {AudioBuffer|null} */
    this.bedBuffer = null;
    /** @type {GainNode|null} */
    this.bedGain = null;
    /** @type {AudioBufferSourceNode|null} */
    this.bedSource = null;
    /** 第二条音轨的音量，和音乐分开 */
    this.bedVolume = 1;
    /** 它开头要跳掉多少秒（跳过导出时留下的留白） */
    this.bedSkipSec = 0;
    /** 加载的地址，避免重复加载 */
    this.bedUrl = null;
  }

  get ready() {
    return this.buffer !== null;
  }

  get playing() {
    return this.source !== null;
  }

  /** 音频时钟当前秒数。还没初始化时返回 0。 */
  get now() {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  get durationSec() {
    return this.buffer ? this.buffer.duration : 0;
  }

  /** AudioContext 的实际采样率，可能不是 44100（取决于系统设置） */
  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 0;
  }

  /**
   * 硬件输出延迟估计（秒）。
   * outputLatency 是首选；拿不到就退回 baseLatency；再拿不到就 0。
   */
  get hardwareLatencySec() {
    if (!this.ctx) return 0;
    const out = this.ctx.outputLatency;
    if (Number.isFinite(out) && out > 0) return out;
    const base = this.ctx.baseLatency;
    if (Number.isFinite(base) && base > 0) return base;
    return 0;
  }

  /**
   * 初始化：建上下文、恢复、下载并解码音频。
   * **必须在用户手势（点击 / 按键）里调用。**
   * @param {string} url
   */
  async init(url) {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('这个浏览器不支持 Web Audio API');
      // interactive：要最低延迟，不要省电
      this.ctx = new Ctx({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 1;
      this.gain.connect(this.ctx.destination);

      // 第二条音轨（人声 / 音效床）走**自己的** gain：
      // 压低音乐时不会把它一起压掉，音量也能单独调。
      this.bedGain = this.ctx.createGain();
      this.bedGain.gain.value = this.bedVolume * this.volume;
      this.bedGain.connect(this.ctx.destination);
    }

    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    if (!this.buffer || this.url !== url) {
      this.url = url;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`加载音频失败：HTTP ${res.status} — ${url}`);
      }
      const raw = await res.arrayBuffer();
      if (raw.byteLength === 0) {
        throw new Error(`音频文件是空的：${url}`);
      }
      try {
        this.buffer = await this.ctx.decodeAudioData(raw);
      } catch (err) {
        throw new Error(`音频解码失败（格式不支持？）：${url}`);
      }
    }

    return this;
  }

  /**
   * 加载第二条同步音轨（人声 / 音效床）。
   *
   * 和音乐**共用同一个起播时刻**，所以两条轨不会各走各的、越差越多 ——
   * 这是把一堆零散提示音合成一条整轨之后唯一需要保证的事。
   *
   * @param {string} url
   */
  async loadBed(url) {
    if (!this.ctx) throw new Error('loadBed() 之前必须先 await init()');
    if (this.bedBuffer && this.bedUrl === url) return this;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`加载第二条音轨失败：HTTP ${res.status} — ${url}`);
    const raw = await res.arrayBuffer();
    try {
      this.bedBuffer = await this.ctx.decodeAudioData(raw);
    } catch {
      throw new Error(`第二条音轨解码失败（格式不支持？）：${url}`);
    }
    this.bedUrl = url;
    return this;
  }

  /**
   * 第二条音轨开头要跳掉多少秒。
   *
   * 整轨导出时开头那段留白是「还没到第一句提示」，而音乐的开头可能只留了 0.13 秒。
   * 两条对齐的关键就是**跳过各自的开头**，让第一个有声采样同时出现 ——
   * 用 src.start(when, skip) 跳 buffer，而不是把起播时刻挪开
   * （挪时刻会在 seek / 暂停恢复时算不清，而且可能挪到过去）。
   */
  setBedSkip(sec) {
    this.bedSkipSec = Math.max(0, sec);
  }

  /** 第二条音轨的**相对**音量 0 ~ 1（再乘上玩家总音量） */
  setBedVolume(v) {
    this.bedVolume = Math.max(0, Math.min(1, v));
    this.applyBedVolume();
  }

  /**
   * 在 delaySec 秒之后开始播放。
   * @param {number} delaySec  延迟多少秒开始（前奏用）
   * @param {number} offsetSec 从音频的第几秒开始播（编辑器拖进度条 / 暂停恢复用）
   * @returns {number} 音频**实际开始**的 ctx 时刻。把这个值交给 SongClock.startAt()，
   *                   两边共用同一个时间点，才能保证对表没有误差。
   */
  play(delaySec = 0, offsetSec = 0) {
    if (!this.ctx || !this.buffer) throw new Error('play() 之前必须先 await init()');
    this.stop();

    const when = this.ctx.currentTime + Math.max(0, delaySec);
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    // 第二个参数是「从 buffer 的第几秒开始」，夹一下防止越界
    const from = this.clampToBuffer(this.buffer, offsetSec);
    src.start(when, from);
    this.source = src;

    // 第二条音轨：**同一个 when**，只是各自跳过开头的留白。
    // offsetSec 要一起加上 —— 从中间恢复播放时它也得跟着走。
    if (this.bedBuffer && this.bedGain) {
      const bed = this.ctx.createBufferSource();
      bed.buffer = this.bedBuffer;
      bed.connect(this.bedGain);
      const bedFrom = this.clampToBuffer(this.bedBuffer, this.bedSkipSec + offsetSec);
      bed.start(when, bedFrom);
      this.bedSource = bed;
    }

    this.startedAt = when;
    return when;
  }

  /** 把「从第几秒开始」夹进 buffer 的有效范围 */
  clampToBuffer(buffer, sec) {
    return Math.max(0, Math.min(sec, Math.max(0, buffer.duration - 0.01)));
  }

  stop() {
    for (const key of ['source', 'bedSource']) {
      const src = this[key];
      if (!src) continue;
      try {
        src.stop();
      } catch {
        // 已经自然播完，忽略
      }
      try {
        src.disconnect();
      } catch {
        // 同上
      }
      this[key] = null;
    }
    this.startedAt = null;
  }

  /**
   * 玩家总音量 0 ~ 1。
   *
   * ★ 必须**两条轨一起调**。音乐走 this.gain、音效走 bedGain，
   *   只调前者的话，音效轨仍是满音量 —— 而音效通常比音乐响，
   *   于是听感上「按了音量键没反应」。这个坑真的踩过。
   */
  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.gain) {
      this.gain.gain.value = this.volume;
    }
    this.applyBedVolume();
  }

  /** 音效轨的实际增益 = 它自己的相对音量 × 玩家总音量 */
  applyBedVolume() {
    if (this.bedGain) {
      this.bedGain.gain.value = this.bedVolume * this.volume;
    }
  }

  /**
   * 把音乐压低一段时间（导航语音播报时用）。
   *
   * 只动音乐这一条链路：语音从 VoiceEngine 直接连 destination，
   * 不经过这个 gain，所以压低音乐不会把播报一起压掉。
   *
   * 淡入淡出而不是硬切 —— 硬切会「啪」一声，比压低本身还明显。
   */
  duck(factor = 0.3, seconds = 1.5) {
    if (!this.ctx || !this.gain) return;
    const t = this.ctx.currentTime;
    const low = Math.max(0, Math.min(1, this.volume * factor));
    // ★ 这里要的是「从哪个**增益值**开始」，不是「从哪个时刻开始」。
    //
    //   曾经写成 `Math.max(t, ...)` —— t 是秒数（几十），跟增益值（0~1）比大小
    //   永远取 t，于是 setValueAtTime(from, t) 把音乐增益设成了几十倍，
    //   一声音爆。而且它正好在语音播报前，听起来像「播报前的杂音」。
    //
    //   单元测试没抓到，是因为测试里 currentTime 恰好是 0，跟增益值撞上了。
    //   所以下面那条测试特意用 currentTime = 42.5。
    const from = this._duckUntil > t ? low : this.gain.gain.value;
    const end = Math.max(t + 0.2, t + seconds);
    this._duckUntil = end;

    const g = this.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(from, t);
    g.linearRampToValueAtTime(low, t + 0.06);
    g.setValueAtTime(low, end - 0.18);
    g.linearRampToValueAtTime(this.volume, end);
  }

  /** 关闭上下文（一般只有测试或切场景才需要） */
  async close() {
    this.stop();
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
      this.gain = null;
      this.buffer = null;
    }
  }
}
