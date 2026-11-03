/**
 * 序章 · 视觉小说播放器。
 *
 * 只在**第一次**从主界面点 Restart 时播放一次，之后（含死亡重开、刷新）都跳过。
 * 「第一次」记在 localStorage 里。
 *
 * ── 播放规则 ──────────────────────────────────────────────
 *   一张图占满屏幕（等比缩放、留黑边）
 *   点击或按任意键 → 下一张（中间 0.2s 淡出淡入）
 *   flashBlack: true 的页 → 先黑屏 0.5 秒，再显示图片
 *   最后一张之后 → 结束，进入游戏
 *
 *
 * ── 怎么加图片 ────────────────────────────────────────────
 *   图片放 assets/images/vn/，然后在 PAGES 里按顺序加一条：
 *     { image: 'assets/images/vn/16.png' }
 *
 * ── 怎么加音频 ────────────────────────────────────────────
 *   音频放 assets/audio/vn/，在对应页填 audio：
 *     { image: '...', audio: 'assets/audio/vn/01.mp3' }
 *   会在**这张图出现时**开始播，切下一页自动停。
 */

const STORAGE_KEY = 'yuguang.prologuePlayed';

/**
 * 每一页。
 *   image      图片路径；null = 纯黑页
 *   flashBlack 先黑屏 0.5 秒再显示图片
 *   audio      这一页的音效（可省略）
 */
export const PAGES = [
  { image: 'assets/images/vn/01.png' },
  { image: 'assets/images/vn/02.png' },
  { black: true, text: '我真的想好了，我还是想学美术', typeSec: 0.1 },
  { image: 'assets/images/vn/04.png' },
  { image: 'assets/images/vn/05.png' },
  { image: 'assets/images/vn/06.png' },
  { image: 'assets/images/vn/07.png' },
  { black: true, text: '你能不能成熟一点', typeSec: 0.1 },
  { image: 'assets/images/vn/09.png', flashBlack: true },
  { image: 'assets/images/vn/10.png', flashBlack: true },
  { image: 'assets/images/vn/11.png', flashBlack: true },
  { image: 'assets/images/vn/12.png' },
  { image: 'assets/images/vn/13.png' },
  { image: 'assets/images/vn/14.png' },
  { image: 'assets/images/vn/15.png' },
  { image: 'assets/images/vn/16.png' },
  { image: 'assets/images/vn/17.png' },
  { image: 'assets/images/vn/18.png' },
  { image: 'assets/images/vn/19.png' },
  // 最后的选择页：背景 20.png，上方「请选择」，下方左右两个选项（黑白 UI）
  {
    choice: true,
    image: 'assets/images/vn/20.png',
    title: '请选择导航路线',
    options: ['安全路线', '最快路线'],
  },
];

/** 看过没有。localStorage 不可用（隐私模式）时当作已看过，别反复放。 */
export function shouldPlayPrologue() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '1';
  } catch {
    return false;
  }
}

export function markProloguePlayed() {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // 存不了就算了
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

export function playPrologue({ pages = PAGES } = {}) {
  return new Promise((resolve) => {
    if (!pages.length) {
      resolve();
      return;
    }

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
      // ★ 绝对定位铺满整个遮罩层，再用 object-fit:contain 装进去。
      //   之前用 max-width/max-height 在 grid 里算高度的，有时会把下边缘裁掉。
      //   这套写法保证：整张图完整、按原始宽高比、四周留黑边，绝不裁切。
      'position:absolute',
      'inset:0',
      'width:100%',
      'height:100%',
      'object-fit:contain',
      'object-position:center',
      'display:block',
      'opacity:1',
      'transition:opacity 0.28s ease',
      'user-select:none',
      '-webkit-user-drag:none',
    ].join(';');
    root.appendChild(img);

    // ── 黑屏打字层：白色黑体，居中 ────────────────────
    const typeLayer = document.createElement('div');
    typeLayer.style.cssText = [
      'position:absolute',
      'inset:0',
      'display:grid',
      'place-items:center',
      'padding:0 10%',
      'color:#fff',
      'font-family:"Microsoft YaHei","PingFang SC","Heiti SC",sans-serif',
      'font-weight:700',
      'line-height:1.9',
      'text-align:center',
      'white-space:pre-wrap',
      'word-break:break-word',
      'pointer-events:none',
      'opacity:0',
      'transition:opacity 0.25s ease',
    ].join(';');
    root.appendChild(typeLayer);

    // ── 选择页 UI：黑白，极简 ────────────────────────
    const choiceLayer = document.createElement('div');
    choiceLayer.style.cssText = [
      'position:absolute',
      'inset:0',
      'display:none',
      'flex-direction:column',
      'align-items:center',
      'justify-content:space-between',
      'padding:9% 8%',
      'color:#fff',
      'font-family:"Microsoft YaHei","PingFang SC","Heiti SC",sans-serif',
      'font-weight:700',
      'pointer-events:none',
      'opacity:0',
      'transition:opacity 0.3s ease',
    ].join(';');

    const choiceTitle = document.createElement('div');
    // 这张背景是白的，所以标题用黑字；选项按钮反过来（深底白字）
    choiceTitle.style.cssText = 'font-size:2em;letter-spacing:0.35em;color:#000;font-weight:700;';
    choiceLayer.appendChild(choiceTitle);

    const choiceRow = document.createElement('div');
    choiceRow.style.cssText = 'display:flex;gap:8%;width:100%;justify-content:center;pointer-events:auto;';
    choiceLayer.appendChild(choiceRow);
    root.appendChild(choiceLayer);

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
    requestAnimationFrame(() => {
      root.style.opacity = '1';
    });

    // ── 状态 ──────────────────────────────────────────────
    let index = 0;
    let busy = false;
    /** @type {HTMLAudioElement|null} */
    let audio = null;
    let done = false;
    let flashTimer = 0;
    // 打字机状态：全文、已打几个字、定时器
    let typeText = '';
    let typeAt = 0;
    let typeTimer = 0;
    let typeSpeed = 90;

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

    /** 把已经打出来的部分显示出来 */
    function renderTyped() {
      typeLayer.textContent = typeText.slice(0, typeAt);
    }

    /** 立刻打完（点击时用） */
    function finishTyping() {
      clearTimeout(typeTimer);
      typeTimer = 0;
      typeAt = typeText.length;
      renderTyped();
    }

    /** 开始逐个打字 */
    function startTyping(text, typeSec) {
      clearTimeout(typeTimer);
      typeText = text;
      typeAt = 0;
      typeSpeed = Math.max(20, Math.round((typeSec ?? 0.09) * 1000));
      typeLayer.style.fontSize = `${Math.max(18, Math.round(window.innerHeight * 0.034))}px`;
      typeLayer.style.opacity = '1';
      renderTyped();
      // 标点之后多停一下 —— 读完一句再往下打，节奏才不会一格一格地往前冲
      const PAUSE_AFTER = '，,。.、；;：:！!？?…—';
      const step = () => {
        if (typeAt >= typeText.length) { typeTimer = 0; return; }
        const ch = typeText[typeAt];
        typeAt += 1;
        renderTyped();
        // 刚打出来的这个字是标点 → 额外等一会儿
        const extra = PAUSE_AFTER.includes(ch) ? typeSpeed * 2.6 : 0;
        typeTimer = setTimeout(step, typeSpeed + extra);
      };
      typeTimer = setTimeout(step, typeSpeed);
    }

    /** 记下玩家的选择，供后续分支使用 */
    function recordChoice(v) {
      try {
        localStorage.setItem('yuguang.route', v);
      } catch {
        // 存不了也无所谓
      }
      window.YUGUANG_CHOICE = v;
      if (window.YUGUANG) window.YUGUANG.route = v;
    }

    /** 显示选择页。点了某个选项就翻到下一页（也就是结束序章） */
    function showChoice(page) {
      choiceTitle.textContent = page.title ?? '请选择';
      choiceTitle.style.fontSize = `${Math.max(18, Math.round(window.innerHeight * 0.03))}px`;
      choiceRow.innerHTML = '';
      (page.options ?? []).forEach((label) => {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.style.cssText = [
          'flex:1 1 0',
          'max-width:34%',
          'padding:0.9em 0',
          'background:rgba(0,0,0,0.55)',
          'border:1.5px solid rgba(255,255,255,0.85)',
          'border-radius:2px',
          'color:#fff',
          'font:inherit',
          'font-size:1em',
          'font-weight:700',
          'letter-spacing:0.12em',
          'cursor:pointer',
          `font-size:${Math.max(15, Math.round(window.innerHeight * 0.022))}px`,
        ].join(';');
        btn.addEventListener('pointerdown', (e) => {
          e.stopPropagation();   // 别让遮罩层把这次点击当成「翻页」
        });
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (busy || done) return;
          recordChoice(label);
          advance();
        });
        choiceRow.appendChild(btn);
      });
      choiceLayer.style.display = 'flex';
      choiceLayer.style.opacity = '1';
    }

    function showPage(i) {
      const page = pages[i];
      if (!page) return;
      hint.textContent = `${i + 1} / ${pages.length}`;

      stopAudio();

      // 选择页：背景图 + 两个按钮，点了才翻页
      if (page.choice) {
        img.src = page.image ?? '';
        img.style.visibility = page.image ? 'visible' : 'hidden';
        img.style.opacity = '1';
        clearTimeout(typeTimer);
        typeTimer = 0;
        typeLayer.style.opacity = '0';
        hint.textContent = `${i + 1} / ${pages.length}`;
        showChoice(page);
        return;
      }
      choiceLayer.style.display = 'none';
      choiceLayer.style.opacity = '0';

      // 黑屏打字页：不出图，只打字
      if (page.black) {
        img.style.visibility = 'hidden';
        img.style.opacity = '0';
        startTyping(page.text ?? '', page.typeSec);
        return;
      }
      clearTimeout(typeTimer);
      typeTimer = 0;
      typeLayer.style.opacity = '0';
      typeText = '';
      typeAt = 0;

      const reveal = () => {
        img.src = page.image ?? '';
        img.style.visibility = page.image ? 'visible' : 'hidden';
        img.style.opacity = '1';
      };

      if (page.flashBlack) {
        // 先黑屏 0.5 秒，再出图
        img.style.opacity = '0';
        img.style.visibility = 'hidden';
        flashTimer = setTimeout(reveal, 500);
      } else {
        reveal();
      }

      if (page.audio) {
        audio = new Audio(page.audio);
        audio.play().catch(() => {});
      }
    }

    function finish() {
      if (done) return;
      done = true;
      clearTimeout(flashTimer);
      clearTimeout(typeTimer);
      stopAudio();
      window.removeEventListener('keydown', onKey, true);
      root.removeEventListener('pointerdown', onAdvance);
      root.style.opacity = '0';
      setTimeout(() => {
        root.remove();
        resolve();
      }, 360);
    }

    function advance() {
      if (busy || done) return;
      busy = true;
      clearTimeout(flashTimer);
      clearTimeout(typeTimer);
      typeTimer = 0;
      img.style.opacity = '0';
      setTimeout(() => {
        index += 1;
        if (index >= pages.length) {
          finish();
          return;
        }
        showPage(index);
        busy = false;
      }, 200);
    }

    function onAdvance(e) {
      e?.preventDefault?.();
      advance();
    }

    function onKey(e) {
      e.preventDefault?.();
      e.stopPropagation?.();
      if (e.repeat) return;
      advance();
    }

    showPage(0);
    root.addEventListener('pointerdown', onAdvance);
    window.addEventListener('keydown', onKey, true);
  });
}
