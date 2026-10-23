/**
 * 地面假透视投影（俗称 mode 7）。
 *
 * 世界坐标：`x` 向右、`z` 向前（远离镜头），地面在 `y = 0`。
 * 镜头悬在地面上方 `camHeight` 处，水平向前看。地面上的点于是：
 *
 *     screenX = centerX + focal * lateral / ahead
 *     screenY = horizonY + focal * (camHeight - y) / ahead
 *
 * 这一条 `1 / ahead` 就是「用 2D 缩放模拟远近感」的全部内容：
 * ahead 越小（越近），屏幕位置越靠下、缩放越大。
 *
 * ── 为什么不用真 3D 矩阵 ────────────────────────────────────
 * 真 3D 需要俯仰角、视锥、近裁面、深度排序，而我们的世界只有一块**平地**
 * 和一个永远看向前方的镜头。上面两条公式就是它的精确解，没有近似。
 * 参数少、好调、算得快，而且坏了一眼就能看出来。
 *
 * 代价：镜头没有俯仰角，地平线是一条固定的水平线，抬头看不见「天空」。
 * 对「全黑画面 + 一条路」来说这正好——本来就没有天空可看。
 *
 * 这个文件是纯函数：不碰 Canvas、不碰全局状态，`cam` 每次传进来。
 */

export const DEG = Math.PI / 180;

/** 太近的点（在镜头后面或贴着镜头）投影会炸，直接丢掉 */
const NEAR_LIMIT = 0.2;

/**
 * @param {object} opts
 * @param {number} opts.width            视口宽（CSS 像素）
 * @param {number} opts.height           视口高
 * @param {number} opts.horizonRatio     地平线在屏幕上的高度比例（0 = 顶，1 = 底）
 * @param {number} opts.charScreenY      盲人脚下那个点落在屏幕的高度比例
 * @param {number} opts.charRadiusRatio  盲人（世界半径 1）在屏幕上的半径 ÷ 视口高
 * @param {number} opts.charDistance     盲人离镜头的距离（世界单位，越大透视越弱）
 */
export function createCamera({
  width,
  height,
  horizonRatio = 0.44,
  charScreenY = 0.66,
  charRadiusRatio = 0.028,
  charDistance = 13,
}) {
  const horizonY = horizonRatio * height;
  const centerX = width / 2;

  // 盲人在屏幕上要有 charRadiusRatio*height 那么大，而在 depth = charDistance 处
  // 缩放正好是 focal / charDistance，所以 focal 由这两个量反推。
  const focal = charRadiusRatio * height * charDistance;

  // 盲人脚下的点比地平线低这么多像素 = focal * camHeight / charDistance
  // → 反推镜头高度。注意：camHeight 只由三个比例决定，和 charDistance 无关。
  const camHeight = ((charScreenY - horizonRatio) * height) / (charRadiusRatio * height);

  return {
    width,
    height,
    centerX,
    horizonY,
    focal,
    camHeight,
    charDistance,

    /** 某个深度（离镜头的世界距离）处，1 个世界单位在屏幕上占多少像素 */
    scaleAt(ahead) {
      return ahead > NEAR_LIMIT ? focal / ahead : 0;
    },

    /**
     * 投影一个世界点。
     * @param {{x:number, y?:number, z:number}} p  y 省略时按地面（0）算
     * @param {{x:number, z:number, yaw:number}} cam
     * @returns {{x:number, y:number, ahead:number, scale:number}|null}
     *          在镜头后面时返回 null
     */
    project(p, cam) {
      const dx = p.x - cam.x;
      const dz = p.z - cam.z;
      const cos = Math.cos(cam.yaw);
      const sin = Math.sin(cam.yaw);

      // 转到镜头坐标系：lateral = 右，ahead = 前
      const lateral = dx * cos - dz * sin;
      const ahead = dx * sin + dz * cos;
      if (ahead <= NEAR_LIMIT) return null;

      const y = p.y ?? 0;
      return {
        x: centerX + (focal * lateral) / ahead,
        y: horizonY + (focal * (camHeight - y)) / ahead,
        ahead,
        scale: focal / ahead,
      };
    },

    /**
     * 画一个「躺在地面上」的精灵时用的变换矩阵。
     *
     * Canvas 的 drawImage 只能做仿射变换，没法做真正的透视变形。所以这里取
     * **投影在该点附近的局部线性近似**：分别量出「沿物体的右方向走 1 个单位」
     * 和「沿物体的前方向走 1 个单位」在屏幕上各走多远，拼成矩阵。
     *
     * 对盲道、井盖这种小物件，这个近似和真正的透视几乎没有差别。
     *
     * @param {{x:number,z:number}} pos   物体中心（地面坐标）
     * @param {number} worldYaw           物体的「前」方向（弧度）
     * @param {{x:number,z:number,yaw:number}} cam
     * @returns {{a:number,b:number,c:number,d:number,e:number,f:number,scale:number}|null}
     *          可直接交给 ctx.setTransform(a,b,c,d,e,f)
     */
    groundFrame(pos, worldYaw, cam) {
      const eps = 0.25;
      const cosY = Math.cos(worldYaw);
      const sinY = Math.sin(worldYaw);

      // 物体自身的右 / 前方向（和镜头的 yaw 用同一套约定）
      const rightX = cosY;
      const rightZ = -sinY;
      const fwdX = sinY;
      const fwdZ = cosY;

      const c = this.project(pos, cam);
      if (!c) return null;
      const r = this.project({ x: pos.x + rightX * eps, z: pos.z + rightZ * eps }, cam);
      const f = this.project({ x: pos.x + fwdX * eps, z: pos.z + fwdZ * eps }, cam);
      if (!r || !f) return null;

      // 局部坐标 (u = 右, v = 前) → 屏幕
      const dux = (r.x - c.x) / eps;
      const duy = (r.y - c.y) / eps;
      const dvx = (f.x - c.x) / eps;
      const dvy = (f.y - c.y) / eps;

      return {
        // 图片坐标 (ix, iy)：iy 向下，而 obj 的「前」是图片的上方，所以 iy 取负
        a: dux,
        b: duy,
        c: -dvx,
        d: -dvy,
        e: c.x,
        f: c.y,
        scale: c.scale,
      };
    },

    /** 一条世界直线投影后的两个端点（有一端在镜头后面时返回 null） */
    projectSegment(a, b, cam) {
      const pa = this.project(a, cam);
      const pb = this.project(b, cam);
      if (!pa || !pb) return null;
      return [pa, pb];
    },

    /** 地面上一个圆（比如井盖、脚下的圈）投影后的多边形点集 */
    projectGroundCircle(center, radius, cam, segments = 48) {
      const pts = [];
      for (let i = 0; i < segments; i++) {
        const t = (i / segments) * Math.PI * 2;
        const p = this.project(
          { x: center.x + Math.cos(t) * radius, z: center.z + Math.sin(t) * radius },
          cam,
        );
        if (!p) return null;
        pts.push(p);
      }
      return pts;
    },
  };
}

/** 把 yaw 之差规整到 (-π, π]，用于平滑转向 */
export function shortestAngle(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}
