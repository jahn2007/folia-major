'use strict';
// A dedicated proof-of-concept preload, not used by the Folia player.
const { ipcRenderer, contextBridge, sharedTexture } = require('electron');
let accepted = false;
sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }) => {
  if (accepted) { importedSharedTexture.release(); return; }
  accepted = true;
  let frame;
  try {
    frame = importedSharedTexture.getVideoFrame();
    const canvas = document.querySelector('#present');
    if (!canvas) throw new Error('Presenter canvas missing');
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('Canvas2D unavailable');
    ctx.clearRect(0, 0, 128, 128);
    ctx.drawImage(frame, 0, 0, 128, 128);
    const pixels = ctx.getImageData(0, 0, 128, 128).data;
    const a0 = pixels[(50 * 128 + 10) * 4 + 3];
    const a1 = pixels[(50 * 128 + 60) * 4 + 3];
    const a2 = pixels[(50 * 128 + 110) * 4 + 3];
    ipcRenderer.send('texture-probe:result', {
      ok: a0 < 32 && a1 > 50 && a1 < 220 && a2 > 235,
      alphas: [a0, a1, a2],
    });
  } catch (error) {
    ipcRenderer.send('texture-probe:result', { ok: false, error: String(error) });
  } finally {
    frame?.close();
    importedSharedTexture.release();
  }
});
window.addEventListener('DOMContentLoaded', () => ipcRenderer.send('texture-probe:ready'), { once: true });
