'use strict';

// Transparent recording codec selection and alpha-preservation probes.
// This module intentionally never treats a regular VP9/HEVC hardware encoder
// as alpha-capable merely because FFmpeg lists it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CODECS = Object.freeze({
  'vp9-alpha': Object.freeze({ extension: '.webm', label: 'VP9 + Alpha' }),
  'hevc-alpha': Object.freeze({ extension: '.mov', label: 'HEVC + Alpha' }),
  qtrle: Object.freeze({ extension: '.mov', label: 'QuickTime Animation' }),
});

const SOFTWARE_BACKENDS = Object.freeze({
  'vp9-alpha': Object.freeze({
    id: 'libvpx-vp9',
    codec: 'vp9-alpha',
    hardware: false,
    encoderArgs: ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-b:v', '0', '-crf', '30', '-row-mt', '1'],
    decoderArgs: ['-c:v', 'libvpx-vp9'],
  }),
  'hevc-alpha': Object.freeze({
    id: 'libx265-alpha',
    codec: 'hevc-alpha',
    hardware: false,
    encoderArgs: ['-c:v', 'libx265', '-pix_fmt', 'yuva420p', '-tag:v', 'hvc1'],
    decoderArgs: [],
  }),
  qtrle: Object.freeze({
    id: 'qtrle',
    codec: 'qtrle',
    hardware: false,
    encoderArgs: ['-c:v', 'qtrle', '-pix_fmt', 'argb'],
    decoderArgs: [],
  }),
});

// The VideoToolbox alpha path is an actual format-specific backend.
// NVENC/AMF/QSV *regular* HEVC and VP9 modes are deliberately NOT listed.
// Platform integrations may register new backends after a complete alpha test.
const HARDWARE_BACKENDS = Object.freeze([
  Object.freeze({
    id: 'hevc-videotoolbox-alpha',
    codec: 'hevc-alpha',
    hardware: true,
    platform: 'darwin',
    encoderArgs: ['-c:v', 'hevc_videotoolbox', '-pix_fmt', 'bgra', '-alpha_quality', '0.8', '-tag:v', 'hvc1'],
    decoderArgs: [],
  }),
]);

const sourceFrame = (width = 64, height = 64) => {
  const frame = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      frame[i] = 30;   // B
      frame[i + 1] = 120; // G
      frame[i + 2] = 230; // R
      frame[i + 3] = x < width / 3 ? 0 : x < 2 * width / 3 ? 128 : 255; // A
    }
  }
  return frame;
};

const runProcess = (binary, args, stdinData, timeoutMs = 16000) => new Promise((resolve) => {
  let completed = false;
  let proc;
  const buffers = [];
  let outputBytes = 0;
  let stderr = '';
  const finish = (result) => {
    if (completed) return;
    completed = true;
    clearTimeout(timeout);
    resolve(result);
  };
  try {
    proc = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (error) {
    resolve({ ok: false, error: String(error), stdout: Buffer.alloc(0) });
    return;
  }
  const timeout = setTimeout(() => {
    proc.kill('SIGKILL');
    finish({ ok: false, error: 'encoder-probe-timeout', stdout: Buffer.alloc(0) });
  }, timeoutMs);
  proc.stdout.on('data', (chunk) => {
    // Probe output is a 64x64 frame. Avoid unlimited stdout growth.
    outputBytes += chunk.length;
    if (outputBytes <= 1024 * 1024) buffers.push(chunk);
  });
  proc.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4096);
  });
  proc.on('error', (error) => finish({ ok: false, error: String(error), stdout: Buffer.alloc(0) }));
  proc.on('close', (code) => finish({
    ok: code === 0 && outputBytes <= 1024 * 1024,
    error: code === 0 ? null : stderr || 'ffmpeg-exit-' + code,
    stdout: Buffer.concat(buffers),
  }));
  if (stdinData) proc.stdin.end(stdinData);
  else proc.stdin.end();
});

/**
 * Encodes a synthetic transparent frame and decodes it again. A successful
 * ffmpeg exit alone is NEVER evidence that a hardware encoder preserves alpha.
 * The decoder must expose the alpha samples as RGBA for the backend to qualify.
 */
async function probeAlphaBackend(ffmpegPath, backend, { tempDir = os.tmpdir(), timeoutMs = 16000 } = {}) {
  if (!backend || !CODECS[backend.codec]) return { ok: false, reason: 'invalid-backend' };
  const scratch = fs.mkdtempSync(path.join(tempDir, 'folia-alpha-'));
  const videoPath = path.join(scratch, 'probe' + CODECS[backend.codec].extension);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-f', 'rawvideo', '-pixel_format', 'bgra', '-video_size', '64x64',
    '-framerate', '2', '-i', 'pipe:0', '-frames:v', '2',
    ...backend.encoderArgs, videoPath,
  ];
  try {
    const raw = sourceFrame();
    const encode = await runProcess(ffmpegPath, args, Buffer.concat([raw, raw]), timeoutMs);
    if (!encode.ok) return { ok: false, reason: 'encode-failed', detail: encode.error };
    const decode = await runProcess(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', videoPath,
      '-map', '0:v:0', '-frames:v', '1', ...[], '-pix_fmt', 'rgba',
      '-f', 'rawvideo', 'pipe:1',
    ], null, timeoutMs);
    // VP9 WebM alpha requires the libvpx decoder. Repeat the decode when the
    // native decoder dropped the alpha plane.
    const alphaResult = (decoded) => {
      if (!decoded.ok || decoded.stdout.length < 64 * 64 * 4) return false;
      const getA = (x, y) => decoded.stdout[(y * 64 + x) * 4 + 3];
      const samples = [getA(2, 30), getA(32, 30), getA(60, 30)];
      return samples[0] < 32 && samples[1] >= 48 && samples[1] <= 208 && samples[2] > 235;
    };
    if (alphaResult(decode)) return { ok: true, backend: backend.id };
    const retry = backend.codec === 'vp9-alpha'
      ? await runProcess(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-c:v', 'libvpx-vp9', '-i', videoPath,
        '-map', '0:v:0', '-frames:v', '1', '-pix_fmt', 'rgba',
        '-f', 'rawvideo', 'pipe:1',
      ], null, timeoutMs)
      : null;
    return alphaResult(retry)
      ? { ok: true, backend: backend.id }
      : { ok: false, reason: 'alpha-not-verified', detail: decode.error };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function enumerateCandidates(codec, {
  platform = process.platform,
  gpuId = 'auto',
  additionalBackends = [],
} = {}) {
  if (!CODECS[codec]) throw new Error('unsupported-transparent-codec');
  const candidates = [
    ...HARDWARE_BACKENDS,
    ...additionalBackends,
  ].filter((entry) => entry.codec === codec && entry.hardware && (!entry.platform || entry.platform === platform));
  const preferred = gpuId === 'cpu'
    ? []
    : candidates.filter((entry) => gpuId === 'auto' || entry.gpuId === gpuId);
  return [...preferred, SOFTWARE_BACKENDS[codec]];
}

async function selectValidatedEncoder(ffmpegPath, codec, opts = {}) {
  const candidates = enumerateCandidates(codec, opts);
  const probe = opts.probe || probeAlphaBackend;
  const attempts = [];
  for (const backend of candidates) {
    const result = await probe(ffmpegPath, backend, opts);
    attempts.push({ backend: backend.id, ...result });
    if (result.ok) return { ok: true, backend, attempts };
  }
  return { ok: false, error: 'no-alpha-preserving-encoder', attempts };
}

module.exports = {
  CODECS,
  SOFTWARE_BACKENDS,
  HARDWARE_BACKENDS,
  sourceFrame,
  enumerateCandidates,
  probeAlphaBackend,
  selectValidatedEncoder,
};
