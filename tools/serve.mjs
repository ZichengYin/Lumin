/**
 * 零依赖静态服务器。
 *
 * 为什么需要它：index.html 用了 <script type="module">，浏览器的同源策略会
 * 直接拦掉 file:// 下的模块加载（控制台报 CORS 错误）。随便起一个 http 服务就行。
 * 这里用 Node 自带的 http 模块，不需要 npm install 任何东西。
 *
 *   node tools/serve.mjs              默认 http://127.0.0.1:8123
 *   node tools/serve.mjs --port 9000
 *   node tools/serve.mjs --no-open    不自动开浏览器
 *
 * ★ 所有面向玩家的中文提示都在这个文件里，不在 启动游戏.bat 里。
 *   原因见 openBrowser 上方的注释：UTF-8 的批处理会被 cmd.exe 解析错。
 */

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(argOf('--port', process.env.PORT || 8123));
const OPEN = !argv.includes('--no-open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, 'http://localhost');
    // 谱面编辑器用的保存接口。只在这个本地服务器上开，
    // 而且只允许写 levels/ 里的 .json —— 见 saveChart 里的路径校验。
    if (req.method === 'POST' && reqUrl.pathname === '/api/save-chart') {
      await saveChart(req, res, reqUrl);
      return;
    }

    const pathname = decodeURIComponent(reqUrl.pathname);
    let rel = pathname.replace(/^[/\\]+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';

    const file = resolve(join(ROOT, rel));
    // 目录穿越防护：只允许读 ROOT 里面的文件
    if (file !== ROOT && !file.startsWith(ROOT + sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403 越界');
      return;
    }

    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    const code = err && err.code === 'EACCES' ? 403 : 404;
    res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`${code} ${code === 404 ? '找不到这个文件' : '没有权限'}`);
  }
});

const URL_ = `http://127.0.0.1:${PORT}/`;

/**
 * 把谱面写成给人看的样子。
 *
 * 默认的 `JSON.stringify(…, null, 2)` 会**每个数字一行** —— 69 格的谱面就是
 * 69 行 `0,`，翻都翻不动。这里对 `angles` 特殊处理：
 *
 *   · 和上一个数字**相同**就留在同一行（连续直行挤成一行）
 *   · 值一变就换行 —— 每个转弯单独一行，一眼能看出哪几格在转
 *   · 一行最多 12 个，太长就折行
 *   · 一段连续 ≥3 个相同的值之后空一行，把段落分开
 *
 * 其余字段照常用标准的缩进写法。产物仍然是合法 JSON（没有多余逗号）。
 */
function formatChart(obj) {
  const keys = Object.keys(obj);
  const out = ['{'];

  keys.forEach((k, i) => {
    const last = i === keys.length - 1;
    if (k === 'angles' && Array.isArray(obj[k])) {
      out.push('  "angles": [');
      out.push(...groupAngles(obj[k]));
      out.push(`  ]${last ? '' : ','}`);
    } else {
      const text = JSON.stringify(obj[k], null, 2)
        .split('\n')
        // 只有第二行起才需要补缩进 —— 第一行已经跟在键名后面了
        .map((l, n) => (n === 0 ? l : `  ${l}`))
        .join('\n');
      out.push(`  ${JSON.stringify(k)}: ${text}${last ? '' : ','}`);
    }
  });

  out.push('}');
  return `${out.join('\n')}\n`;
}

/** 把 angles 按「值变化」切成行。返回已经缩进好的字符串数组 */
function groupAngles(angles, perLine = 12) {
  const rows = [];
  let row = [];
  let run = 0;

  const flush = () => {
    if (row.length) rows.push(row);
    row = [];
  };

  for (let i = 0; i < angles.length; i++) {
    if (i > 0 && angles[i] !== angles[i - 1]) {
      flush();
      // 一段长直行之后空一行，段落感就出来了
      if (run >= 3) rows.push(null);
      run = 0;
    }
    row.push(angles[i]);
    run += 1;
    if (row.length >= perLine) flush();
  }
  flush();

  return rows.map((r, i) => {
    if (r === null) return '';
    const isLast = i === rows.length - 1;
    return `    ${r.join(', ')}${isLast ? '' : ','}`;
  });
}

/**
 * 谱面编辑器的保存接口。
 *
 * 安全上的三道限制（这是个开发工具，但也不该随便让人写文件）：
 *   ① 服务器只监听 127.0.0.1，外网连不上
 *   ② 只能写 levels/ 目录里的文件
 *   ③ 文件名必须是 `字母数字._-.json` 这种，挡掉 `../` 之类
 *
 * 另外会**先解析一遍 JSON、并检查 angles 存在**，坏内容不落盘 ——
 * 免得手一滑把整关写成一个空文件。
 */
async function saveChart(req, res, url) {
  const name = url.searchParams.get('file') ?? '';
  if (!/^[\w.-]+\.json$/.test(name) || name.includes('..')) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`400 文件名不合法：${name}`);
    return;
  }

  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 4 * 1024 * 1024) {
      res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('413 太大了');
      return;
    }
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`400 JSON 语法错误，没有写入：${err.message}`);
    return;
  }
  if (!Array.isArray(parsed?.angles) || parsed.angles.length === 0) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('400 没有 angles 数组，没有写入');
    return;
  }

  const levelsDir = resolve(join(ROOT, 'levels'));
  const file = resolve(join(levelsDir, name));
  if (!file.startsWith(levelsDir + sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 越界');
    return;
  }

  await writeFile(file, formatChart(parsed), 'utf8');
  console.log(`  [编辑器] 已保存 levels/${name}   ${parsed.angles.length} 格`);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, file: `levels/${name}`, tiles: parsed.angles.length }));
}

function banner() {
  console.log('');
  console.log('  ================================================');
  console.log('   余光 · 开发服务器已启动');
  console.log('  ================================================');
  console.log('');
  console.log(`   游戏地址    ${URL_}`);
  console.log(`   项目根目录  ${ROOT}`);
  console.log('');
  console.log('   浏览器没有自动打开的话，把上面那个「游戏地址」');
  console.log('   复制进浏览器地址栏、回车，就能玩了。');
  console.log('');
  console.log('   玩完想关掉：回到这个黑窗口按 Ctrl+C。');
  console.log('');
}

/** 开浏览器之前先问自己一句「我真的能应答吗」，免得开出一个错误页 */
async function selfCheck() {
  try {
    const res = await fetch(URL_, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 用系统默认浏览器打开网址。
 *
 * 这里**故意不用** `cmd /c start "" <url>`。那个写法的第一个参数必须是空字符串
 * （start 会把它当成窗口标题），而空参数只要经过任何一层包装——Node 的参数转义、
 * 批处理、协议别名——就可能被吃掉；一旦被吃掉，start 会把空位当成标题、把网址
 * 当成文件名，最后变成「用一个程序去打开一个文件」，而不是「打开这个网址」。
 *
 * rundll32 url.dll,FileProtocolHandler 是 Windows 留给「用默认程序打开这个 URL」
 * 的正式入口，不经过 cmd 解析，最不容易出岔子。
 */
function openBrowser(url) {
  // ── 先试「指定浏览器 + 启动参数」──────────────────────────
  //
  // 为什么要这样：主界面是一段**带音轨**的视频，而浏览器的自动播放策略
  // 规定「没有用户手势就不允许有声播放」，所以直接打开的话主界面是哑的，
  // 必须点一下才有声。
  //
  // 本地游戏（尤其以后打包成 exe）应该一打开就有声，所以这里优先用
  // 已知的浏览器路径 + `--autoplay-policy=no-user-gesture-required`。
  // 找不到浏览器就退回系统默认方式（那时主界面会静音，点一下就有声）。
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files';
  const local = process.env.LOCALAPPDATA ?? '';
  const candidates =
    process.platform === 'win32'
      ? [
          `${pf86}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
          `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
          `${pf86}\\Google\\Chrome\\Application\\chrome.exe`,
          `${local}\\Google\\Chrome\\Application\\chrome.exe`,
        ]
      : [];

  /**
   * ★ 必须带 `--user-data-dir`，否则参数会被**忽略**。
   *
   *   浏览器已经在跑的时候，新的启动命令只是把网址「转交」给已有窗口 ——
   *   命令行参数全部丢掉。这是「加了 autoplay 参数却没效果」的真正原因。
   *
   *   指定一个专用配置目录就会强制**开一个独立进程**，参数这才生效。
   *   目录放在 LOCALAPPDATA 下，不污染项目，也不动你平时的浏览器配置。
   */
  const profileDir = local ? `${local}\\YuguangGame\\profile` : '';

  for (const exe of candidates) {
    if (!existsSync(exe)) continue;
    const args = ['--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check'];
    if (profileDir) args.push(`--user-data-dir=${profileDir}`);
    args.push(url);
    try {
      const child = spawn(exe, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', () => {});
      child.unref();
      return true;
    } catch {
      // 这个不行就试下一个
    }
  }

  const plan =
    process.platform === 'win32'
      ? [
          ['rundll32.exe', ['url.dll,FileProtocolHandler', url]],
          ['explorer.exe', [url]],
        ]
      : process.platform === 'darwin'
        ? [['open', [url]]]
        : [['xdg-open', [url]]];

  for (const [cmd, args] of plan) {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      // 打不开也不影响服务器，别让未捕获的 error 事件把进程带崩
      child.on('error', () => {});
      child.unref();
      return true;
    } catch {
      // 换下一个方案
    }
  }
  return false;
}

server.listen(PORT, '127.0.0.1', async () => {
  banner();
  if (!OPEN) return;
  if (await selfCheck()) {
    openBrowser(URL_);
  } else {
    console.log('  （自检没通过，请手动打开上面的游戏地址）');
    console.log('');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // 端口被占多半不是坏事：说明服务器已经在另一个窗口里跑着了。
    // 这时候最该做的是把人送到游戏里，而不是丢一个错就退出。
    console.log('');
    console.log(`  端口 ${PORT} 已经被占用 ——`);
    console.log('  多半是《余光》的服务器已经在另一个窗口里跑着了。');
    console.log('');
    console.log(`  直接打开：${URL_}`);
    console.log('');
    console.log(`  确实想再开一个的话：node tools/serve.mjs --port 8124`);
    console.log('');
    if (OPEN) openBrowser(URL_);
    // 给浏览器一点启动时间再退出
    setTimeout(() => process.exit(1), 800);
    return;
  }
  console.error(err);
  process.exit(1);
});
