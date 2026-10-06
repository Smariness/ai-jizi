'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { layout, exportPng, normalizeText, STYLE_FIELDS } = require('../layout');

test('Unicode 去标点，保留简体、全角字母及手动换行', () => {
  assert.equal(normalizeText('“海内”，天涯！\r\n 宁静致远 ＡＢ１２'), '海内天涯\n宁静致远ＡＢ１２');
  assert.equal(normalizeText('，。 \n\t！'), '');
  assert.deepEqual(STYLE_FIELDS, ['text', 'font', 'direction', 'char_size', 'char_gap', 'line_gap', 'grid', 'margin']);
});

test('真实 manifest：竖排右起，每字嵌入 PNG，墨迹不越界', async () => {
  const result = await layout({ text: '海内存知己，天涯若比邻', font: '演示夏行楷' });
  assert.deepEqual(result.lines, ['海内存知己', '天涯若比邻']);
  assert.equal(result.cells.length, 10);
  assert.ok(result.cells[0].box.x > result.cells[5].box.x);
  assert.equal(result.cells[1].box.y - result.cells[0].box.y, 184);
  assert.equal(result.cells[0].source, '演示夏行楷');
  assert.equal((result.svg.match(/<image /g) || []).length, 10);
  assert.equal((result.svg.match(/href="data:image\/png;base64,/g) || []).length, 10);
  assert.ok(!result.svg.includes('，'));
  for (const { box, draw_box: ink } of result.cells) {
    assert.ok(ink.x >= box.x && ink.y >= box.y);
    assert.ok(ink.x + ink.width <= box.x + box.width + 1e-8);
    assert.ok(ink.y + ink.height <= box.y + box.height + 1e-8);
  }
});

test('横排支持 JSON 样式、字距行距及换行', async () => {
  const result = await layout({ style: { text: '海内存知己', font: '演示夏行楷', direction: 'horizontal',
    char_size: 100, char_gap: 5, line_gap: 30, margin: 20, grid: true, line_length: 3 } });
  assert.deepEqual(result.lines, ['海内存', '知己']);
  assert.equal(result.cells[1].box.x - result.cells[0].box.x, 105);
  assert.equal(result.cells[3].box.y - result.cells[0].box.y, 130);
  assert.equal(result.cells[0].box.x, 20);
  assert.ok(result.svg.includes('class="grid"'));
  const manual = await layout({ text: '海内\n存知己', font: '演示夏行楷', line_length: 5 });
  assert.deepEqual(manual.lines, ['海内', '存知己']);
});

async function fixtureImage(filename, width, height, box) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = box.top; y < box.top + box.height; y++) {
    for (let x = box.left; x < box.left + box.width; x++) pixels[(y * width + x) * 4 + 3] = 255;
  }
  await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toFile(filename);
}

async function removeTestDirectory(root) {
  const absolute = path.resolve(root);
  assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
  assert.match(path.basename(absolute), /^jizi-(layout|invalid)-/);
  await fs.rm(absolute, { recursive: true, force: true });
}

test('异尺寸异位置字形按 alpha 归一化，书家名称无需修改代码，SVG 独立于原文件', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jizi-layout-'));
  try {
    const a = path.join(root, 'a.png'), b = path.join(root, 'b.png');
    await fixtureImage(a, 100, 80, { left: 20, top: 7, width: 50, height: 60 });
    await fixtureImage(b, 300, 240, { left: 6, top: 80, width: 160, height: 40 });
    const manifest = { format: 'glyph-manifest-v1', fonts: { 王羲之: {} }, chars: { 海: { 王羲之: 'a.png' }, 内: { 王羲之: 'b.png' } } };
    const result = await layout({ text: '海内', manifest, projectRoot: root, background: null });
    assert.equal(result.style.font, '王羲之');
    assert.deepEqual(result.cells[0].ink_bbox, { left: 20, top: 7, width: 50, height: 60 });
    assert.equal(result.cells[0].draw_box.height, 144);
    assert.equal(result.cells[1].draw_box.width, 144);
    assert.equal(result.cells[1].draw_box.height, 36);
    const fromPaths = await layout({ text: '海，内', glyphs: [{ char: '海', source: '碑帖A', path: a }, b] });
    assert.equal(fromPaths.cells[0].source, '碑帖A');
    await fs.unlink(a); await fs.unlink(b);
    const png = await exportPng(result, undefined, { width: 512 });
    const metadata = await sharp(png.buffer).metadata();
    assert.equal(metadata.width, 512);
    assert.equal(metadata.hasAlpha, true);
  } finally { await removeTestDirectory(root); }
});

test('按字符序号切换候选来源，来源名正确 XML 转义', async () => {
  const result = await layout({ text: '海内', font: '演示夏行楷', selections: { 1: '江西拙楷' } });
  assert.equal(result.cells[0].source, '演示夏行楷');
  assert.equal(result.cells[1].source, '江西拙楷');
  const filename = path.join(__dirname, '..', 'glyphs_placeholder', '演示夏行楷', 'U+6D77_海.png');
  const escaped = await layout({ text: '海', glyphs: [{ path: filename, source: '碑帖"<&' }] });
  assert.ok(escaped.svg.includes('data-source="碑帖&quot;&lt;&amp;"'));
});

test('竖排和横排均保留落款、引首章、名章占位，互不覆盖正文', async () => {
  for (const direction of ['vertical', 'horizontal']) {
    const result = await layout({ text: '海内存知己', font: '演示夏行楷', direction,
      elements: { signature: true, head_seal: true, name_seal: true } });
    assert.deepEqual(result.elements.map(element => element.role), ['body', 'head_seal', 'signature', 'name_seal']);
    const body = result.elements[0];
    for (const element of result.elements) {
      assert.ok(element.x >= 0 && element.y >= 0);
      assert.ok(element.x + element.width <= result.width);
      assert.ok(element.y + element.height <= result.height);
      if (element.placeholder) {
        const intersects = element.x < body.x + body.width && element.x + element.width > body.x
          && element.y < body.y + body.height && element.y + element.height > body.y;
        assert.equal(intersects, false);
      }
    }
  }
});

test('空文、缺字、不合法样式及远程图路径直接报错', async () => {
  await assert.rejects(layout({ text: '，。！' }), /没有可排版字符/);
  await assert.rejects(layout({ text: '龘', font: '演示夏行楷' }), /字形缺失/);
  await assert.rejects(layout({ text: '海', char_gap: -1 }), /char_gap/);
  await assert.rejects(layout({ text: '海', grid: 'true' }), /grid/);
  await assert.rejects(layout({ text: '海', glyphs: [] }), /列表长度/);
  await assert.rejects(layout({ text: '海', glyphs: ['https://example.invalid/glyph.png'] }), /本地文件/);
  await assert.rejects(layout({ text: '海', selections: { 2: '江西拙楷' } }), /序号无效/);
});

test('透明空图与不透明图不当作有效墨迹', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jizi-invalid-'));
  try {
    for (const alpha of [0, 1]) {
      const filename = path.join(root, `${alpha}.png`);
      await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha } } }).png().toFile(filename);
      await assert.rejects(layout({ text: '海', glyphs: [filename] }), /没有可见墨迹|没有透明背景/);
    }
  } finally { await removeTestDirectory(root); }
});
