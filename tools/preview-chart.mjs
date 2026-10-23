/**
 * 谱面预览器 —— 在终端里看形状和节奏，不用开浏览器。
 *
 *   node tools/preview-chart.mjs levels/level01.json
 *   node tools/preview-chart.mjs levels/level01.json --width 100
 *
 * 做谱面时最有用的一个工具：改完角度先跑一遍，看轨迹有没有自交、
 * 落点是不是落在想要的拍上、有没有哪一块转得特别离谱。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChart, hitPoint, verifyChart } from '../src/core/chart.js';
import { toDeg } from '../src/core/geometry.js';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const positional = argv.filter((a) => !a.startsWith('--'));
const file = resolve(ROOT, positional[0] ?? 'levels/level01.json');
const PLOT_WIDTH = Number(argOf('--width', 76));

const raw = JSON.parse(readFileSync(file, 'utf8'));
const chart = buildChart(raw);

// ── 一致性自检 ──────────────────────────────────────────────
const problems = verifyChart(chart);
if (problems.length) {
  console.error('谱面自检不通过：');
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}

console.log(`谱面 ${file.replace(ROOT + '\\', '')}`);
console.log(
  `  ${chart.bpm} BPM　${chart.timing}　方向 ${chart.direction > 0 ? '极角递增' : '递减'}　` +
    `${chart.tileCount} 块砖 / ${chart.hitCount} 次击打`,
);
console.log(
  `  时长 ${chart.durationBeats.toFixed(2)} 拍 = ${((chart.durationBeats * chart.beatMs) / 1000).toFixed(1)} 秒` +
    `　（前奏 ${(-chart.segments[0].startBeat).toFixed(2)} 拍）`,
);
console.log(`  自检：${chart.hitCount} 段全部首尾相接 ✔`);

// ── 每一段 ──────────────────────────────────────────────────
console.log('\n  #   方向     转动    拍数    落点(拍)   一圈ms   判定窗口±22.5°');
console.log('  ' + '─'.repeat(70));
for (const s of chart.segments) {
  const windowMs = (22.5 / 360) * s.msPerTurn;
  console.log(
    `  ${String(s.index).padStart(2)}  ${String(s.targetAngleDeg).padStart(6)}°  ` +
      `${s.sweep.toFixed(0).padStart(4)}°  ${s.beats.toFixed(2).padStart(6)}  ` +
      `${s.hitBeat.toFixed(2).padStart(8)}  ${s.msPerTurn.toFixed(0).padStart(7)}  ` +
      `${windowMs.toFixed(1).padStart(8)} ms`,
  );
}

// ── ASCII 轨迹图 ────────────────────────────────────────────
// 屏幕坐标 y 向下，和实际渲染一致；终端里也向下，所以不用翻转。
const { bounds, positions } = chart;
const cols = Math.max(8, Math.min(200, Math.round(PLOT_WIDTH)));
const rows = Math.max(4, Math.round((cols * (bounds.height + 1)) / ((bounds.width + 1) * 2)));

const grid = Array.from({ length: rows + 1 }, () => Array(cols + 1).fill(' '));

const toCell = (p) => ({
  cx: Math.round(((p.x - bounds.minX) / Math.max(1e-9, bounds.width || 1)) * cols),
  cy: Math.round(((p.y - bounds.minY) / Math.max(1e-9, bounds.height || 1)) * rows),
});

// 先画轨道连线（Bresenham 太细，这里做粗一点的插值）
for (let i = 0; i < positions.length - 1; i++) {
  const a = toCell(positions[i]);
  const b = toCell(positions[i + 1]);
  const steps = Math.max(Math.abs(b.cx - a.cx), Math.abs(b.cy - a.cy), 1);
  for (let k = 0; k <= steps; k++) {
    const cx = Math.round(a.cx + ((b.cx - a.cx) * k) / steps);
    const cy = Math.round(a.cy + ((b.cy - a.cy) * k) / steps);
    if (grid[cy] && grid[cy][cx] === ' ') grid[cy][cx] = '·';
  }
}

// 再画砖块和完美点
for (let i = 0; i < positions.length; i++) {
  const { cx, cy } = toCell(positions[i]);
  if (grid[cy]) grid[cy][cx] = i === 0 ? 'S' : i === positions.length - 1 ? 'E' : 'o';
}
for (let i = 0; i < chart.hitCount; i++) {
  const { cx, cy } = toCell(hitPoint(chart, i));
  if (grid[cy] && grid[cy][cx] === '·') grid[cy][cx] = '+';
}

console.log('\n  轨迹（S=起点  o=砖块  E=终点  +=完美点/击打处）\n');
for (const row of grid) console.log('    ' + row.join('').replace(/\s+$/, ''));

// ── 汇总 ────────────────────────────────────────────────────
const sweeps = chart.segments.slice(1).map((s) => s.sweep);
const hitBeats = chart.segments.map((s) => s.hitBeat);
const onIntegerBeat = hitBeats.filter((b) => Math.abs(b - Math.round(b)) < 1e-9).length;

console.log('\n  汇总');
console.log(
  `    转动量  最小 ${Math.min(...sweeps).toFixed(0)}°　` +
    `最大 ${Math.max(...sweeps).toFixed(0)}°　` +
    `平均 ${(sweeps.reduce((a, b) => a + b, 0) / sweeps.length).toFixed(0)}°`,
);
console.log(`    落点落在整拍上的：${onIntegerBeat} / ${hitBeats.length}`);
const firstHit = hitBeats[0];
const lastHit = hitBeats[hitBeats.length - 1];
console.log(
  `    第一次击打 ${firstHit.toFixed(2)} 拍　最后一次 ${lastHit.toFixed(2)} 拍　` +
    `间隔总计 ${(lastHit - firstHit).toFixed(2)} 拍`,
);
