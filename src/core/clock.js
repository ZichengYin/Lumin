/**
 * 曲内时间轴。
 *
 * 规则只有一条：
 *
 *   **画面上的位置不是「一帧一帧加上去」的，而是每一帧从音频时钟反算出来的。**
 *
 * 为什么必须这样：
 *
 *   - 如果位置靠累加推进，那么每一次掉帧、切标签页、GC 停顿，误差都会累加进去。
 *     60fps 下每帧的抖动是毫秒级，跑三分钟就是肉眼可见的音画错位，而且**不可逆**。
 *   - 从时钟反算则永远没有累积误差：第 17.5 拍的状态，无论中间掉过多少帧，
 *     算出来都是同一个。掉帧只会让画面卡，不会让判定漂。
 *
 * 这个文件只管「现在是第几拍」。「第几拍对应行星在哪、该按哪一块砖」在
 * `core/chart.js` 里算。时间来源 `now()` 在浏览器里是 `AudioContext.currentTime`，
 * 在测试里是一个假的计数器，所以这里不碰浏览器。
 */

/** 每拍多少秒 */
export const secondsPerBeat = (bpm) => 60 / bpm;

export const beatsToSeconds = (beats, bpm) => beats * secondsPerBeat(bpm);
export const secondsToBeats = (seconds, bpm) => seconds / secondsPerBeat(bpm);

/**
 * 拍号的小数部分，规整到 [0, 1)。
 * 负数也要对：beat = -0.25（前奏里的最后一小段）应该得到 0.75，不是 -0.25。
 */
export function beatFraction(beat) {
  return beat - Math.floor(beat);
}

/**
 * 曲内时钟。它自己不产生时间，只是把「音频时钟」翻译成「曲内秒数 / 拍号」。
 */
export class SongClock {
  /**
   * @param {object} opts
   * @param {() => number} opts.now  返回音频时钟当前秒数（AudioContext.currentTime）
   * @param {number} opts.bpm
   * @param {number|(() => number)} [opts.offsetSec]
   *        音频延迟补偿，正值 = 把判定往后推，去贴合你听到的声音。
   *        ★ 传**函数**更好：偏移由「硬件延迟 + 手动微调 + 谱面偏移」三部分算出来，
   *          其中硬件延迟（浏览器的 outputLatency）是会随时间变的。
   *          传数字的话它就是个快照，一旦硬件延迟变了，时钟和实际听到的就会差开。
   */
  constructor({ now, bpm, offsetSec = 0 }) {
    this._now = now;
    this.bpm = bpm;
    this._offset = offsetSec;
    /** 音频真正开始播放的音频时钟时刻；null = 还没开始 */
    this._startTime = null;
  }

  /** 当前的总偏移（秒）。传进来的是函数就每次现算，保证不会用到过期值 */
  get offsetSec() {
    return typeof this._offset === 'function' ? this._offset() : this._offset;
  }

  set offsetSec(v) {
    this._offset = v;
  }

  /**
   * 指定音频的实际开始时刻。
   * **必须用 AudioEngine.play() 返回的那个值**，不要在别处再读一次 currentTime——
   * 两次读取之间隔的几微秒就是固定的对表误差。
   */
  startAt(ctxTime) {
    this._startTime = ctxTime;
    return this._startTime;
  }

  /** 便捷写法：now() 之后 delaySec 秒开始（测试用） */
  startIn(delaySec = 0) {
    return this.startAt(this._now() + delaySec);
  }

  /** 停表。songTime 不再推进，直到再次 startAt()。暂停用 */
  stop() {
    this._startTime = null;
  }

  /**
   * 反过来算：要让「曲内拍号」正好等于 beat，音频时钟该走到哪一刻。
   *
   * 用途是**预约**一个未来事件 —— 比如导航语音要在第 12.5 拍响。
   * 如果改成「每帧检查该不该播了」，播报时刻就会跟着帧率抖（±16ms），
   * 而这里算出来的是一个确定值，可以交给 Web Audio 精确调度。
   */
  audioTimeForBeat(beat) {
    if (this._startTime === null) return null;
    return this._startTime + this.offsetSec + beat * this.secondsPerBeat;
  }

  get running() {
    return this._startTime !== null;
  }

  get secondsPerBeat() {
    return secondsPerBeat(this.bpm);
  }

  /**
   * 曲内时间（秒）。
   * 负数表示还在前奏里（音乐还没响，行星已经在转了）。
   * 没开始播放时返回 0。
   */
  get songTime() {
    if (this._startTime === null) return 0;
    return this._now() - this._startTime - this.offsetSec;
  }

  /** 曲内拍号。17.5 = 第 17 拍正中间；负数 = 前奏 */
  get beat() {
    return secondsToBeats(this.songTime, this.bpm);
  }

  get beatFraction() {
    return beatFraction(this.beat);
  }
}
