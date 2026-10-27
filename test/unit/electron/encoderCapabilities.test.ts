import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';

const require = createRequire(import.meta.url);
const {
  CODECS,
  sourceFrame,
  enumerateCandidates,
  selectValidatedEncoder,
} = require('../../../electron/recording/encoderCapabilities.cjs');

describe('transparent recording encoder capabilities', () => {
  it('exposes exactly the three requested alpha formats', () => {
    expect(Object.keys(CODECS).sort()).toEqual(['hevc-alpha', 'qtrle', 'vp9-alpha']);
    expect(CODECS['vp9-alpha'].extension).toBe('.webm');
    expect(CODECS['hevc-alpha'].extension).toBe('.mov');
    expect(CODECS.qtrle.extension).toBe('.mov');
  });

  it('uses only alpha-aware backends, not regular GPU video encoders', () => {
    expect(enumerateCandidates('vp9-alpha', { platform: 'win32' }).map((e: any) => e.id))
      .toEqual(['libvpx-vp9']);
    expect(enumerateCandidates('qtrle', { platform: 'win32' }).map((e: any) => e.id))
      .toEqual(['qtrle']);
    expect(enumerateCandidates('hevc-alpha', { platform: 'darwin' }).map((e: any) => e.id))
      .toEqual(['hevc-videotoolbox-alpha', 'libx265-alpha']);
  });

  it('always falls back to a tested software backend', async () => {
    const selected = await selectValidatedEncoder('/test/ffmpeg', 'hevc-alpha', {
      platform: 'darwin',
      probe: async (_path: string, candidate: any) => ({ ok: candidate.id === 'libx265-alpha' }),
    });
    expect(selected.ok).toBe(true);
    expect(selected.backend.id).toBe('libx265-alpha');
    expect(selected.attempts.map((item: any) => item.backend)).toEqual([
      'hevc-videotoolbox-alpha',
      'libx265-alpha',
    ]);
  });

  it('allows selecting an exact encoder GPU while retaining CPU fallback', () => {
    const registered = [
      {
        id: 'verified-nvenc-alpha-gpu0',
        codec: 'hevc-alpha',
        hardware: true,
        gpuId: 'gpu0',
        encoderArgs: ['-c:v', 'verified-nvenc-alpha'],
      },
      {
        id: 'verified-nvenc-alpha-gpu1',
        codec: 'hevc-alpha',
        hardware: true,
        gpuId: 'gpu1',
        encoderArgs: ['-c:v', 'verified-nvenc-alpha'],
      },
    ];
    expect(enumerateCandidates('hevc-alpha', {
      platform: 'win32', gpuId: 'gpu1', additionalBackends: registered,
    }).map((e: any) => e.id)).toEqual(['verified-nvenc-alpha-gpu1', 'libx265-alpha']);
    expect(enumerateCandidates('hevc-alpha', {
      platform: 'win32', gpuId: 'cpu', additionalBackends: registered,
    }).map((e: any) => e.id)).toEqual(['libx265-alpha']);
  });

  it('constructs a test image with transparent, partial and opaque pixels', () => {
    const frame = sourceFrame();
    expect(frame.length).toBe(64 * 64 * 4);
    expect(frame[(30 * 64 + 2) * 4 + 3]).toBe(0);
    expect(frame[(30 * 64 + 32) * 4 + 3]).toBe(128);
    expect(frame[(30 * 64 + 60) * 4 + 3]).toBe(255);
  });

  it('does not claim alpha hardware support without a real probe', async () => {
    const result = await selectValidatedEncoder('/test/ffmpeg', 'vp9-alpha', {
      platform: 'win32',
      probe: async () => ({ ok: false, reason: 'alpha-not-verified' }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('no-alpha-preserving-encoder');
  });
});
