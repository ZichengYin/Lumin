/**
 * 音频文件的容器解析（纯 Node，不依赖任何外部程序）。
 *
 * 只做一件事：**读出时长和基本参数**。不解码、不碰样本数据。
 *
 * 为什么不用 ffprobe：`npm test` 不该依赖机器上装没装 ffmpeg。
 * 谱面必须在音乐放完之前结束，这条检查值得每次都跑，所以它得是纯 Node 的。
 *
 * 支持：WAV（RIFF/PCM 及常见扩展）、MP3（MPEG1/2/2.5 Layer I/II/III）。
 */

import { readFileSync } from 'node:fs';

// ── WAV ────────────────────────────────────────────────────

/**
 * 扫描 RIFF 块，找到 fmt 和 data。
 * 不能假设它们是头两个块 —— 真实文件里经常夹着 LIST/INFO 之类的东西。
 */
export function parseWav(buf) {
  if (buf.length < 12) throw new Error('文件太小，不是 WAV');
  if (buf.toString('latin1', 0, 4) !== 'RIFF') throw new Error('开头不是 RIFF，不是 WAV');
  if (buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('不是 WAVE');

  let pos = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataLength = 0;

  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;

    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        blockAlign: buf.readUInt16LE(body + 12),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, buf.length - body);
      // data 不一定是最后一个块，但找到了就够算了
      break;
    }

    // 块大小是奇数时后面会补一个字节
    pos = body + size + (size % 2);
  }

  if (!fmt) throw new Error('WAV 里找不到 fmt 块');
  if (dataOffset < 0) throw new Error('WAV 里找不到 data 块');
  if (!(fmt.byteRate > 0)) throw new Error(`WAV 的 byteRate 是 ${fmt.byteRate}，没法算时长`);

  return {
    format: 'wav',
    durationSec: dataLength / fmt.byteRate,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    /** 有损压缩的 WAV 也可能出现，2 = ADPCM 之类；1 = PCM */
    encoding: fmt.format === 1 ? 'pcm' : `format-${fmt.format}`,
  };
}

// ── MP3 ────────────────────────────────────────────────────

// 采样率表：按 [version][index] 取，version 0=MPEG2.5 1=保留 2=MPEG2 3=MPEG1
const SAMPLE_RATES = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

// 码率表（kbps），索引 1..14
const BITRATES = {
  '3-1': [32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '3-2': [32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '3-3': [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

/** 解析一个帧头。不是合法帧头就返回 null */
function mp3FrameHeader(buf, pos) {
  if (pos + 4 > buf.length) return null;
  if (buf[pos] !== 0xff || (buf[pos + 1] & 0xe0) !== 0xe0) return null;

  const verBits = (buf[pos + 1] >> 3) & 0x03; // 0=2.5 1=保留 2=MPEG2 3=MPEG1
  const layerBits = (buf[pos + 1] >> 1) & 0x03; // 0=保留 1=III 2=II 3=I
  if (verBits === 1 || layerBits === 0) return null;

  const layer = 4 - layerBits; // 1/2/3
  const bitrateIdx = (buf[pos + 2] >> 4) & 0x0f;
  const rateIdx = (buf[pos + 2] >> 2) & 0x03;
  const padding = (buf[pos + 2] >> 1) & 0x01;
  if (bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3) return null;

  const versionKey = verBits === 3 ? '3' : '2'; // 2.5 和 2 用同一张码率表
  const bitrate = BITRATES[`${versionKey}-${layer}`][bitrateIdx - 1] * 1000;
  const sampleRate = SAMPLE_RATES[verBits][rateIdx];

  let frameLength;
  let samplesPerFrame;
  if (layer === 1) {
    frameLength = Math.floor((12 * bitrate) / sampleRate + padding) * 4;
    samplesPerFrame = 384;
  } else if (layer === 2) {
    frameLength = Math.floor((144 * bitrate) / sampleRate + padding);
    samplesPerFrame = 1152;
  } else {
    // Layer III：MPEG1 是 1152，MPEG2/2.5 是 576，所以系数也跟着减半
    const coef = verBits === 3 ? 144 : 72;
    frameLength = Math.floor((coef * bitrate) / sampleRate + padding);
    samplesPerFrame = verBits === 3 ? 1152 : 576;
  }
  if (frameLength < 8) return null;

  return { version: verBits === 3 ? 1 : verBits === 2 ? 2 : 2.5, layer, bitrate, sampleRate, padding, frameLength, samplesPerFrame };
}

/** 跳过开头的 ID3v2 标签 */
function id3v2Size(buf) {
  if (buf.length < 10) return 0;
  if (buf.toString('latin1', 0, 3) !== 'ID3') return 0;
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  const footer = (buf[5] & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

export function parseMp3(buf) {
  let pos = id3v2Size(buf);
  // 跳过开头可能夹着的垃圾字节
  let guard = 0;
  while (guard++ < 200000 && pos + 4 <= buf.length && !mp3FrameHeader(buf, pos)) pos++;
  if (pos + 4 > buf.length) throw new Error('MP3 里找不到第一个合法帧头');

  const first = mp3FrameHeader(buf, pos);
  if (!first) throw new Error('MP3 帧头非法');

  // 有些编码器（尤其是 VBR）会在第一帧塞 Xing/Info 头，里面直接给了总帧数
  const tagStart = pos + 4 + (first.version === 1 ? 32 : 17);
  const tag = buf.toString('latin1', tagStart, tagStart + 4);
  if (tag === 'Xing' || tag === 'Info') {
    const flags = buf.readUInt32BE(tagStart + 4);
    if (flags & 0x1) {
      const frames = buf.readUInt32BE(tagStart + 8);
      return {
        format: 'mp3',
        durationSec: (frames * first.samplesPerFrame) / first.sampleRate,
        sampleRate: first.sampleRate,
        channels: first.layer === 3 && first.version === 1 ? 2 : 2,
        bitrate: first.bitrate,
        encoding: 'mpeg-layer3',
        vbr: tag === 'Xing',
        frameCount: frames,
      };
    }
  }

  // 没有 Xing：老老实实走一遍帧
  let samples = 0;
  let frames = 0;
  let bytes = 0;
  let isVbr = false;
  let lastBitrate = first.bitrate;
  while (pos + 4 <= buf.length) {
    const h = mp3FrameHeader(buf, pos);
    if (!h) break;
    if (h.bitrate !== lastBitrate) isVbr = true;
    lastBitrate = h.bitrate;
    samples += h.samplesPerFrame;
    bytes += h.frameLength;
    frames++;
    pos += h.frameLength;
  }
  if (frames === 0) throw new Error('MP3 里一帧都没读到');

  return {
    format: 'mp3',
    durationSec: samples / first.sampleRate,
    sampleRate: first.sampleRate,
    channels: 2,
    bitrate: bytes > 0 ? Math.round((bytes * 8) / (samples / first.sampleRate)) : first.bitrate,
    encoding: `mpeg${first.version}-layer${first.layer}`,
    vbr: isVbr,
    frameCount: frames,
  };
}

// ── 统一入口 ────────────────────────────────────────────────

/** 靠文件头判断格式，不靠扩展名 */
export function sniffFormat(buf) {
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') {
    return 'wav';
  }
  if (buf.length >= 3 && buf.toString('latin1', 0, 3) === 'ID3') return 'mp3';
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  return null;
}

export function parseAudioFile(path) {
  const buf = readFileSync(path);
  const fmt = sniffFormat(buf);
  if (fmt === 'wav') return { ...parseWav(buf), bytes: buf.length };
  if (fmt === 'mp3') return { ...parseMp3(buf), bytes: buf.length };
  throw new Error(`${path} 既不是 WAV 也不是 MP3（看文件头判断的，和扩展名无关）`);
}
