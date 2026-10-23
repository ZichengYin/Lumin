/**
 * 主界面层。
 *
 * 画面全部来自两段视频，三个按钮是**完全透明**的热区 ——
 * 不画任何 UI，位置直接对齐视频里已经画好的 Restart / Setting / Exit。
 * 唯一的变化是鼠标移上去时光标变成手型。
 *
 * 视频是 2304×1384。容器按同一比例贴合窗口（等比、留黑边），
 * 热区用**归一化坐标**挂在容器里，所以窗口怎么变都对得上。
 *
 * 流程：
 *   打开游戏 / 死亡重开 → 循环 main
 *   点 Restart         → 播一遍 restart，播完才进游戏
 *   点 Setting         → 相当于局内 Esc（由 main.js 决定怎么显示）
 *   点 Exit            → 网页端没有意义，先空着（以后做 exe 再接）
 *
 * ★ 两个坑（都踩过）：
 *
 *   ① **音频**。浏览器不允许未静音的视频自动播放，所以必须 `muted` 起播；
 *      但这样一来两段动画就都没声了。正确做法是**先静音起播，等玩家
 *      第一次点击/按键再解除静音** —— 反正他要点 Restart。
 *
 *   ② **衔接处黑屏**。不要在同一个 <video> 上换 `src`：加载期间元素是空的，
 *      画面会瞬间变黑。改成两个 video 叠着，restart 那个提前预载好，
 *      切换时只是换显示层，中间没有空帧。
 */

const VW = 2304;
const VH = 1384;

/**
 * 视频地址。目录名是中文，用 encodeURI 拼，别手写百分号。
 *
 * ★ 必须是**相对路径**（开头没有 `/`）。
 *   `index.html` 在项目根目录，src/ 在下一层，所以从 menu.js 出发是 `../assets/…`。
 *   写成 `/assets/…` 在本地服务器上能用，但 GitHub Pages 的项目站是
 *   `https://<用户名>.github.io/<仓库名>/` —— 绝对路径会解析到根域名，
 *   直接 404，主界面一片黑。
 */
const MAIN_SRC = `../${encodeURI('assets/images/动画/main.mp4')}`;
const INTRO_SRC = `../${encodeURI('assets/images/动画/restart.mp4')}`;

/**
 * 三个菜单项在画面里的位置（归一化到视频尺寸）。
 *
 * 照着 main.mp4 的画面定的：
 *   Restart 文字中线 y≈0.557、Setting y≈0.693、Exit y≈0.817
 * 上下各留 0.045 当点击容差。想调就改这里。
 */
export const SPOTS = {
  restart: { x: 0.625, y: 0.512, w: 0.215, h: 0.09 },
  setting: { x: 0.625, y: 0.648, w: 0.215, h: 0.09 },
  exit: { x: 0.625, y: 0.772, w: 0.215, h: 0.09 },
};

function makeVideo(src, { loop }) {
  const v = document.createElement('video');
  v.muted = true; // 静音才能自动播放，见文件头 ①
  v.loop = loop;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = src;
  v.style.cssText =
    'position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:fill';
  return v;
}

/**
 * @param {{onStart: () => void|Promise<void>, onSettings: () => void}} hooks
 */
export function createMenu({ onStart, onSettings }) {
  const root = document.createElement('div');
  root.id = 'menu';
  root.style.cssText = [
    'position:fixed',
    'inset:0',
    'display:grid',
    'place-items:center',
    'background:#000',
    'z-index:10',
  ].join(';');

  const inner = document.createElement('div');
  inner.style.cssText = 'position:relative;overflow:hidden';
  root.appendChild(inner);

  // 两段视频叠着，切换只改显示，不换 src —— 见文件头 ②
  const mainVideo = makeVideo(MAIN_SRC, { loop: true });
  const introVideo = makeVideo(INTRO_SRC, { loop: false });
  introVideo.style.display = 'none';
  inner.appendChild(mainVideo);
  inner.appendChild(introVideo);

  /** 玩家是否已经交互过（决定能不能解除静音） */
  let unmuted = false;

  /**
   * 第一次点击/按键时解除静音。
   *
   * ★ 光把 `muted` 置成 false **不够**：这个 <video> 是页面一开就带着
   *   muted 自动播放的，Chromium 已经把它当成「允许无声自动播放」的那一类，
   *   中途解除静音并不会真的把音频输出接上去 —— 表现就是**主界面始终没声音**，
   *   而 restart（点击后才 play 的）却有声音。
   *
   *   所以解除静音之后要**重新 play 一次**：暂停 → 记住位置 → 复位 → 起播。
   *   位置保留，所以画面上不会跳。
   */
  function unlockAudio() {
    if (unmuted) return;
    unmuted = true;
    window.removeEventListener('pointerdown', unlockAudio, true);
    window.removeEventListener('keydown', unlockAudio, true);

    mainVideo.muted = false;
    introVideo.muted = false;

    if (mainVideo.style.display !== 'none') {
      const at = mainVideo.currentTime;
      mainVideo.pause();
      mainVideo.currentTime = at;
      mainVideo.play().catch(() => {});
    }
  }
  window.addEventListener('pointerdown', unlockAudio, true);
  window.addEventListener('keydown', unlockAudio, true);

  /** 正在播过渡动画时，热区全部失效 */
  let busy = false;

  function buildHotspot(name, s) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.spot = name;
    b.setAttribute('aria-label', name);
    b.style.cssText = [
      'position:absolute',
      `left:${s.x * 100}%`,
      `top:${s.y * 100}%`,
      `width:${s.w * 100}%`,
      `height:${s.h * 100}%`,
      'background:none',
      'border:0',
      'padding:0',
      'margin:0',
      'outline:none',
      'cursor:pointer',
      'z-index:2',
    ].join(';');
    b.addEventListener('click', () => activate(name));
    return b;
  }

  const buttons = Object.entries(SPOTS).map(([name, s]) => {
    const b = buildHotspot(name, s);
    inner.appendChild(b);
    return b;
  });

  function setButtonsEnabled(on) {
    for (const b of buttons) b.style.pointerEvents = on ? 'auto' : 'none';
  }

  /** 容器贴合窗口：等比缩放，不留变形 */
  function fit() {
    const s = Math.min(window.innerWidth / VW, window.innerHeight / VH);
    inner.style.width = `${Math.round(VW * s)}px`;
    inner.style.height = `${Math.round(VH * s)}px`;
  }
  window.addEventListener('resize', fit);
  fit();

  /** 回到循环播放的 main */
  function show() {
    busy = false;
    setButtonsEnabled(true);
    root.style.display = 'grid';
    introVideo.pause();
    introVideo.style.display = 'none';
    mainVideo.style.display = 'block';
    mainVideo.play().catch(() => {});
  }

  function hide() {
    root.style.display = 'none';
    mainVideo.pause();
    introVideo.pause();
  }

  /**
   * 点 Restart：播一遍 restart.mp4，播完才进游戏。
   *
   * 播完之后 **等 onStart() 真正完成再隐藏菜单** —— 否则会有一段黑屏：
   * start() 要加载音频和谱面，那期间 canvas 还没东西可画。让菜单的最后
   * 一帧继续停在屏幕上，视觉上是「动画 → 游戏」，中间没有空档。
   */
  function playIntro() {
    if (busy) return;
    busy = true;
    setButtonsEnabled(false);

    introVideo.style.display = 'block';
    mainVideo.style.display = 'none';
    mainVideo.pause();

    introVideo.currentTime = 0;
    introVideo.play().catch(() => {
      // 连开场动画都播不了就别卡住玩家
      finish();
    });

    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      introVideo.removeEventListener('ended', finish);
      introVideo.pause();
      void Promise.resolve(onStart())
        .catch(() => {})
        .finally(() => {
          hide();
        });
    }
    introVideo.addEventListener('ended', finish);
  }

  function activate(name) {
    if (busy) return;
    if (name === 'restart') playIntro();
    else if (name === 'setting') {
      hide();
      onSettings();
    }
    // exit：网页端没有意义。留着位置，以后做 exe 再接
  }

  document.body.appendChild(root);
  show();

  /**
   * 尽量一上来就有声：先试**不静音**直接播。
   *
   * 浏览器平时会拒绝（自动播放策略），那就退回静音播放、等第一次
   * 点击/按键再解锁。但如果游戏是用 `启动游戏.bat` 打开的 ——
   * 那边给浏览器加了 `--autoplay-policy=no-user-gesture-required` ——
   * 这一次就会成功，主界面从第一帧就有声音。
   *
   * 所以这里不是「看浏览器脸色」，而是先用参数把条件造出来，再顺手试一次。
   */
  (async () => {
    mainVideo.muted = false;
    introVideo.muted = false;
    try {
      await mainVideo.play();
      unmuted = true;
      window.removeEventListener('pointerdown', unlockAudio, true);
      window.removeEventListener('keydown', unlockAudio, true);
    } catch {
      mainVideo.muted = true;
      introVideo.muted = true;
      mainVideo.play().catch(() => {});
    }
  })();

  return {
    show,
    hide,
    playIntro,
    /**
     * 拿到主界面那个 <video>。
     *
     * 设置面板要把它的**当前帧**画进 canvas —— 这样「视频在下、面板在上」
     * 的顺序是画出来的，不依赖 z-index 层叠，也就不会再有层级翻不过去的问题。
     */
    frameSource() {
      return mainVideo;
    },
    /**
     * 「隐身」：不用 `display:none`，只设 `opacity:0`。
     *
     * 因为 `display:none` 的 <video> 有些浏览器会停止解码，
     * 那时 `drawImage` 拿到的是空白，背景又变黑了。
     * 设成透明则视频继续播，帧还是可用的。
     */
    ghost(on) {
      root.style.opacity = on ? '0' : '1';
      root.style.pointerEvents = on ? 'none' : 'auto';
    },
    /** 把菜单压到 canvas 下面（旧方案，保留但默认不用） */
    setBehind(on) {
      root.style.zIndex = on ? '0' : '10';
    },
    /**
     * 玩家音量（0~1）**也管菜单视频**。
     *
     * 设置面板里调的音量对主界面同样生效 —— 否则会出现「在设置里调小了，
     * 回主界面声音又变回原来那么响」，玩家会以为设置没存住。
     */
    setVolume(v) {
      const k = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1));
      mainVideo.volume = k;
      introVideo.volume = k;
    },
    get visible() {
      return root.style.display !== 'none';
    },
    get busy() {
      return busy;
    },
    get unmuted() {
      return unmuted;
    },
    /** 调试用：拿到吸到画面上的实际热区（截图核对位置用） */
    _debugRects() {
      return buttons.map((b) => {
        const r = b.getBoundingClientRect();
        return { name: b.dataset.spot, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      });
    },
  };
}
