'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const offlineCheck = process.argv.includes('--offline-check');
let networkAttempts = 0;
if (offlineCheck) {
  const deny = () => { networkAttempts++; throw new Error('B5 离线验收禁止网络 API'); };
  for (const name of ['node:http', 'node:https']) {
    const client = require(name);
    client.get = deny; client.request = deny;
  }
  require('node:net').Socket.prototype.connect = deny;
  globalThis.fetch = deny;
}
const sharp = require('sharp');
const { layout, exportPng } = require('../layout');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'output', 'b5');

async function main() {
  const texts = (await fs.readFile(path.join(ROOT, 'test_texts.txt'), 'utf8')).replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  assert.equal(texts.length, 10);
  await fs.mkdir(OUT, { recursive: true });
  const results = [], imageCache = new Map();
  for (let index = 0; index < texts.length; index++) {
    const text = texts[index];
    const result = await layout({ text, font: '演示夏行楷', direction: 'vertical', imageCache });
    const prefix = path.join(OUT, `${String(index + 1).padStart(2, '0')}_演示夏行楷`);
    const png = await exportPng(result, `${prefix}.png`);
    await fs.writeFile(`${prefix}.svg`, result.svg, 'utf8');
    const { svg, ...report } = result;
    await fs.writeFile(`${prefix}.json`, JSON.stringify({ ...report, png: { width: png.width, height: png.height } }, null, 2), 'utf8');
    const expected = text.replace(/[\p{P}\p{C}\p{Z}\s]/gu, '');
    assert.equal(result.rendered_text, expected);
    assert.equal(result.cells.length, Array.from(expected).length);
    assert.equal(result.lines.join(''), expected);
    assert.equal((result.svg.match(/<image /g) || []).length, result.cells.length);
    for (const line of result.lines) assert.ok(!/\p{P}/u.test(Array.from(line)[0]));
    const first = result.cells.filter(cell => cell.offset === 0);
    for (let col = 1; col < first.length; col++) assert.ok(first[col - 1].box.x > first[col].box.x);
    for (const cell of result.cells) {
      const { box, draw_box: ink } = cell;
      assert.ok(ink.x >= box.x && ink.y >= box.y);
      assert.ok(ink.x + ink.width <= box.x + box.width + 1e-8);
      assert.ok(ink.y + ink.height <= box.y + box.height + 1e-8);
      assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= result.width && box.y + box.height <= result.height);
    }
    const metadata = await sharp(`${prefix}.png`).metadata();
    assert.equal(metadata.width, 2560);
    assert.equal(metadata.height, png.height);
    // 对最终栅格逐字检查实际墨迹，不只核对布局元数据。
    const scaleX = png.width / result.width, scaleY = png.height / result.height;
    const { data, info } = await sharp(png.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    for (const cell of result.cells) {
      const left = Math.round(cell.box.x * scaleX), top = Math.round(cell.box.y * scaleY);
      const width = Math.min(Math.round(cell.box.width * scaleX), png.width - left);
      const height = Math.min(Math.round(cell.box.height * scaleY), png.height - top);
      let inkPixels = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const p = ((top + y) * info.width + left + x) * info.channels;
          if (data[p] < 100 && data[p + 1] < 100 && data[p + 2] < 100) {
            inkPixels++;
            assert.ok(x > 0 && y > 0 && x < width - 1 && y < height - 1, '墨迹触及字身框边缘');
          }
        }
      }
      assert.ok(inkPixels > 0, `字形没有栅格墨迹：${cell.char}`);
    }
    results.push({ text, svg: path.relative(ROOT, `${prefix}.svg`).replaceAll('\\', '/'),
      png: path.relative(ROOT, `${prefix}.png`).replaceAll('\\', '/'), width: png.width, height: png.height,
      character_count: result.cells.length, columns_right_to_left: result.lines,
      no_punctuation: true, no_overflow: true, actual_ink_verified: true, passed: true });
    console.log(`[${index + 1}/10] SVG + PNG ${png.width}×${png.height}：${text}`);
  }
  for (const [name, options] of [
    ['horizontal', { direction: 'horizontal', line_length: 5 }],
    ['placeholders', { elements: { signature: true, head_seal: true, name_seal: true }, grid: true }],
  ]) {
    const result = await layout({ text: texts[0], font: '演示夏行楷', imageCache, ...options });
    await fs.writeFile(path.join(OUT, `${name}.svg`), result.svg, 'utf8');
    await exportPng(result, path.join(OUT, `${name}.png`));
  }
  const summary = { total: 10, passed: results.length, source: '演示夏行楷', manifest_format: 'glyph-manifest-v1',
    png_width: 2560, no_punctuation: true, no_overflow: true, vertical_right_to_left: true,
    actual_ink_verified: true, network_api_disabled: offlineCheck, network_attempt_count: networkAttempts, results };
  assert.equal(networkAttempts, 0);
  await fs.writeFile(path.join(OUT, 'acceptance_report.json'), JSON.stringify(summary, null, 2), 'utf8');
  const thumbnails = [];
  for (let index = 0; index < results.length; index++) {
    const { data, info } = await sharp(path.join(ROOT, results[index].png))
      .resize({ width: 280, height: 560, fit: 'inside' }).png().toBuffer({ resolveWithObject: true });
    thumbnails.push({ input: data, left: (index % 5) * 320 + Math.round((320 - info.width) / 2),
      top: Math.floor(index / 5) * 600 + Math.round((600 - info.height) / 2) });
  }
  await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#E9E3D7' } })
    .composite(thumbnails).png().toFile(path.join(OUT, 'contact_sheet.png'));
  console.log('B5 自测通过：10/10 SVG+PNG；横排和占位元素样张已生成。');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
