/**
 * 《余光》主循环
 *
 * 四条不变的原则，改这个文件时不要破坏：
 *
 *   1. **位置是时间的纯函数。** 盲杖角度、盲人所在的那一格、镜头的目标点全部由
 *      「曲内拍号」反算，没有 `x += v * dt` 式的累加。掉帧只会让画面卡，
 *      不会让判定漂。
 *   2. **判定用按下那一瞬间的音频时间**，不是上一帧画出来的状态。
 *   3. **开始时刻只有一个真相**：`audio.play()` 返回的那个值，同时交给时钟。
 *   4. **渲染层只读状态。** 所有状态推进（相位、判定大字过期、镜头平滑）都在
 *      `frame()` 里做完，`render()` 只负责画。
 *
 * ── 两套坐标，别搞混 ────────────────────────────────────────
 *   · **谱面坐标**（core/chart.js）：等距平面，相邻落脚点间距 1，用于判定几何。
 *   · **世界坐标**（render/camera.js）：间距 tileSpacing，`x` 右、`z` 前，
 *     用于透视投影。两者只差一个比例，`buildWorldTrack` 负责换算。
 *   判定永远在谱面坐标里算，所以画面怎么改都不会影响手感。
 *
 * 用 URL 参数调：
 *   ?chart=levels/level01.json&offset=0
 */

import { CONFIG, msPerBeat as calcMsPerBeat, angleDegToMs } from './config.js';
import { createCanvas } from './render/canvas.js';
import * as draw from './render/draw.js';
import * as world from './render/world.js';
import { createCamera, shortestAngle } from './render/camera.js';
import { judgeHit } from './core/judge.js';
import { toRad } from './core/geometry.js';
import { SongClock, secondsToBeats } from './core/clock.js';
import { buildChart, planetStateAtBeat, segmentAngleAtBeat } from './core/chart.js';
import { buildWarnings } from './core/warnings.js';
import { AudioEngine } from './audio/audio.js';
import { VoiceEngine } from './audio/voice.js';
import { createMenu } from './menu.js';

// ── URL 参数 ────────────────────────────────────────────────
const query = new URLSearchParams(location.search);
const pick = (key, fallback) => {
  const v = Number(query.get(key));
  return query.has(key) && Number.isFinite(v) ? v : fallback;
};

/**
 * 调试用的两个参数，专门给无头截图比对比例用：
 *   ?beat=12.5   直接渲染到第 12.5 拍，并且不显示待机提示
 *   ?fade=0.7    强制把渐暗程度定成 0.7（默认按曲内时间算）
 * 正常玩的时候不传这两个参数，行为完全不变。
 */
const debugBeat = query.has('beat') ? pick('beat', 0) : null;
const debugFade = query.has('fade') ? pick('fade', 0) : null;
/** ?chart=levels/xxx.json 临时换一份谱面（不改 CONFIG） */
const chartUrl = query.get('chart') ?? CONFIG.chart.url;
/**
 * ?autostart=1 载入完直接开跑。
 * 给无头截图用的：浏览器默认要等一次用户手势才允许出声，
 * 截图时要额外加 --autoplay-policy=no-user-gesture-required。
 */
const autostart = query.has('autostart');
/** ?paused=1 一进来就摆成暂停面板（截图 / 调设置界面用） */
const debugPaused = query.has('paused');
/** ?revealR=2.5 把涟漪半径钉死成这个值（世界单位）—— 调尺寸时用来量屏幕上实际多大 */
const debugRevealR = query.has('revealR') ? Number(query.get('revealR')) : null;

// ── DOM ────────────────────────────────────────────────────
const canvasEl = document.getElementById('stage');
const view = createCanvas(canvasEl);

// ── 音频与时钟 ──────────────────────────────────────────────
const audio = new AudioEngine();
/** 导航语音。共用 audio 的 AudioContext，但走自己的 gain，不会被压低 */
const voice = new VoiceEngine(audio);
/** 主界面层。在下面 createMenu() 里创建，之前的调用一律用 ?. 兜住 */
let menu = null;
/** 谱面加载完才知道 BPM，所以时钟在 loadLevel() 里创建 */
let clock = null;

/** 手动偏移（毫秒）。调大 = 判定往后推，用来贴合你实际听到的声音 */
let userOffsetMs = pick('offset', 0);
/** 玩家音量。和偏移一样会被记住 */
let userVolume = CONFIG.audio.volume;

// ── 玩家设置：存 localStorage，刷新 / 重开都还在 ────────────
// 音画偏移是**每台设备都不一样**的东西（蓝牙耳机能差 200ms），
// 让玩家每次打开都重调一遍是很糟的体验。
const SETTINGS_KEY = 'yuguang.settings';

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (Number.isFinite(s.volume)) userVolume = Math.max(0, Math.min(1, s.volume));
    if (Number.isFinite(s.offsetMs)) userOffsetMs = Math.max(-500, Math.min(500, s.offsetMs));
  } catch {
    // 隐私模式 / 存储被禁用：用默认值，不影响玩
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ volume: userVolume, offsetMs: userOffsetMs }));
  } catch {
    // 同上，存不了就算了
  }
}

loadSettings();

/** 改音量。播放中立刻生效 */
function setVolume(v, { quiet = false } = {}) {
  userVolume = Math.max(0, Math.min(1, v));
  audio.setVolume(userVolume);
  // 主界面的视频也得跟着调 —— 否则调小了回主界面又变响
  menu?.setVolume(userVolume);
  saveSettings();
  if (!quiet) showToast(`音量  ${Math.round(userVolume * 100)}%`);
}

/** 改音画偏移（毫秒）。正值 = 判定往后推 */
function setOffsetMs(ms, { quiet = false } = {}) {
  userOffsetMs = Math.max(-500, Math.min(500, ms));
  saveSettings();
  if (!quiet) showToast(`音画偏移  ${userOffsetMs >= 0 ? '+' : '−'}${Math.abs(userOffsetMs)} ms`);
}

/**
 * 屏幕下方的一条短提示。
 *
 * 调音量和偏移时**必须有即时反馈** —— 否则玩家按了键，听感上「好像没变」，
 * 只会以为是坏了（这个也真的发生过）。设置面板要按 Esc 才看得到，
 * 而调的时候多半正在玩。
 */
function showToast(text) {
  state.toast = { text, until: Date.now() + 1100 };
}

/**
 * 判定时钟的总偏移（秒）。`songTime = 音频时钟 − 开始时刻 − 这个值`，
 * 所以**正值 = 把判定往后推**。三部分叠加：
 *   · 硬件延迟：声音实际比 currentTime 晚多少才到耳朵
 *   · 手动微调：玩家用 ← → 自己调的
 *   · 谱面偏移：曲子开头到第一拍之间的留白（见 chart.audioOffsetSec）
 */
const totalOffsetSec = () =>
  audio.hardwareLatencySec + userOffsetMs / 1000 + (state.chart?.audioOffsetSec ?? 0);

/** 判定等级折算成准确率权重 */
const GRADE_WEIGHT = { PERFECT: 1, GOOD: 0.65, OK: 0.3, MISS: 0 };

/** 谱面坐标里轨道半径 = 半个落脚点间距 */
const ORBIT_R_UNITS = 0.5;

// ── 角色素材 ────────────────────────────────────────────────
/** 素材是俯视剪影，躺在地面上，所以用 groundFrame 的局部仿射来贴 */
const characterImage = typeof Image !== 'undefined' ? new Image() : null;
let characterReady = false;
if (characterImage) {
  characterImage.onload = () => {
    characterReady = true;
  };
  characterImage.onerror = () => {
    console.warn(`[余光] 角色素材加载失败：${CONFIG.assets.character}`);
  };
  characterImage.src = CONFIG.assets.character;
}

/**
 * 路砖和井盖的贴图。
 *
 * 命名规则：**1 = 失明前，2 = 漆黑**。过渡时两张交叉淡入
 * （1 的透明度 1→0，2 的 0→1），所以同一位置的两版图必须**尺寸一致**，
 * 否则过渡中间会看到轻微的位移。
 */
const loadImg = (src) => {
  if (typeof Image === 'undefined' || !src) return null;
  const im = new Image();
  im.src = src;
  return im;
};
const blockA = loadImg(CONFIG.assets.block1);
const blockB = loadImg(CONFIG.assets.block2);
const wellA = loadImg(CONFIG.assets.well1);
const wellB = loadImg(CONFIG.assets.well2);

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

// ── 运行时状态 ──────────────────────────────────────────────
const state = {
  /** loading | idle | leadin | playing | finished | error */
  phase: 'loading',
  chart: null,
  chartName: '',
  /** 投影器，随视口重建 */
  camera: null,
  /** 镜头状态（世界坐标 + 朝向） */
  cam: { x: 0, z: 0, yaw: 0 },
  camReady: false,
  /** 世界几何：points / hits / spacing */
  track: null,
  nextHit: 0,
  combo: 0,
  result: null,
  resultUntil: 0,
  error: null,
  stats: emptyStats(),
  history: [],
  /** 0 = 完全可见，1 = 全黑 */
  fade: 0,
  /** 按拍号排好的导航播报清单（由 buildWarnings 生成） */
  warnings: [],
  /** 下一条要播的播报下标 */
  warnIndex: 0,
  /** Esc 暂停中 */
  paused: false,
  /** 暂停时定格在曲内第几秒 —— 恢复要从这儿接着走 */
  pausedSongTime: 0,
  /** 屏幕下方的短提示 { text, until }（调音量 / 偏移时给即时反馈） */
  toast: null,
  /** 最近一次击打的时刻（performance.now()）—— 涟漪的起点 */
  revealAt: -Infinity,
  lastFrame: 0,
};

// ── 视口 ────────────────────────────────────────────────────
function layout() {
  const { width, height } = view;
  // 镜头比例也支持 URL 覆盖，方便在浏览器里直接拖着调
  //   ?horizon=0.33&charY=0.66&charR=0.028&dist=13
  state.camera = createCamera({
    width,
    height,
    horizonRatio: pick('horizon', CONFIG.camera.horizonRatio),
    charScreenY: pick('charY', CONFIG.camera.charScreenY),
    charRadiusRatio: pick('charR', CONFIG.camera.charRadiusRatio),
    charDistance: pick('dist', CONFIG.camera.charDistance),
  });
}

/** 谱面方向角（度）→ 世界的「前」方向 yaw。
    谱面角 0° = 世界 +x（右），90° = 世界 +z（前）；而 forward(ψ) = (sinψ, cosψ) */
const chartAngleToYaw = (deg) => Math.PI / 2 - toRad(deg);

// ── 载入谱面 ────────────────────────────────────────────────
async function loadLevel() {
  state.phase = 'loading';
  state.error = null;
  try {
    const url = chartUrl;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`加载谱面失败：HTTP ${res.status} — ${url}`);
    const raw = await res.json();

    const chart = buildChart(raw);
    state.chart = chart;
    state.chartName = raw.name ?? url;
    state.track = world.buildWorldTrack(chart, CONFIG.world.tileSpacing);
    clock = new SongClock({ now: () => audio.now, bpm: chart.bpm, offsetSec: () => totalOffsetSec() });

    resetRun();
    state.phase = 'idle';
    console.log(
      `[余光] 谱面已载入：${state.chartName}　${chart.hitCount} 次击打　` +
        `${chart.bpm} BPM　${chart.timing}　共 ${chart.durationBeats.toFixed(2)} 拍`,
    );
  } catch (err) {
    state.error = err?.message ?? String(err);
    state.phase = 'error';
    console.error('[余光] 谱面载入失败', err);
  }
}

/** 盲人此刻站在哪一格、朝向哪里（两者都是时间的纯函数） */
function characterAt(beat) {
  const ps = planetStateAtBeat(state.chart, beat);
  const tile = state.track.points[ps.index];
  return { ps, pos: { x: tile.x, z: tile.z }, yaw: chartAngleToYaw(ps.segment.targetAngleDeg) };
}

function resetRun() {
  state.stats = emptyStats();
  state.history = [];
  state.result = null;
  state.resultUntil = 0;
  state.nextHit = 0;
  state.combo = 0;
  state.fade = 0;
  state.camReady = false;
  state.warnIndex = 0;
  state.paused = false;
  state.pausedSongTime = 0;
  voice.reset();

  if (state.chart && state.track) {
    state.warnings = buildWarnings(state.chart, { leadBeats: CONFIG.voice.leadBeats });
    // 镜头直接摆到岗位上，别从原点飞过去
    const beat = state.chart.segments[0].startBeat;
    const c = characterAt(beat);
    state.cam.yaw = c.yaw;
    state.cam.x = c.pos.x - Math.sin(c.yaw) * state.camera.charDistance;
    state.cam.z = c.pos.z - Math.cos(c.yaw) * state.camera.charDistance;
    state.camReady = true;
  }
}

/**
 * 到点就播导航语音。
 *
 * 播报时刻由 `clock.audioTimeForBeat()` 反算后交给 Web Audio 排程，
 * 不是「这一帧发现该播了」—— 那样会带上帧率抖动，而且掉帧时会晚一整帧。
 */
function updateVoice(beat) {
  if (!CONFIG.navigation.enabled) return;
  const list = state.warnings;
  if (!voice.ready || !list || list.length === 0) return;

  while (state.warnIndex < list.length && list[state.warnIndex].beat <= beat) {
    const w = list[state.warnIndex];
    state.warnIndex += 1;
    const dur = voice.play(w.cue, clock.audioTimeForBeat(w.beat));
    if (dur > 0) audio.duck(CONFIG.voice.duck, dur + CONFIG.voice.duckTailSec);
  }
}

// ── 开始 / 重来 ─────────────────────────────────────────────
async function start() {
  if (!state.chart || state.phase === 'leadin' || state.phase === 'playing' || state.phase === 'loading') {
    return;
  }

  state.error = null;
  try {
    await audio.init(CONFIG.audio.url);
    audio.setVolume(userVolume); // 用玩家上次调好的音量，不是配置里的默认值
  } catch (err) {
    state.error = err?.message ?? String(err);
    state.phase = 'idle';
    console.error('[余光] 音频加载失败', err);
    return;
  }

  // 第二条同步音轨（人声 / 音效床）。
  // 和音乐分开 try：这条轨挂了不该拦着游戏 —— 变成纯音乐也能玩，
  // 让它把音乐和谱面一起带崩就太亏了。
  if (CONFIG.audio.voiceTrack) {
    try {
      audio.setBedVolume(CONFIG.audio.voiceTrackVolume);
      audio.setBedSkip(CONFIG.audio.voiceTrackSkipSec);
      await audio.loadBed(CONFIG.audio.voiceTrack);
    } catch (err) {
      console.warn('[余光] 第二条音轨加载失败，本次只有音乐', err);
    }
  }

  // 语音单独 try：它要在 audio.init() 之后加载（共用 AudioContext），
  // 但**语音出任何问题都不该拦着游戏** —— 大不了全黑阶段少一条提示，
  // 让它把音乐和谱面一起带崩就太亏了。
  if (CONFIG.navigation.enabled && !voice.ready) {
    try {
      const cues = Object.fromEntries(
        Object.entries(CONFIG.voice.cues).map(([k, f]) => [k, CONFIG.voice.dir + f]),
      );
      await voice.load(cues);
    } catch (err) {
      console.warn('[余光] 导航语音整体加载失败，游戏继续（全黑阶段会少一条提示）', err);
    }
  }

  resetRun();

  // 前奏 = 第 0 段的时长。这段时间音乐还没响，盲杖已经绕第一格转过去了。
  const leadInSec = -state.chart.segments[0].startBeat * clock.secondsPerBeat;

  // ★ audio.play() 返回音频真正开始播放的音频时钟时刻。
  //   时钟必须用同一个值来对表，不能在别处再读一次 currentTime。
  const when = audio.play(leadInSec);
  clock.startAt(when);

  state.phase = 'leadin';
}

function restart() {
  audio.stop();
  clock?.stop();
  resetRun();
  // ★ 必须先把相位复位。start() 在 leadin/playing/loading 时会直接 return，
  //   漏了这一行就会出现「按 R 停掉了音乐、清空了成绩，然后卡住不再开始」。
  state.phase = 'idle';
  // ★ 现在是**回主界面**（循环播 main.mp4），不是直接重开。
  //   玩家要从菜单点 Restart，那时候才播开场动画再进游戏。
  //   没有菜单就退回原来的直接重开。
  if (menu) menu.show();
  else start();
}

// ── 判定 ────────────────────────────────────────────────────
function recordHit(r, index) {
  const s = state.stats;
  state.result = r;
  state.resultUntil = performance.now() + CONFIG.resultHoldMs;

  s[r.grade] += 1;
  s.sumAbs += r.absAngleDeg;
  s.sumAbsMs += r.absTimeMs;
  s.weighted += GRADE_WEIGHT[r.grade] ?? 0;
  s.count += 1;

  if (r.grade === 'MISS') {
    state.combo = 0;
  } else {
    state.combo += 1;
    if (state.combo > s.maxCombo) s.maxCombo = state.combo;
  }

  state.history.unshift(r);
  state.history.length = Math.min(state.history.length, CONFIG.historySize);

  const seg = state.chart.segments[index];
  const when = r.early ? '早' : '晚';
  console.log(
    `[${r.grade}] 第 ${index + 1}/${state.chart.hitCount} 格　` +
      `角度差 ${r.angleDiffDeg >= 0 ? '+' : ''}${r.angleDiffDeg.toFixed(2)}°　` +
      `${when} ${r.absTimeMs.toFixed(1)} ms　连击 ${state.combo}　(转过 ${seg.sweep.toFixed(0)}°)`,
  );
}

/** 漏掉了：到了该探却没探 */
function recordAutoMiss(index) {
  const seg = state.chart.segments[index];
  const fake = {
    grade: 'MISS',
    auto: true,
    ghost: false,
    angleDiffDeg: null,
    timeDiffMs: null,
    absAngleDeg: CONFIG.windows.ok,
    absTimeMs: angleDegToMs(CONFIG.windows.ok, seg.msPerTurn),
    early: false,
  };
  const s = state.stats;
  s.MISS += 1;
  s.sumAbs += fake.absAngleDeg;
  s.sumAbsMs += fake.absTimeMs;
  s.count += 1;
  state.combo = 0;
  state.result = fake;
  state.resultUntil = performance.now() + CONFIG.resultHoldMs;
  state.history.unshift(fake);
  state.history.length = Math.min(state.history.length, CONFIG.historySize);

  console.log(`[MISS] 第 ${index + 1}/${state.chart.hitCount} 格　漏掉了`);
}

/**
 * 到了「再怎么算都来不及」的时刻，就把还没探的那些记为漏掉。
 * 用 while 是因为严重卡顿之后可能一次要补好几格。
 */
function autoMissIfNeeded(beat) {
  const chart = state.chart;
  while (state.nextHit < chart.hitCount) {
    const seg = chart.segments[state.nextHit];
    // ★ 加一点点容差，让自动 MISS 严格发生在判定窗口**之后**。
    //   classify() 用 `<=` 接受窗口边界，如果这里用严格相等，正好卡在边界上的
    //   一格会因为浮点误差（0.5 算成 0.5000000000000001）被抢先判成漏掉。
    const lateLimit = seg.hitBeat + seg.windowBeats(CONFIG.windows.ok) + 1e-9;
    if (beat <= lateLimit) break;
    recordAutoMiss(state.nextHit);
    state.nextHit += 1;
  }
}

function hit() {
  // ★ 暂停时按键不算击打。不拦的话，暂停面板上按方向键调设置
  //   会顺手打出一堆判定 —— 而出问题的表现是「恢复后成绩莫名其妙变差」。
  if (state.paused) return;
  if (state.phase === 'loading') return;

  // 盲杖敲到地上 —— 这一瞬才换来 0.3 秒的「看得见」。
  // 放在最前面（不管这一下判成 PERFECT 还是 MISS）：
  // 杖就是敲下去了，看不见才是错的。
  state.revealAt = performance.now();
  if (state.phase === 'error') {
    loadLevel();
    return;
  }
  if (state.phase === 'idle') {
    // 主界面：走菜单的开场动画，播完才真的开始。
    // 这里不能直接 start()，否则会跳过 restart.mp4。
    // 没有菜单（Node 测试环境、或者菜单创建失败）就退回直接开始。
    if (menu) menu.playIntro();
    else start();
    return;
  }
  if (state.phase === 'finished') {
    restart();
    return;
  }

  const chart = state.chart;
  const index = state.nextHit;
  if (index >= chart.hitCount) return;

  // ★ 关键：用「按下这一瞬间」的音频时间，不是上一帧画出来的状态。
  const beat = clock.beat;
  const seg = chart.segments[index];

  // 把该段的极角外推到此刻（这一下可能按得很早，盲杖那时还在上一格上），
  // 再交给同一个 judgeHit —— 保证判定语义只有一份实现。
  const planetAngle = segmentAngleAtBeat(chart, seg, beat);

  const r = judgeHit(planetAngle, toRad(seg.targetAngleDeg), seg.omega, {
    windows: CONFIG.windows,
    msPerTurn: seg.msPerTurn,
  });

  if (r.grade === 'MISS') {
    state.stats.ghost += 1;
    state.result = { ...r, ghost: true, auto: false };
    state.resultUntil = performance.now() + CONFIG.resultHoldMs;
    console.log(`[空按] 离第 ${index + 1} 格还差 ${r.absTimeMs.toFixed(0)} ms，不计数`);
    return;
  }

  recordHit(r, index);
  state.nextHit = index + 1;
}

/**
 * Esc 暂停 / 继续。
 *
 * 恢复时音乐是从 buffer 的某个位置重新起播的（`audio.play` 的第二个参数），
 * 时钟用 `startAt(when - fileTime)` 反推起点 —— 这样 songTime 正好接回暂停前那一刻，
 * 判定不会因为暂停而错位。
 */
/**
 * 主界面的设置面板：背景用 main 那段动画。
 *
 * ★ 不用 z-index 翻层（试过，翻不过来，面板背后永远是黑的）。
 *   改成**把视频当前帧画进 canvas**：菜单层设成透明（不 display:none，
 *   否则有些浏览器会停止解码），canvas 每帧自己把视频帧画上去，
 *   再画面板。顺序是画出来的，不依赖层叠。
 */
function setMenuSettings(on) {
  menu?.ghost(on);
  if (on) {
    const stage = document.getElementById('stage');
    if (stage) {
      stage.style.position = 'relative';
      stage.style.zIndex = '10';
    }
  }
}

/** 把 <video> 的当前帧按「等比装下」画进 canvas（和菜单里的留黑边一致） */
function drawMenuFrame(ctx, W, H) {
  const v = menu?.frameSource?.();
  if (!v || v.readyState < 2 || !v.videoWidth) return false;
  const s = Math.min(W / v.videoWidth, H / v.videoHeight);
  const dw = v.videoWidth * s;
  const dh = v.videoHeight * s;
  ctx.drawImage(v, (W - dw) / 2, (H - dh) / 2, dw, dh);
  return true;
}

function togglePause() {
  // 主界面的设置面板：关掉之后回主界面，而不是去操作时钟
  if (state.paused && state.phase === 'idle') {
    state.paused = false;
    menu?.ghost(false);
    menu?.show();
    return;
  }
  if (!state.chart || !clock) return;
  if (state.phase !== 'playing' && state.phase !== 'leadin') return;

  if (!state.paused) {
    state.pausedSongTime = clock.songTime;
    audio.stop();
    clock.stop();
    state.paused = true;
    return;
  }

  const fileTime = Math.max(0, state.pausedSongTime + (state.chart.audioOffsetSec ?? 0));
  const when = audio.play(0, fileTime);
  clock.offsetSec = () => totalOffsetSec();
  clock.startAt(when - fileTime);
  state.paused = false;
}

// ── 输入 ────────────────────────────────────────────────────
/**
 * **任意键都能击打** —— 音游只认空格太憋屈了。
 * 下面这几个是专用控制键，先拦下来不当击打：
 *   Esc 暂停 / ← → 调偏移 / R 重来
 * 另外组合键（Ctrl+R 刷新之类）和 F1~F12 都放给浏览器，
 * 单独按修饰键（Shift/Ctrl/Alt）也不算击打。
 */
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return; // 组合键交给浏览器

  if (e.code === 'Escape') {
    e.preventDefault();
    if (!e.repeat) togglePause();
    return;
  }

  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
    e.preventDefault();
    const step = (e.shiftKey ? 1 : 5) * (e.code === 'ArrowRight' ? 1 : -1);
    setOffsetMs(userOffsetMs + step);
    return;
  }

  // ↑ ↓ 调音量（按住 Shift 是 1% 微调）
  if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
    e.preventDefault();
    const step = (e.shiftKey ? 1 : 5) / 100;
    setVolume(userVolume + (e.code === 'ArrowUp' ? step : -step));
    return;
  }

  if (e.code === 'KeyR') {
    if (!e.repeat) restart();
    return;
  }

  if (/^F\d{1,2}$/.test(e.code)) return; // F1~F12 是浏览器功能键
  if (/^(Shift|Control|Alt|Meta)(Left|Right)$/.test(e.code)) return; // 单独按修饰键不算

  e.preventDefault();
  if (!e.repeat) hit(); // 按住不放不连发
});

canvasEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  hit();
});

// ── 镜头推进 ────────────────────────────────────────────────
/**
 * 镜头跟在盲人身后。盲人本身是**一格一格落点**的（他站着不动把杖扫完，
 * 探到了才迈步），所以镜头要有一点滞后，地面才会"流"起来而不是一格一格跳。
 *
 * 滞后会让盲人相对镜头微微前后浮动——那正好读作跑步的起伏。
 */
function updateCamera(dt, target) {
  const cam = state.cam;
  const wantYaw = target.yaw;

  if (!state.camReady) {
    cam.yaw = wantYaw;
    cam.x = target.pos.x - Math.sin(wantYaw) * state.camera.charDistance;
    cam.z = target.pos.z - Math.cos(wantYaw) * state.camera.charDistance;
    state.camReady = true;
    return;
  }

  const step = Math.max(0, Math.min(dt, 0.1));
  const kFollow = 1 - Math.exp(-CONFIG.camera.smooth * step);
  const kTurn = 1 - Math.exp(-CONFIG.camera.turnSpeed * step);

  cam.yaw += shortestAngle(cam.yaw, wantYaw) * kTurn;

  const wantX = target.pos.x - Math.sin(cam.yaw) * state.camera.charDistance;
  const wantZ = target.pos.z - Math.cos(cam.yaw) * state.camera.charDistance;
  cam.x += (wantX - cam.x) * kFollow;
  cam.z += (wantZ - cam.z) * kFollow;
}

/** 那一分钟渐渐变黑。0 = 完全可见，1 = 全黑 */
function fadeAmountAt(songTime) {
  // 关掉时返回 0（不变暗）。
  // ★ 这里原来写的是 `if (dur <= 0) return 1` —— 返回 1 是**全黑**，
  //   正好和「没有渐暗时长」的意思相反。谁把 durationSec 设成 0 想关掉它，
  //   都会得到一上来就全黑的画面。
  if (!CONFIG.fade.enabled) return 0;
  const dur = CONFIG.fade.durationSec;
  if (!(dur > 0)) return 0;
  const p = Math.max(0, Math.min(1, songTime / dur));
  return Math.pow(p, CONFIG.fade.curve);
}

// ── 主循环 ──────────────────────────────────────────────────
function frame() {
  requestAnimationFrame(frame);

  const now = performance.now();
  const dt = state.lastFrame ? (now - state.lastFrame) / 1000 : 0;
  state.lastFrame = now;

  // 判定大字的淡出属于「状态推进」，放在这里而不是 render 里 ——
  // 渲染层只读状态，写状态会让它的行为依赖调用时机，很难查。
  if (state.result && now > state.resultUntil) state.result = null;

  const chart = state.chart;
  if (debugPaused && chart) state.paused = true;
  // 暂停时时间**定格**：不读时钟，用暂停那一刻记下的 songTime。
  // 时钟本身已经 stop() 了，再读它只会得到一堆没有意义的值。
  const frozen = state.paused && chart;
  const beat = frozen ? secondsToBeats(state.pausedSongTime, chart.bpm) : clock ? clock.beat : 0;
  const songTime = frozen ? state.pausedSongTime : clock ? clock.songTime : 0;

  if (chart && state.track) {
    // 暂停期间不推进任何状态：不判漏、不渐暗、不播报
    if (!frozen) {
      if (state.phase === 'leadin' && beat >= 0) state.phase = 'playing';

      autoMissIfNeeded(beat);

      // 以「谱面走完」而不是「音乐放完」作为结束 —— 谱面比音乐短是正常的
      if (state.nextHit >= chart.hitCount && state.phase === 'playing') {
        const last = chart.segments[chart.hitCount - 1];
        if (beat > last.hitBeat + last.windowBeats(CONFIG.windows.ok)) {
          state.phase = 'finished';
          audio.stop();
        }
      }

      state.fade = debugFade !== null ? debugFade : fadeAmountAt(Math.max(0, songTime));
      if (debugBeat === null) updateVoice(beat);
    }

    // 镜头即使暂停也继续收敛一下 —— 它只是平滑，不推进任何游戏状态，
    // 停住的话刚改完谱面切回来会看到一个歪着的镜头。
    if (debugBeat !== null) state.camReady = false;
    updateCamera(dt, characterAt(debugBeat !== null ? debugBeat : beat));
  }

  render(songTime, beat);
}

/**
 * 涟漪：击打后的一小段时间里，以角色为圆心浮现一圈盲道。
 *
 * 形状是**路面上的圆**（直径 = radiusTiles × 2 格），不是屏幕上的圆 ——
 * 透视下它会投影成椭圆，那才是对的。
 *
 * 时间线：先扩散（spreadSec）到满半径，剩下的时间淡出。
 * 也就是「散开，然后立刻消失」——不会越散越大到收不住。
 *
 * @param {{always?: boolean}|undefined} opts always = 调试时强制常亮
 * @param {{x:number,z:number}} center
 * @returns {{x,z,radius,alpha}|null} null = 全黑
 */
function currentReveal(opts, center) {
  const cfg = CONFIG.reveal;
  if (!(cfg.afterHitSec > 0)) return null;

  const elapsed = opts?.always ? cfg.spreadSec : (performance.now() - state.revealAt) / 1000;
  if (!(elapsed >= 0) || elapsed > cfg.afterHitSec) return null;

  const full =
    debugRevealR !== null && Number.isFinite(debugRevealR)
      ? debugRevealR
      : Math.max(0.01, cfg.radiusTiles * CONFIG.world.tileSpacing);

  // ① 扩散：稍微「先快后慢」，读起来像涟漪在耗散，而不是匀速推出去
  const p = Math.min(1, elapsed / Math.max(0.001, cfg.spreadSec));
  const grow = 1 - (1 - p) * (1 - p);
  const radius = full * grow;

  // ② 起始的淡入：**这一条是消掉「啪一下」的关键**。
  //    光让半径从 0 长大还不够 —— 中心一出现就是满亮，看起来还是硬切。
  //    加一小段渐亮，整块光才像「浮」出来。
  const fadeIn = Math.min(1, elapsed / Math.max(0.001, cfg.fadeInSec));

  // ③ 淡出：扩散走完之后才开始，避免还没散开就暗下去
  const fadeSpan = Math.max(0.001, cfg.afterHitSec - cfg.spreadSec);
  const fadeOut = elapsed <= cfg.spreadSec ? 1 : Math.max(0, 1 - (elapsed - cfg.spreadSec) / fadeSpan);

  return {
    x: center.x,
    z: center.z,
    radius,
    // 边缘柔化宽度：**固定值，不跟着半径缩放**。
    // 跟着半径缩放的话，半径越大边缘越糊，整块光只是一起变亮变暗 ——
    // 看起来是「一团光在鼓」，不是「一圈在往外推」。
    // 有固定宽度的前沿，扩散才看得出来。
    soft: Math.max(0.2, cfg.edgeSoftTiles * CONFIG.world.tileSpacing),
    alpha: cfg.peakAlpha * fadeIn * fadeOut,
  };
}

function render(songTime, beat) {
  const { ctx, width: W, height: H } = view;
  draw.clear(ctx, W, H);

  const chart = state.chart;

  if (!chart || !state.track || state.phase === 'error') {
    draw.startPrompt(ctx, W, H, {
      title: '余光',
      lines: state.phase === 'error' ? [] : ['正在加载谱面…'],
      error: state.error,
      hint: state.phase === 'error' ? '空格 / 点击 重试' : undefined,
    });
    return;
  }

  // 待机时把画面摆在谱面最开始，开始前先让人看一眼这条路
  const renderBeat =
    debugBeat !== null
      ? debugBeat
      : state.phase === 'idle'
        ? chart.segments[0].startBeat
        : Math.max(beat, chart.segments[0].startBeat);

  const c = characterAt(renderBeat);
  const cam = state.cam;
  const camera = state.camera;
  const track = state.track;

  // ── 地面（只在涟漪范围内可见）──────────────────────────
  const spacing = CONFIG.world.tileSpacing;
  const ahead = Math.max(4, Math.ceil(CONFIG.world.viewDistance / spacing));
  const range = { from: Math.max(0, c.ps.index - 4), to: c.ps.index + ahead, width: CONFIG.world.pathWidth };

  // 调试截图时强制开着涟漪，否则渐暗走完之后截到的永远是纯黑
  const reveal = currentReveal(debugBeat !== null ? { always: true } : undefined, c.pos);
  // 环境亮度：整条路都看得见的那部分。一分钟内由 1 渐暗到 0。
  // 涟漪**不吃这个衰减** —— 否则一分钟后人敲下去也什么都看不见。
  const ambient = 1 - (state.fade ?? 0);

  // ★ 纯色底只在**贴图没加载好**时画。
  //   否则它会从贴图的透明处透出来 —— block2 那些透明的地方就全变成底色，
  //   看起来像「漆黑阶段根本没换图」。
  if (!(blockA?.complete && blockA.naturalWidth)) {
    world.blindPath(ctx, camera, cam, track, { ...range, ambient, reveal });
  } else {
    world.texturedPath(ctx, camera, cam, track, {
      ...range,
      imgA: blockA,
      imgB: blockB,
      fade: state.fade ?? 0,
      alpha: 1,
    });
  }
  world.blindPathGrid(ctx, camera, cam, track, { ...range, cell: CONFIG.world.pathCell, ambient, reveal });
  world.hitMarks(ctx, camera, cam, track, { ...range, ambient, reveal });

  // ── 地面上的小装饰 ─────────────────────────────────────
  const R = spacing / 2;
  world.sweepRing(ctx, camera, cam, c.pos, R);
  world.footprint(ctx, camera, cam, c.pos, CONFIG.world.charRadius);

  // ── 渐暗 ──────────────────────────────────────────────
  draw.dim(ctx, W, H, state.fade);

  // ── 涟漪：画在渐暗**之上** ─────────────────────────────
  //
  // ★ 顺序是关键。渐暗是一层盖住整个画面的黑，画在它下面的一切都会被吃掉 ——
  //   包括涟漪。那样一分钟之后玩家敲下去看到的还是纯黑，机制就白做了。
  //   所以涟漪单独再画一遍，并且排在渐暗之后。
  //
  // ★★ 用**裁剪**而不是「按格子判断该不该画」。
  //    路面是一段一格画的，每格 6 个世界单位，而半径只有 0.75 格 = 4.5 ——
  //    角色站在格子端点上，前后两格的中点离他都正好 3 单位，于是
  //    「半径长到 3」的那一刻两格同时亮起，扩散被整格量子化吃干净了，
  //    看起来就是硬切一下。
  //
  //    改成把画布裁到「脚下那个圆投影出来的形状」里，边缘就是连续的，
  //    半径长多少就露出多少 —— 扩散才真的看得见。
  //    投影工具是现成的：盲杖扫过的那圈用的就是这个。
  if (reveal) {
    const ring = camera.projectGroundCircle({ x: reveal.x, z: reveal.z }, reveal.radius, cam);
    if (ring && ring.length > 2) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(ring[0].x, ring[0].y);
      for (let i = 1; i < ring.length; i++) ctx.lineTo(ring[i].x, ring[i].y);
      ctx.closePath();
      ctx.clip();

      // 裁好之后整条路按正常亮度画，露出来的自然只有这一圈
      const rippleRange = { ...range, ambient: reveal.alpha, reveal: null };
      world.blindPath(ctx, camera, cam, track, rippleRange);
      world.blindPathGrid(ctx, camera, cam, track, { ...rippleRange, cell: CONFIG.world.pathCell });
      world.hitMarks(ctx, camera, cam, track, rippleRange);

      ctx.restore();
    }
  }

  // ── 盲人与盲杖：**永远最亮**，画在新暗之上 ──────────────
  //
  // 人物是玩家唯一的坐标参照。跟着一起变暗的话，一分钟之后连自己站在哪
  // 都看不出来 —— 而「看不见路」和「看不见自己」是完全不同的两件事，
  // 后者只会让人失去方位感，不是这个游戏想制造的体验。
  world.cane(ctx, camera, cam, c.pos, c.ps.planetAngle, R);
  if (characterReady) {
    world.character(ctx, camera, cam, c.pos, c.yaw, characterImage, CONFIG.world.charSpriteSize, {
      invert: CONFIG.world.charInvert,
    });
  }

  // ── 物件：井盖 / 左侧障碍 ─────────────────────────────
  //
  // ★ 不再受 `CONFIG.navigation.enabled` 控制。那个开关本来是给旧的
  //   逐条语音系统用的；现在音效是**一整轨**和音乐同时播，物件纯粹是画面，
  //   关掉导航层不该把它们一起藏起来。
  //
  // 状态：井盖用 well1/well2 交叉淡入；**左侧障碍暂时借用角色贴图**当占位，
  //       等素材画好再换（改 CONFIG.assets 里加一条即可）。
  for (const prop of track.props) {
    // 已经走过去的不再画 —— 路面本来就只画眼前那一段，
    // 物件要是留在原地就会"浮"在身后，和路的消失方式对不上。
    if (Number.isInteger(prop.tile) && prop.tile < state.nextHit) continue;

    const alpha = world.hintAlpha(camera, cam, prop, state.fade);
    if (alpha <= 0) continue;

    if (prop.type === 'manhole') {
      world.manhole(ctx, camera, cam, prop, prop.radius, {
        alpha,
        imgA: wellA,
        imgB: wellB,
        fade: state.fade ?? 0,
      });
    } else if (prop.type === 'obstacle-left') {
      // 占位：先借用井盖贴图。
      //
      // ★ 不能用 character() 画 —— 那是**站立立绘**（billboard），
      //   地面上的东西用它画出来就是一根竖条。well 是地面平面图，
      //   直接铺在地面圆上，和井盖走同一条路径。
      //
      //   旧数据里没有 radius，退回默认（0.27 格）。
      const r = prop.radius ?? CONFIG.world.tileSpacing * 0.27;
      world.manhole(ctx, camera, cam, prop, r, {
        alpha,
        imgA: wellA,
        imgB: wellB,
        fade: state.fade ?? 0,
      });
    } else if (prop.type === 'turn') {
      // 转向箭头：导航层取消后不再使用，但谱面里可能还留着旧数据
      const i = prop.tile ?? 0;
      const prevDeg = track.angles[Math.max(0, i - 1)];
      const nextDeg = track.angles[Math.min(i, track.angles.length - 1)];
      let turnDeg = nextDeg - prevDeg;
      while (turnDeg > 180) turnDeg -= 360;
      while (turnDeg <= -180) turnDeg += 360;
      world.turnArrow(ctx, camera, cam, prop, toRad(prevDeg), toRad(turnDeg), CONFIG.world.arrowSize, {
        alpha,
      });
    }
  }

  // ── 判定大字（只读，清除在 frame() 里做）──────────────
  if (state.result) {
    const remain = state.resultUntil - performance.now();
    draw.hitText(ctx, W, H, state.result, Math.min(1, Math.max(0, remain) / (CONFIG.resultHoldMs * 0.4)));
  }

  // ★ 暂停面板要排在待机提示**前面**：两边的 return 谁先谁赢，
  //   待机时开设置（?paused=1）会被待机提示挡掉。
  if (state.paused) {
    // 主界面里打开设置时，背景是 main 那段动画 —— 所以画布必须**透明**：
    // 清掉而不是按黑色填，否则会把底下压在菜单层下面的视频挡死。
    // （画布这时被抬到菜单上面，见 setMenuSettings。）
    if (state.phase === 'idle') {
      // 背景 = main 的当前帧。画不出来（还没解码好）就退成纯黑，
      // 至少不会留下上一帧的残影。
      //
      // ★ 千万不要在这里 setTransform 重置画布变换 —— createCanvas 设的
      //   是高清屏缩放（dpr）。重置成单位矩阵之后，clearRect 只清掉左上角
      //   一小块、drawImage 也画在左上角，其余部分留着上一帧的世界画面，
      //   画面就成了「上面一条视频 + 下面半截游戏」。
      ctx.clearRect(0, 0, W, H);
      if (!drawMenuFrame(ctx, W, H)) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
      }
      setMenuSettings(true);
    }
    draw.pausedOverlay(ctx, W, H, {
      beat: renderBeat,
      time: Math.max(0, songTime),
      duration: audio.durationSec || 0,
      volume: userVolume,
      offsetMs: userOffsetMs,
      autoLatencyMs: audio.hardwareLatencySec * 1000,
    });
    return;
  }

  // 调音量 / 偏移的即时反馈。暂停面板里已经有数字了，就不再重复弹
  if (state.toast && Date.now() < state.toast.until && !state.paused) {
    draw.toast(ctx, W, H, state.toast.text);
  }

  if (state.phase === 'idle' && debugBeat === null) {
    draw.startPrompt(ctx, W, H, {
      title: '余光',
      lines: [
        `${state.chartName}　·　${chart.bpm} BPM　·　${chart.hitCount} 格`,
        '盲杖扫到发亮的那一格时按任意键',
        state.error ? `上次出错：${state.error}` : '',
      ].filter(Boolean),
      error: null,
      hint: '任意键 或 点击 开始　（Esc 先调设置）',
    });
    return;
  }

  const firstBeat = chart.segments[0].startBeat;
  const span = chart.durationBeats - firstBeat;
  draw.progressBar(ctx, W, span > 0 ? (renderBeat - firstBeat) / span : 0);

  draw.hud(ctx, W, H, {
    bpm: chart.bpm,
    msPerBeat: calcMsPerBeat(chart.bpm),
    windowsMs: {
      perfect: angleDegToMs(CONFIG.windows.perfect, c.ps.msPerTurn),
      good: angleDegToMs(CONFIG.windows.good, c.ps.msPerTurn),
      ok: angleDegToMs(CONFIG.windows.ok, c.ps.msPerTurn),
    },
    tileIndex: c.ps.index,
    hitCount: chart.hitCount,
    combo: state.combo,
    offsetMs: totalOffsetSec() * 1000,
    autoLatencyMs: audio.hardwareLatencySec * 1000,
    userOffsetMs,
    songTime,
    duration: audio.durationSec,
    beat: renderBeat,
    stats: state.stats,
    history: state.history,
  });

  if (state.phase === 'finished') {
    draw.finishedOverlay(ctx, W, H, { stats: state.stats, hitCount: chart.hitCount });
  }
}

// ── 启动 ────────────────────────────────────────────────────
layout();
window.addEventListener('resize', layout);
canvasEl.focus?.();
requestAnimationFrame(frame);

document.body.classList.add('ready');

// ── 主界面 ──────────────────────────────────────────────────
//
// ★ 带调试参数（?beat= / ?fade= / ?paused=1）时不建菜单 —— 否则那段视频会
//   盖在 canvas 上，写谱面时用 ?beat= 截图看到的永远是主界面。
try {
  if (debugBeat !== null || debugRevealR !== null) {
    // 调试模式：跳过主界面，直接进游戏画面
  } else {
  menu = createMenu({
    onStart: () => {
      start();
    },
    // 点 Setting 相当于局内 Esc：设置面板画在 canvas 上，
    // 所以不隐藏菜单，而是把两层上下翻过来 —— 这样背景就是 main 那段动画。
    onSettings: () => {
      state.paused = true;
      setMenuSettings(true);
    },
  });
  // 菜单视频一上来就用玩家存好的音量（设置面板调的就是这个值）
  menu?.setVolume(userVolume);
  }
} catch (err) {
  console.warn('[余光] 主界面创建失败（无 DOM 环境？），退回直接开始', err);
  menu = null;
}
loadLevel().then(() => {
  if (autostart) start();
});

// 挂到 window 上，方便在控制台里手动调
Object.assign(window, {
  YUGUANG: {
    CONFIG,
    state,
    audio,
    voice,
    world,
    get camera() {
      return state.camera;
    },
    get clock() {
      return clock;
    },
    get chart() {
      return state.chart;
    },
    start,
    restart,
    hit,
    loadLevel,
    judgeHit,
    characterAt,
    get userOffsetMs() {
      return userOffsetMs;
    },
    set userOffsetMs(v) {
      // 不用手动同步时钟了：totalOffsetSec 是作为函数传进 SongClock 的，
      // 它每次读都是现算的
      setOffsetMs(v);
    },
    get userVolume() {
      return userVolume;
    },
    set userVolume(v) {
      setVolume(v);
    },
    get paused() {
      return state.paused;
    },
    togglePause,
    get now() {
      return audio.now;
    },
  },
});
