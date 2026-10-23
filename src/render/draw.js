/**
 * 2D 界面层：文字、提示、HUD。
 *
 * 世界层（地面、盲道、盲人、井盖）在 `world.js` 里画，投影在 `camera.js` 里算。
 * 这个文件只负责**屏幕上不随透视变化的东西**。
 *
 * 只读输入、不写状态。判定大字的过期清除在 main.js 的 frame() 里做。
 */

import { CONFIG } from '../config.js';

const FONT = '"Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif';
const C = CONFIG.colors;

/** 带正负号的数字，用来显示偏移 / 角度差 */
function signed(v, digits = 1) {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;
}

export function clear(ctx, W, H) {
  ctx.fillStyle = C.background;
  ctx.fillRect(0, 0, W, H);
}

/**
 * 压暗整个画面。
 * 两个用途：叠提示层，以及那「一分钟渐渐变黑」。
 */
export function dim(ctx, W, H, alpha = 0.72) {
  const a = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 0;
  if (a <= 0) return;
  ctx.save();
  ctx.fillStyle = `rgba(0,0,0,${a})`;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

/** 判定结果大字。自动漏掉的 MISS 没有角度差可显示，只显示等级 */
export function hitText(ctx, W, H, result, alpha) {
  if (!result || alpha <= 0) return;
  const style = CONFIG.gradeStyle[result.grade] ?? CONFIG.gradeStyle.OK;
  const unit = Math.min(W, H);
  const cx = W / 2;
  const cy = H * 0.17;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = style.color;
  ctx.shadowColor = style.color;
  ctx.shadowBlur = unit * 0.045;
  ctx.font = `600 ${Math.round(unit * 0.046)}px ${FONT}`;
  ctx.fillText(style.text, cx, cy);

  ctx.shadowBlur = 0;
  if (typeof result.angleDiffDeg === 'number') {
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    ctx.font = `400 ${Math.round(unit * 0.021)}px ${FONT}`;
    const when = result.early ? '早' : '晚';
    ctx.fillText(
      `${signed(result.angleDiffDeg)}°　${when} ${Math.abs(result.timeDiffMs).toFixed(1)} ms`,
      cx,
      cy + unit * 0.048,
    );
  }
  ctx.restore();
}

/** 顶部的进度条，细得像一根线 */
export function progressBar(ctx, W, progress) {
  // 防御 NaN：一旦把 NaN 喂给 Canvas，同批绘制都会静默失效
  const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(0, 0, W, 2);
  ctx.fillStyle = 'rgba(255,255,255,0.30)';
  ctx.fillRect(0, 0, W * p, 2);
  ctx.restore();
}

/** 按字符数粗略折行（中文按 1 个字算，够用了） */
function wrapText(text, maxChars) {
  const lines = [];
  for (const para of String(text).split('\n')) {
    let cur = '';
    for (const ch of para) {
      cur += ch;
      if (cur.length >= maxChars) {
        lines.push(cur);
        cur = '';
      }
    }
    if (cur || lines.length === 0) lines.push(cur);
  }
  return lines;
}

/**
 * 全屏提示：加载中 / 待机 / 出错。
 * @param {{title:string, lines?:string[], error?:string|null, hint?:string}} data
 */
export function startPrompt(ctx, W, H, data) {
  const unit = Math.min(W, H);
  dim(ctx, W, H, 0.78);

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = W / 2;
  let y = H * 0.40;

  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.shadowColor = 'rgba(255,236,200,0.55)';
  ctx.shadowBlur = unit * 0.06;
  ctx.font = `300 ${Math.round(unit * 0.07)}px ${FONT}`;
  ctx.fillText(data.title, cx, y);

  ctx.shadowBlur = 0;
  y += unit * 0.095;

  ctx.font = `400 ${Math.round(unit * 0.021)}px ${FONT}`;
  for (const line of data.lines ?? []) {
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.fillText(line, cx, y);
    y += unit * 0.04;
  }

  if (data.error) {
    y += unit * 0.018;
    ctx.fillStyle = C.warn;
    ctx.font = `400 ${Math.round(unit * 0.02)}px ${FONT}`;
    const maxChars = Math.max(18, Math.floor((W * 0.8) / (unit * 0.02)));
    for (const chunk of wrapText(data.error, maxChars)) {
      ctx.fillText(chunk, cx, y);
      y += unit * 0.036;
    }
  }

  if (data.hint) {
    y += unit * 0.038;
    ctx.fillStyle = 'rgba(255,214,150,0.85)';
    ctx.font = `400 ${Math.round(unit * 0.025)}px ${FONT}`;
    ctx.fillText(data.hint, cx, y);
  }
  ctx.restore();
}

/** 曲终结算 */
export function finishedOverlay(ctx, W, H, data) {
  const unit = Math.min(W, H);
  dim(ctx, W, H, 0.82);

  const s = data.stats;
  const total = s.count || 0;
  const rows = [
    ['击打总数', `${total} / ${data.hitCount}`],
    ['连击', `${s.maxCombo}（最长）`],
    ['准确率', total ? `${((s.weighted / total) * 100).toFixed(1)}%` : '—'],
    ['平均角度差', total ? `${(s.sumAbs / total).toFixed(2)}°` : '—'],
    ['PERFECT', `${s.PERFECT}`],
    ['GOOD', `${s.GOOD}`],
    ['OK', `${s.OK}`],
    ['MISS', `${s.MISS}`],
  ];

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = W / 2;
  let y = H * 0.24;

  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.font = `300 ${Math.round(unit * 0.048)}px ${FONT}`;
  ctx.fillText('一曲终了', cx, y);

  y += unit * 0.07;
  ctx.font = `400 ${Math.round(unit * 0.022)}px ${FONT}`;
  for (const [label, value] of rows) {
    ctx.fillStyle = 'rgba(255,255,255,0.32)';
    ctx.textAlign = 'right';
    ctx.fillText(label, cx - unit * 0.012, y);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.textAlign = 'left';
    ctx.fillText(value, cx + unit * 0.012, y);
    y += unit * 0.036;
  }

  y += unit * 0.032;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,214,150,0.9)';
  ctx.font = `400 ${Math.round(unit * 0.025)}px ${FONT}`;
  ctx.fillText('空格 重来', cx, y);
  ctx.restore();
}

/** 一条小横条，用来把「音量 70%」这种数画成看得见的东西 */
function bar(ctx, x, y, w, h, ratio, color) {
  const r = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, Math.max(1, w * r), h);
}

/**
 * 暂停面板。
 *
 * 暂停时音乐停了、时间定格，正好拿来当设置界面 —— 音量和音画偏移
 * 都是**每台设备不一样**的东西（蓝牙耳机能差 200ms），
 * 玩家必须能自己调，而且调完要记得住。
 */
export function pausedOverlay(ctx, W, H, info) {
  const unit = Math.min(W, H);
  dim(ctx, W, H, 0.78);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = W / 2;
  let y = H * 0.30;

  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = `300 ${Math.round(unit * 0.055)}px ${FONT}`;
  ctx.fillText('已暂停', cx, y);

  y += unit * 0.062;
  ctx.fillStyle = 'rgba(255,255,255,0.42)';
  ctx.font = `400 ${Math.round(unit * 0.021)}px ${FONT}`;
  ctx.fillText(`第 ${info.beat.toFixed(2)} 拍　${info.time.toFixed(1)} / ${info.duration.toFixed(1)} 秒`, cx, y);

  // ── 设置 ──────────────────────────────────────────────
  const bw = Math.min(unit * 0.30, W * 0.36);
  const bh = Math.max(4, unit * 0.008);
  const labelX = cx - bw / 2 - unit * 0.018;
  const barX = cx - bw / 2;

  // 音量
  y += unit * 0.075;
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = `400 ${Math.round(unit * 0.022)}px ${FONT}`;
  ctx.fillText('音量', labelX, y);
  bar(ctx, barX, y - bh / 2, bw, bh, info.volume, 'rgba(255,214,150,0.85)');
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(`${Math.round(info.volume * 100)}%`, barX + bw + unit * 0.018, y);

  // 音画偏移
  y += unit * 0.055;
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText('音画偏移', labelX, y);
  // 偏移是 -500..500，以 0 为中心画
  const half = bw / 2;
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(barX, y - bh / 2, bw, bh);
  const k = Math.max(-1, Math.min(1, info.offsetMs / 250));
  ctx.fillStyle = 'rgba(143,214,255,0.85)';
  ctx.fillRect(k >= 0 ? half : half + half * k, y - bh / 2, Math.abs(half * k) || 1, bh);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fillRect(half - 1, y - bh * 1.2, 2, bh * 2.4); // 中线
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillText(
    `${info.offsetMs >= 0 ? '+' : '−'}${Math.abs(info.offsetMs).toFixed(0)} ms`,
    barX + bw + unit * 0.018,
    y,
  );

  y += unit * 0.030;
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.font = `400 ${Math.round(unit * 0.017)}px ${FONT}`;
  ctx.fillText(`（其中硬件自动补偿 ${info.autoLatencyMs.toFixed(0)} ms）`, cx, y);

  // ── 按键 ──────────────────────────────────────────────
  y += unit * 0.055;
  ctx.fillStyle = 'rgba(255,214,150,0.9)';
  ctx.font = `400 ${Math.round(unit * 0.024)}px ${FONT}`;
  ctx.fillText('Esc 继续', cx, y);

  y += unit * 0.038;
  ctx.fillStyle = 'rgba(255,255,255,0.40)';
  ctx.font = `400 ${Math.round(unit * 0.019)}px ${FONT}`;
  ctx.fillText('↑ ↓ 音量　·　← → 音画偏移（按住 Shift 精细调）　·　R 重来', cx, y);

  y += unit * 0.030;
  ctx.fillStyle = 'rgba(255,255,255,0.26)';
  ctx.font = `400 ${Math.round(unit * 0.017)}px ${FONT}`;
  ctx.fillText('调好会自动记住，下次打开还在', cx, y);

  ctx.restore();
}

/**
 * 屏幕下方的一条短提示（调音量 / 偏移时用）。
 *
 * 为什么必须有：设置项的改变**听感上不一定立刻分得出来**，
 * 玩家按了两下没感觉，只会当成「坏了」。给一行字，疑虑就没了。
 */
export function toast(ctx, W, H, text) {
  const unit = Math.min(W, H);
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `400 ${Math.round(unit * 0.026)}px ${FONT}`;
  const w = ctx.measureText(text).width + unit * 0.06;
  const h = unit * 0.055;
  const x = W / 2;
  const y = H * 0.86;

  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  ctx.beginPath();
  ctx.roundRect?.(x - w / 2, y - h / 2, w, h, h / 2);
  if (!ctx.roundRect) ctx.rect(x - w / 2, y - h / 2, w, h);
  ctx.fill();

  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(text, x, y);
  ctx.restore();
}

/**
 * 角落信息。
 * 左上＝节奏与进度，左下＝统计与最近成绩，右下＝操作提示。
 */
export function hud(ctx, W, H, data) {
  const unit = Math.min(W, H);
  const small = Math.max(11, Math.round(unit * 0.017));
  const pad = Math.round(unit * 0.032);
  const lineH = small * 1.55;

  ctx.save();
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.font = `400 ${small}px ${FONT}`;

  const w = data.windowsMs;
  const left = [
    { text: `BPM ${data.bpm}　每拍 ${data.msPerBeat.toFixed(0)} ms`, color: C.hud },
    {
      text: `砖块 ${Math.min(data.tileIndex + 1, data.hitCount)} / ${data.hitCount}　连击 ${data.combo}`,
      color: data.combo > 0 ? C.accent : C.hudDim,
    },
    {
      text: `本块窗口 ±${CONFIG.windows.perfect}° = ±${w.perfect.toFixed(1)} ms`,
      color: C.hudDim,
    },
    {
      text: `音频偏移 ${signed(data.offsetMs, 0)} ms　(硬件 ${data.autoLatencyMs.toFixed(0)} + 手动 ${signed(data.userOffsetMs, 0)})`,
      color: data.userOffsetMs === 0 ? C.hudDim : C.accent,
    },
  ];
  left.forEach((l, i) => {
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, pad, pad + i * lineH);
  });

  ctx.textAlign = 'right';
  const inLeadIn = data.songTime < 0;
  const right = [
    {
      text: inLeadIn
        ? `前奏 ${Math.abs(data.songTime).toFixed(1)} s`
        : `${data.songTime.toFixed(1)} / ${data.duration.toFixed(1)} s`,
      color: inLeadIn ? C.accent : C.hud,
    },
    { text: `第 ${data.beat.toFixed(2)} 拍`, color: C.hudDim },
  ];
  right.forEach((l, i) => {
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, W - pad, pad + i * lineH);
  });

  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  const total = data.stats.count;
  const avgAngle = total ? (data.stats.sumAbs / total).toFixed(2) : '—';
  const acc = total ? ((data.stats.weighted / total) * 100).toFixed(1) : '—';
  const statLines = [
    { text: `命中 ${total}　准确率 ${acc}%　平均 ${avgAngle}°`, color: C.hud },
    {
      text: `P ${data.stats.PERFECT}　G ${data.stats.GOOD}　OK ${data.stats.OK}　M ${data.stats.MISS}　空按 ${data.stats.ghost}`,
      color: C.hudDim,
    },
  ];
  statLines.forEach((l, i) => {
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, pad, H - pad - (statLines.length - 1 - i) * lineH);
  });

  // 最近几次的角度差，一眼看出自己是偏早还是偏晚
  if (data.history.length) {
    const bw = Math.max(2, unit * 0.004);
    const gap = bw * 2.2;
    const maxDeg = CONFIG.windows.ok;
    const baseX = pad;
    const baseY = H - pad - lineH * 2 - small * 1.9;
    const half = unit * 0.05;

    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(baseX, baseY);
    ctx.lineTo(baseX + gap * (data.history.length - 1) + bw, baseY);
    ctx.stroke();

    data.history.forEach((h, i) => {
      const style = CONFIG.gradeStyle[h.grade] ?? CONFIG.gradeStyle.OK;
      const x = baseX + i * gap;
      ctx.fillStyle = style.color;
      ctx.globalAlpha = 0.85;
      // 自动 MISS 没有角度差，用一个固定的小竖条表示
      const k = typeof h.angleDiffDeg === 'number' ? h.angleDiffDeg / maxDeg : 0;
      const barH = Math.max(1.5, Math.abs(Math.max(-1, Math.min(1, k))) * half);
      ctx.fillRect(x, baseY - barH, bw, barH);
      ctx.globalAlpha = 1;
    });
  }

  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = C.hudDim;
  ctx.font = `400 ${Math.max(10, small - 2)}px ${FONT}`;
  ctx.fillText('任意键 判定　·　Esc 暂停 / 设置　·　R 重来', W - pad, H - pad);

  ctx.restore();
}
