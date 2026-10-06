'use strict';
const { app, BrowserWindow, ipcMain, dialog, session, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JiziService, ROOT } = require('./service');

const testMode = process.argv.includes('--b4-test');
const indexFile = path.join(__dirname, 'index.html');
const indexUrl = pathToFileURL(indexFile).href;
const audit = { networkRequests: [], exports: [], renders: 0 };
let mainWindow;
const service = new JiziService();
// 启动失败由界面读取 bootstrap 时显示，避免未处理的 Promise rejection。
service.ready.catch(() => {});

for (const flag of ['disable-background-networking', 'disable-component-update', 'disable-domain-reliability', 'disable-sync']) {
  app.commandLine.appendSwitch(flag);
}
// B8：本机曾出现 GPU renderer 崩溃，开发与安装版均走软件渲染。
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, payload) => {
    try {
      if (event.sender !== mainWindow?.webContents || event.senderFrame.url !== indexUrl) throw new Error('无效的界面来源');
      return { ok: true, ...await callback(payload) };
    } catch (error) {
      return { ok: false, message: error.message, missing: error.missing || [] };
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1440, height: 940, minWidth: 1050, minHeight: 720,
    title: '集字工作台 · 占位字库版', backgroundColor: '#F5F2EB', show: !testMode,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true,
      nodeIntegration: false, sandbox: true, backgroundThrottling: false, devTools: testMode } });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  mainWindow.loadFile(indexFile);
  mainWindow.on('closed', () => { mainWindow = undefined; });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const remote = !/^(file:|data:|devtools:)/i.test(details.url);
    if (remote) audit.networkRequests.push({ url: details.url, type: details.resourceType });
    callback({ cancel: remote });
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  handle('jizi:bootstrap', () => service.bootstrap());
  handle('jizi:render', async payload => { const result = await service.render(payload); audit.renders++; return result; });
  handle('jizi:candidates', async payload => ({ candidates: await service.candidates(payload?.char) }));
  handle('jizi:export', async payload => {
    // 校验当前内容后再打开保存对话框，导出始终重渲染当前选字。
    const checked = await service.render(payload);
    if (checked.empty) throw new Error('请输入正文后再导出');
    let filename;
    if (testMode) filename = path.join(ROOT, 'output', 'b4', 'gui_export.png');
    else {
      const choice = await dialog.showSaveDialog(mainWindow, { title: '导出集字作品',
        defaultPath: path.join(app.getPath('pictures'), `集字_${Array.from(checked.rendered_text).slice(0, 6).join('')}.png`),
        filters: [{ name: 'PNG 图片', extensions: ['png'] }] });
      if (choice.canceled || !choice.filePath) return { canceled: true };
      filename = choice.filePath.toLowerCase().endsWith('.png') ? choice.filePath : `${choice.filePath}.png`;
    }
    const result = await service.export(payload, filename);
    audit.exports.push(result);
    return { canceled: false, path: result.path, width: result.width, height: result.height };
  });
  if (testMode) globalThis.b4Audit = audit;
  createWindow();
}).catch(error => { console.error(error); app.quit(); });

app.on('window-all-closed', () => app.quit());
