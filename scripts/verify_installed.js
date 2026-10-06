'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { _electron } = require('playwright-core');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'output', 'b8');
const manual = process.argv.includes('--manual');
const installed = path.join(OUT, 'installed-app', 'AI-Jizi.exe');
const exported = path.join(OUT, 'installed_export.png');
const complete = path.join(OUT, 'native_done.flag');

async function main() {
  await fs.access(installed);
  if (manual) await fs.rm(complete, { force: true });
  const environment = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
  delete environment.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({ executablePath: installed, args: ['--disable-gpu',
    '--proxy-server=http://127.0.0.1:9', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost'],
    env: environment, timeout: 25000 });
  let page;
  const errors = [], requests = [];
  try {
    const runtime = await application.evaluate(({ app }) => ({
      packaged: app.isPackaged, appPath: app.getAppPath(), electron: process.versions.electron,
      hardwareAcceleration: app.isHardwareAccelerationEnabled(),
      disableGpu: app.commandLine.hasSwitch('disable-gpu'), argv: process.argv,
    }));
    assert.equal(runtime.packaged, true);
    assert.equal(runtime.appPath, path.join(OUT, 'installed-app', 'resources', 'app.asar'));
    assert.equal(runtime.hardwareAcceleration, false); assert.equal(runtime.disableGpu, true);
    // 限制主进程的 Node 网络入口；UI 的 Chromium 网络另由 setOffline 禁用。
    await application.evaluate(() => {
      globalThis.b8NetworkAttempts = 0;
      const deny = () => { globalThis.b8NetworkAttempts++; throw new Error('B8 离线验收禁止 Node 网络连接'); };
      globalThis.fetch = deny;
      for (const protocol of ['http', 'https']) {
        const api = process.getBuiltinModule(protocol); api.get = deny; api.request = deny;
      }
      const net = process.getBuiltinModule('net'); net.connect = deny; net.createConnection = deny;
      const tls = process.getBuiltinModule('tls'); tls.connect = deny;
    });
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/i.test(request.url())) requests.push(request.url()); });
    page.setDefaultTimeout(20000);
    await page.context().setOffline(true);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await cdp.send('Network.overrideNetworkState', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await page.reload();
    const waitText = text => page.waitForFunction(expected =>
      [...document.querySelectorAll('#preview-document [data-index]')].map(group => group.dataset.char).join('') === expected
        && !document.getElementById('export-button').disabled, text);
    await waitText('海内存知己天涯若比邻');
    // Electron 的 navigator.onLine 取系统连接状态，file: 页面不总随 CDP 改变。
    const navigatorOnline = await page.evaluate(() => navigator.onLine);
    const capture = async name => {
      await page.waitForFunction(() => document.getElementById('candidate-count').textContent !== '载入中');
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map(img => img.decode().catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      const png = await application.evaluate(async ({ BrowserWindow }) => {
        const snapshot = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
        if (snapshot.isEmpty()) throw new Error('安装版截图为空');
        return snapshot.toPNG().toString('base64');
      });
      await fs.writeFile(path.join(OUT, name), Buffer.from(png, 'base64'));
    };
    let presetCount = 0;
    if (manual) {
      await capture('01_installed_offline.png');
      console.log('MANUAL_READY：安装版 Chromium 已断网，等待原生窗口选字和 Windows 保存对话框。');
      // 外部 Computer Use 完成真实保存后写 flag；本脚本只观察并核验。
      const deadline = Date.now() + 10 * 60 * 1000;
      while (true) {
        if (await fs.stat(complete).catch(() => null)) break;
        if (Date.now() > deadline) throw new Error('原生保存验证等待超时');
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } else {
      const presets = (await fs.readFile(path.join(ROOT, 'test_texts.txt'), 'utf8')).trim().split(/\r?\n/);
      for (let index = 0; index < presets.length; index++) {
        await page.locator('#sample-select').selectOption(String(index));
        await waitText(presets[index].replace(/[\p{P}\p{C}\p{Z}\s]/gu, ''));
      }
      presetCount = presets.length;
      await capture('offline_01_start.png');
      await page.locator('#text-input').fill('宁静致远，宁静致远');
      await waitText('宁静致远宁静致远');
      await page.locator('#preview-document [data-index="1"]').click();
      await page.waitForFunction(() => document.getElementById('selected-char').textContent === '静'
        && document.querySelectorAll('.candidate-card').length === 4);
      await page.locator('.candidate-card[data-source="江西拙楷"]').click();
      await page.waitForFunction(() => document.querySelector('#preview-document [data-index="1"]')?.dataset.source === '江西拙楷'
        && !document.getElementById('export-button').disabled);
      await capture('offline_02_selected.png');
      // 自动复验仅固定保存路径；真实 Windows 对话框在 --manual 复验中验证。
      await application.evaluate(({ dialog }, filename) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename });
      }, exported);
      await page.locator('#export-button').click();
      await page.waitForFunction(() => document.getElementById('toast').textContent.startsWith('已导出：'));
      await capture('offline_03_export.png');
    }
    await waitText('宁静致远宁静致远');
    const cells = await page.locator('#preview-document [data-index]').evaluateAll(groups =>
      groups.map(group => ({ index: Number(group.dataset.index), char: group.dataset.char, source: group.dataset.source })));
    assert.equal(cells[1].source, '江西拙楷'); assert.equal(cells[5].source, '演示夏行楷');
    const metadata = await sharp(exported).metadata(); assert.equal(metadata.width, 2560);
    const expected = path.join(OUT, 'expected_installed_export.png');
    // 使用安装包内的服务和字库独立重渲染，逐像素核对真实导出。
    await application.evaluate(async ({ app }, { filename }) => {
      const modulePath = process.getBuiltinModule('path');
      const load = process.getBuiltinModule('module').createRequire(modulePath.join(app.getAppPath(), 'package.json'));
      const { JiziService } = load('./app/service.js');
      const service = new JiziService(); const bootstrap = await service.bootstrap();
      await service.export({ style: { ...bootstrap.defaultStyle, text: '宁静致远，宁静致远' }, selections: { 1: '江西拙楷' } }, filename);
    }, { filename: expected });
    const actualPixels = await sharp(exported).raw().toBuffer();
    const expectedPixels = await sharp(expected).raw().toBuffer();
    assert.ok(actualPixels.equals(expectedPixels), '导出图应与安装版当前候选独立重渲染逐像素相同');
    assert.deepEqual(errors, []); assert.deepEqual(requests, []);
    const nodeAttempts = await application.evaluate(() => globalThis.b8NetworkAttempts); assert.equal(nodeAttempts, 0);
    const report = { passed: true, mode: manual ? 'native Windows save dialog + Computer Use' : 'automated export path',
      timestamp: new Date().toISOString(), runtime, chromium_offline: true, navigator_online_value: navigatorOnline,
      node_network_entrypoints_disabled: true,
      app_network_requests: requests.length, node_network_attempts: nodeAttempts, renderer_errors: errors,
      presets_verified: presetCount, candidate_count: 4, cells, single_occurrence_switch: true,
      png: exported, png_width: metadata.width, png_height: metadata.height,
      png_sha256: crypto.createHash('sha256').update(await fs.readFile(exported)).digest('hex'),
      export_matches_packaged_service_pixels: true, source_development_paths_used: false,
      system_network_disconnected: process.env.B8_SYSTEM_OFFLINE === '1' };
    await fs.writeFile(path.join(OUT, manual ? 'installed_gui_report.json' : 'offline_gui_report.json'), JSON.stringify(report, null, 2));
    console.log('安装版验收通过：packaged asar / GPU off / 单字候选 / 2560px PNG 与包内服务逐像素一致 / 网络调用 0。');
  } catch (error) {
    console.error(error);
    if (page) console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 2000));
    throw error;
  } finally { await application.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
