/**
 * Canvas 初始化：处理高分屏缩放（devicePixelRatio）。
 *
 * 不处理这一步的话，在 125% / 150% 缩放的 Windows 上画面会糊。
 */

export function createCanvas(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let width = 0;
  let height = 0;

  function resize() {
    // 上限 2 倍，再高只是白烧 GPU
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = canvas.clientWidth || window.innerWidth;
    height = canvas.clientHeight || window.innerHeight;

    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    // 之后所有绘图都用 CSS 像素坐标，不用自己乘 dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  resize();
  window.addEventListener('resize', resize);

  return {
    ctx,
    resize,
    get width() {
      return width;
    },
    get height() {
      return height;
    },
  };
}

/** 画圆角矩形，老浏览器没有 roundRect 时退化成直角矩形 */
export function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
