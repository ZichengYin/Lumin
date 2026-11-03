/**
 * 序章 · 视觉小说播放器。
 *
 * 只在**第一次**从主界面点 Restart 时播放一次，之后（包括死亡重开）都跳过。
 * 「第一次」记在 localStorage 里，所以刷新页面、关掉再打开也都算已经看过。
 *
 * 播放规则：
 *   一张图占满屏幕（等比缩放，留黑边）
 *   点击或按任意键 → 下一张
 *   最后一张之后再按一次 → 结束，进入游戏
 *
 * ── 怎么加图片 ────────────────────────────────────────────
 *   1. 把图片放进 assets/images/vn/
 *   2. 在下面的 PAGES 数组里按顺序加一条 { image: 'assets/images/vn/xx.png' }
 *   文件名建议 01、02、03… 两位数字，这样在资源管理器里也是按顺序排的。
 *
 * ── 怎么加音频 ────────────────────────────────────────────
 *   1. 音频放进 assets/audio/vn/
 *   2. 对应那一页填上 audio：{ image: '...', audio: 'assets/audio/vn/xx.mp3' }
 *   音频会在**这张图出现的瞬间**开始播，切下一页时自动停掉。
 *   留 null 就是这一页没有声音（现在的状态）。
 */

const STORAGE_KEY = 'yuguang.prologuePlayed';

/** 每一页：一张图 + 可选音频（按顺序播放） */
export const PAGES = [
  { image: 'assets/images/vn/01.png', audio: null },
  { image: 'assets/images/vn/02.png', audio: null },
  { image: 'assets/images/vn/03.png', audio: null },
  { image: 'assets/images/vn/04.png', audio: null },
  { image: 'assets/images/vn/05.png', audio: null },
  { image: 'assets/images/vn/06.png', audio: null },
  { image: 'assets/images/vn/07.png', audio: null },
  { image: 'assets/images/vn/08.png', audio: null },
  { image: 'assets/images/vn/09.png', audio: null },
  { image: 'assets/images/vn/10.png', audio: null },
  { image: 'assets/images/vn/11.png', audio: null },
  { image: 'assets/images/vn/12.png', audio: null },
  { image: 'assets/images/vn/13.png', audio: null },
  { image: 'assets/images/vn/14.png', audio: null },
  { image: 'assets/images/vn/15.png', audio: null },
];

/** 看过没有。localStorage 不可用（隐私模式）时当作「已看过」，不要反复放。 */
export function shouldPlayPrologue() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '1';
  } catch {
    return false;
  }
}

/** 记下已经看过 */
export function markProloguePlayed() {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // 存不了就算了，最坏情况是下次又放一遍
  }
}

/** 调试用：清掉记录，下次点 Restart 会重新走一遍序章 */
export function resetPrologue() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 同上
  }
}

/**
 * 播一遍序章。返回 Promise，序章结束（或被跳过）时 resolve。
 *
 * @param {{pages?: typeof PAGES}} [opts]
 */
export function playPrologue({ pages = PAGES } = {}) {
  return new Promise((resolve) => {
    if (!pages.length) {
      resolve();
      return;
    }

    // ── DOM ────────────────────────────────────────────
    const root = document.createElement('div');
    root.id = 'prologue';
    root.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:200',
      'background:#000',
      'display:grid',
      'place-items:center',
      'cursor:pointer',
      'opacity:0',
      'transition:opacity 0.35s ease',
    ].join(';');

    const img = document.createElement('img');
    img.style.cssText = [
      'max-width:100%',
      'max-height:100%',
      'object-fit:contain',
      'display:block',
      'opacity:1',
      'transition:opacity 0.28s ease',
      'user-select:none',
      '-webkit-user-drag:none',
    ].join(';');
    root.appendChild(img);

    // 角落的页码提示，很淡，不抢画面
    const hint = document.createElement('div');
    hint.style.cssText = [
      'position:absolute',
      'right:20px',
      'bottom:16px',
      'color:rgba(255,255,255,0.28)',
      'font:12px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
      'letter-spacing:0.06em',
      'pointer-events:none',
    ].join(';');
    root.appendChild(hint);

    document.body.appendChild(root);
    // 下一帧再设 opacity，确保过渡真的跑起来
    requestAnimationFrame(() => {
      root.style.opacity = '1';
    });

    // ── 状态 ────────────────────────────────────────────
    let index = 0;
    let busy = false;
    /** @type {HTMLAudioElement|null} */
    let audio = null;
    let done = false;

    function stopAudio() {
      if (!audio) return;
      try {
        audio.pause();
        audio.currentTime = 0;
      } catch {
        // 无视
      }
      audio = null;
    }

    function showPage(i) {
      const page = pages[i];
      if (!page) return;
      img.src = page.image ?? '';
      hint.textContent = `${i + 1} / ${pages.length}`;

      stopAudio();
      if (page.audio) {
        audio = new Audio(page.audio);
        audio.play().catch(() => {
          // 浏览器可能不许自动播；序章是点击驱动的，所以这里失败也不拦着
        });
      }
    }

    function finish() {
      if (done) return;
      done = true;
      stopAudio();
      window.removeEventListener('keydown', onKey, true);
      root.removeEventListener('pointerdown', onAdvance);
      root.style.opacity = '0';
      setTimeout(() => {
        root.remove();
        resolve();
      }, 360);
    }

    /** 切下一张。中间用一次短暂的淡出，避免硬切 */
    function advance() {
      if (busy || done) return;
      busy = true;
      img.style.opacity = '0';
      setTimeout(() => {
        index += 1;
        if (index >= pages.length) {
          finish();
          return;
        }
        showPage(index);
        img.style.opacity = '1';
        busy = false;
      }, 200);
    }

    function onAdvance(e) {
      e?.preventDefault?.();
      advance();
    }

    function onKey(e) {
      // 序章期间吃掉所有按键，免得顺手触发游戏的判定
      e.preventDefault?.();
      e.stopPropagation?.();
      if (e.repeat) return;
      advance();
    }

    showPage(0);
    root.addEventListener('pointerdown', onAdvance);
    // 捕获阶段 + 阻止冒泡：否则同一下按键会同时被游戏和主菜单收到
    window.addEventListener('keydown', onKey, true);
  });
}
