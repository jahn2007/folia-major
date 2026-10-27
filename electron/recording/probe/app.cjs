'use strict';

// Manual Electron 43 shared-texture proof-of-concept.
// Run: npx electron electron/recording/probe/app.cjs
// This tests ONE render source -> shared GPU texture -> second renderer canvas.
// It does NOT replace Folia's player or claim production recording support.
const path = require('node:path');
const { app, BrowserWindow, ipcMain, sharedTexture } = require('electron');

let source = null;
let presenter = null;
let done = false;
let transferring = false;

function finish(ok, message) {
  if (done) return;
  done = true;
  process.stdout.write('[SharedTextureProbe] ' + JSON.stringify({
    ok, message, platform: process.platform, arch: process.arch,
  }) + '\n');
  setTimeout(() => app.exit(ok ? 0 : 1), 50);
}

app.whenReady().then(async () => {
  const timeout = setTimeout(() => finish(false, 'renderer shared-texture timeout'), 18000);
  const originalFinish = finish;
  // The explicit timeout is a bounded smoke test, not a service-level watcher.
  ipcMain.once('texture-probe:ready', async () => {
    source = new BrowserWindow({
      width: 128,
      height: 128,
      transparent: true,
      show: false,
      webPreferences: {
        offscreen: { useSharedTexture: true },
        backgroundThrottling: false,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    source.webContents.setFrameRate(30);
    source.webContents.on('paint', async (event) => {
      if (done || transferring) {
        event.texture?.release();
        return;
      }
      if (!event.texture) {
        finish(false, 'GPU shared texture unavailable');
        return;
      }
      transferring = true;
      const tex = event.texture;
      let imported = null;
      try {
        imported = sharedTexture.importSharedTexture({
          textureInfo: tex.textureInfo,
          allReferencesReleased: () => tex.release(),
        });
        await sharedTexture.sendSharedTexture({
          frame: presenter.webContents.mainFrame,
          importedSharedTexture: imported,
        });
      } catch (error) {
        finish(false, 'texture transfer failed: ' + String(error));
      } finally {
        if (imported) imported.release();
        else tex.release();
        transferring = false;
      }
    });
    // Document's default background is transparent. Canvas has three alpha zones.
    const html = '<!doctype html><html><body style="margin:0;background:transparent">' +
      '<canvas id="scene" width="128" height="128"></canvas>' +
      '<script>const c=document.querySelector("#scene").getContext("2d");' +
      'let n=0;function paint(){c.clearRect(0,0,128,128);' +
      'c.fillStyle="rgba(255,70,30,0.5)";c.fillRect(43,0,42,128);' +
      'c.fillStyle="rgba(30,180,255,1)";c.fillRect(86,0,42,128);' +
      'c.fillStyle="rgba(255,255,255,.6)";c.font="16px sans-serif";' +
      'c.fillText("Folia",48,20+Math.sin(n++)*3);requestAnimationFrame(paint)}paint()</script>' +
      '</body></html>';
    await source.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });

  ipcMain.once('texture-probe:result', (_event, result) => {
    clearTimeout(timeout);
    finish(result?.ok === true, result?.ok ? 'shared frame presented with alpha' : JSON.stringify(result));
  });
  presenter = new BrowserWindow({
    width: 128,
    height: 128,
    show: true,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  await presenter.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><html><body style="margin:0"><canvas id="present" width="128" height="128"></canvas></body></html>'
  ));
}).catch((error) => finish(false, String(error)));

app.on('window-all-closed', () => { if (!done) finish(false, 'probe window closed'); });
