'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { _electron } = require('playwright-core');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'output', 'b4');

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const environment = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
  delete environment.ELECTRON_RUN_AS_NODE;
  const application = await _electron.launch({ executablePath: require('electron'), args: [ROOT, '--b4-test', '--disable-gpu'],
    env: environment, timeout: 60000 });
  let page;
  const errors = [];
  try {
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.context().setOffline(true);
    // 在浏览器离线条件下重新加载，覆盖启动时的字库与预览初始化。
    await page.reload();
    const screenshot = async filename => {
      await page.waitForFunction(() => document.getElementById('candidate-count').textContent !== '载入中');
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      // Windows 隐藏窗口使用 Electron 原生截图，避免 CDP 等待可见帧超时。
      const png = await application.evaluate(async ({ BrowserWindow }) => {
        const snapshot = await Promise.race([
          BrowserWindow.getAllWindows()[0].webContents.capturePage(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('原生截图超时')), 15000)),
        ]);
        if (snapshot.isEmpty()) throw new Error('窗口截图为空');
        return snapshot.toPNG().toString('base64');
      });
      await fs.writeFile(path.join(OUT, filename), Buffer.from(png, 'base64'));
    };
    const waitText = async text => {
      await page.waitForFunction(expected => {
        const groups = [...document.querySelectorAll('#preview-document [data-index]')];
        return groups.map(group => group.dataset.char).join('') === expected
          && !document.getElementById('export-button').disabled;
      }, text);
    };
    const waitSource = async (index, source) => page.waitForFunction(({ index, source }) =>
      document.querySelector(`#preview-document [data-index="${index}"]`)?.dataset.source === source
        && !document.getElementById('export-button').disabled, { index, source });
    const sources = async () => page.locator('#preview-document [data-index]').evaluateAll(groups => groups.map(group => group.dataset.source));
    await waitText('海内存知己天涯若比邻');
    await page.waitForFunction(() => document.querySelectorAll('.candidate-card').length === 4);
    assert.equal(await page.locator('#source-select option').count(), 4);
    assert.equal(await page.locator('#sample-select option').count(), 11);
    const fit = await page.evaluate(() => {
      const stage = document.getElementById('preview-stage').getBoundingClientRect();
      const paper = document.getElementById('preview-document').getBoundingClientRect();
      return { paperHeight: paper.height, stageHeight: stage.height, top: paper.top, bottom: paper.bottom,
        stageTop: stage.top, stageBottom: stage.bottom };
    });
    assert.ok(fit.paperHeight <= fit.stageHeight - 50, '默认适应画布应展示整张作品');
    assert.ok(fit.top >= fit.stageTop && fit.bottom <= fit.stageBottom);
    await screenshot('01_initial.png');
    console.log('PASS：离线启动、SVG 预览、四来源与十条测试文本');

    await page.locator('#text-input').fill('宁静致远，宁静致远');
    await waitText('宁静致远宁静致远');
    await page.locator('#preview-document [data-index="1"]').click();
    await page.waitForFunction(() => document.getElementById('selected-char').textContent === '静'
      && document.querySelectorAll('.candidate-card').length === 4);
    await page.locator('.candidate-card[data-source="江西拙楷"]').click();
    await waitSource(1, '江西拙楷');
    let chosen = await sources();
    assert.equal(chosen[0], '演示夏行楷'); assert.equal(chosen[5], '演示夏行楷');
    await page.locator('#reset-glyph').click();
    await waitSource(1, '演示夏行楷');
    await page.waitForFunction(() => document.querySelector('.candidate-card[data-source="江西拙楷"]')?.disabled === false);
    await page.locator('.candidate-card[data-source="江西拙楷"]').click();
    await waitSource(1, '江西拙楷');
    await screenshot('02_candidate_switch.png');
    console.log('PASS：点击静字切候选，重复字互不影响，恢复后可再次替换');

    await page.locator('#char-size').fill('180');
    await page.locator('#char-gap').fill('30');
    await waitSource(1, '江西拙楷');
    await page.locator('#direction-select').selectOption('horizontal');
    await page.waitForFunction(() => document.querySelector('#preview-document #body')?.dataset.direction === 'horizontal'
      && !document.getElementById('export-button').disabled);
    await page.locator('#grid-toggle').check();
    await page.waitForFunction(() => document.querySelectorAll('#preview-document .grid').length === 8
      && !document.getElementById('export-button').disabled);
    await page.locator('#placeholders-toggle').check();
    await page.waitForFunction(() => document.querySelectorAll('#preview-document [data-placeholder="true"]').length === 3
      && !document.getElementById('export-button').disabled);
    await screenshot('03_horizontal.png');
    await page.locator('#direction-select').selectOption('vertical');
    await page.waitForFunction(() => document.querySelector('#preview-document #body')?.dataset.direction === 'vertical'
      && !document.getElementById('export-button').disabled);
    await page.locator('#export-button').click();
    await page.waitForFunction(() => document.getElementById('toast').textContent.startsWith('已导出：'));
    const metadata = await sharp(path.join(OUT, 'gui_export.png')).metadata();
    assert.equal(metadata.width, 2560);
    const exported = await application.evaluate(() => globalThis.b4Audit.exports.at(-1));
    assert.equal(exported.cells[1].source, '江西拙楷');
    assert.equal(exported.cells[5].source, '演示夏行楷');
    assert.equal(exported.style.char_size, 180); assert.equal(exported.style.char_gap, 30);
    await screenshot('04_export.png');
    console.log('PASS：字号字距、横竖排、米字格、占位框与真实 2560px PNG 导出');

    await page.locator('#source-select').selectOption('鸿雷行书简体');
    await waitSource(1, '鸿雷行书简体');
    assert.ok((await sources()).every(source => source === '鸿雷行书简体'));
    await page.locator('#text-input').fill('春风');
    await page.waitForFunction(() => document.getElementById('input-error').textContent.includes('春')
      && !document.getElementById('input-error').hidden && document.getElementById('export-button').disabled);
    assert.equal(await page.locator('#preview-document svg').count(), 0);
    await screenshot('05_missing.png');
    await page.locator('#text-input').fill('');
    await page.waitForFunction(() => document.getElementById('render-status').textContent === '请输入正文');
    assert.equal(await page.locator('#preview-document svg').count(), 0);
    await page.locator('#text-input').fill('海内');
    await page.locator('#text-input').fill('宁静致远');
    await waitText('宁静致远');
    console.log('PASS：整篇来源切换、缺字和空文不导出旧图、快速编辑无旧请求覆盖');

    await page.locator('#reset-style').click();
    await waitSource(0, '演示夏行楷');
    const presets = (await fs.readFile(path.join(ROOT, 'test_texts.txt'), 'utf8')).trim().split(/\r?\n/);
    for (let index = 0; index < presets.length; index++) {
      await page.locator('#sample-select').selectOption(String(index));
      await waitText(presets[index].replace(/[\p{P}\p{C}\p{Z}\s]/gu, ''));
    }
    await page.locator('#sample-select').selectOption('0');
    await waitText('海内存知己天涯若比邻');
    await page.locator('#preview-document [data-index="1"]').click();
    await page.waitForFunction(() => document.getElementById('selected-char').textContent === '内'
      && document.querySelectorAll('.candidate-card').length === 4);
    await page.locator('.candidate-card[data-source="江西拙楷"]').click();
    await waitSource(1, '江西拙楷');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1050, 720));
    await page.waitForFunction(() => innerWidth <= 1050 && innerHeight <= 720);
    await page.locator('#fit-preview').click();
    await screenshot('06_compact.png');
    const compact = await page.evaluate(() => {
      const stage = document.getElementById('preview-stage').getBoundingClientRect();
      const paper = document.getElementById('preview-document').getBoundingClientRect();
      return { fits: paper.top >= stage.top && paper.bottom <= stage.bottom,
        noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth };
    });
    assert.ok(compact.fits && compact.noHorizontalOverflow, '最小窗口仍应显示整张作品');
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 940));
    await page.waitForFunction(() => innerWidth > 1050);
    await page.locator('#fit-preview').click();
    await screenshot('ready.png');
    const audit = await application.evaluate(() => globalThis.b4Audit);
    assert.equal(audit.networkRequests.length, 0);
    assert.deepEqual(errors, []);
    const report = { passed: true, electron: require('electron/package.json').version,
      renderer_offline: true, app_network_request_count: audit.networkRequests.length,
      presets_verified: presets.length, candidate_count: 4, single_occurrence_switch: true,
      shared_style_fields: ['text', 'font', 'direction', 'char_size', 'char_gap', 'line_gap', 'grid', 'margin'],
      png_width: metadata.width, export: 'output/b4/gui_export.png', preview: 'output/b4/ready.png',
      export_current_selections: true, empty_and_missing_do_not_export_stale_preview: true,
      preview_fits_default_and_minimum_window: true,
      renderer_errors: errors, render_count: audit.renders };
    await fs.writeFile(path.join(OUT, 'acceptance_report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log('B4 自测通过：真实 Electron 界面全流程，网络请求 0，截图及报告在 output/b4/。');
  } catch (error) {
    if (page) {
      await page.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => {});
      const state = await page.locator('body').innerText().catch(() => '');
      console.error(state.slice(0, 3000));
    }
    throw error;
  } finally { await application.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
