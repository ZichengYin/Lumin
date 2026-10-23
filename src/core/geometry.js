/**
 * 纯几何 / 角度工具。
 *
 * 这个文件不依赖浏览器、不依赖 Canvas，可以直接在 Node 里跑测试。
 * 屏幕坐标系：x 向右，y 向 *下*，所以角度 0° 指右、90° 指下、-90° 指上。
 */

export const TAU = Math.PI * 2;

export const toDeg = (rad) => (rad * 180) / Math.PI;
export const toRad = (deg) => (deg * Math.PI) / 180;

/** 把角度规整到 (-π, π]，即「最短的那一边」 */
export function wrapRad(a) {
  let x = a % TAU;
  if (x <= -Math.PI) x += TAU;
  if (x > Math.PI) x -= TAU;
  return x;
}

/** 把角度规整到 (-180°, 180°] */
export function wrapDeg(d) {
  return toDeg(wrapRad(toRad(d)));
}

/** 从点 a 指向点 b 的方向角（弧度） */
export function angleTo(a, b) {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/** 极坐标 → 直角坐标 */
export function polar(center, radius, angleRad) {
  return {
    x: center.x + radius * Math.cos(angleRad),
    y: center.y + radius * Math.sin(angleRad),
  };
}

export function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function dist(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** 沿方向角偏移一段距离 */
export function offset(from, angleRad, length) {
  return {
    x: from.x + Math.cos(angleRad) * length,
    y: from.y + Math.sin(angleRad) * length,
  };
}
