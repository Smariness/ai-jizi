'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const sharp = require('sharp');
const { JiziService, ROOT } = require('../app/service');
const service = new JiziService();
let defaults;

test('GUI 与 ji.py 同项目，来源及十条测试文本来自磁盘', async () => {
  const data = await service.bootstrap();
  defaults = data.defaultStyle;
  assert.equal(data.sources.length, 4);
  assert.equal(data.characterCount, 81);
  assert.equal(data.presets.length, 10);
  assert.equal(service.projectRoot, ROOT);
  await fs.access(path.join(ROOT, 'ji.py'));
  for (const field of ['text', 'font', 'direction', 'char_size', 'char_gap', 'line_gap', 'grid', 'margin']) assert.ok(Object.hasOwn(defaults, field));
});

test('重复字按序号单独替换，不修改其他同字', async () => {
  const style = { ...(await service.bootstrap()).defaultStyle, text: '海，海' };
  const result = await service.render({ style, selections: { 1: '江西拙楷' } });
  assert.equal(result.rendered_text, '海海');
  assert.equal(result.cells[0].source, style.font);
  assert.equal(result.cells[1].source, '江西拙楷');
  assert.ok(result.svg.includes('data-index="1" data-char="海" data-source="江西拙楷"'));
  const candidates = await service.candidates('海');
  assert.equal(candidates.length, 4);
  assert.ok(candidates.every(candidate => candidate.image.startsWith('data:image/png;base64,')));
});

test('缺字明确报告、空正文不产生旧预览、不接受错误序号', async () => {
  const style = (await service.bootstrap()).defaultStyle;
  await assert.rejects(service.render({ style: { ...style, text: '春风' } }), error => {
    assert.deepEqual(error.missing, ['春', '风']); return true;
  });
  const empty = await service.render({ style: { ...style, text: ' ，。 \n' } });
  assert.equal(empty.empty, true);
  assert.equal(empty.svg, '');
  await assert.rejects(service.render({ style, selections: { 20: '江西拙楷' } }), /序号/);
  await assert.rejects(service.render({ style, selections: { 1: '未知来源' } }), /不可用/);
});

test('界面不能注入图路径或替换 manifest，只传共同样式字段', async () => {
  const style = (await service.bootstrap()).defaultStyle;
  const result = await service.render({ style, manifestPath: 'https://invalid.local/db',
    glyphs: ['C:/invalid.png'], projectRoot: 'C:/invalid' });
  assert.equal(result.cells[0].source, style.font);
  await assert.rejects(service.render({ style: { ...style, char_size: NaN } }), /char_size/);
});

test('导出真实 PNG，采用当前候选而非上一次预览', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jizi-service-'));
  try {
    const style = { ...(await service.bootstrap()).defaultStyle, text: '海海' };
    await service.render({ style });
    const result = await service.export({ style, selections: { 1: '江西拙楷' } }, path.join(directory, 'export.png'));
    assert.equal(result.cells[0].source, style.font);
    assert.equal(result.cells[1].source, '江西拙楷');
    assert.equal(result.width, 2560);
    const metadata = await sharp(result.path).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, 2560);
    assert.equal(metadata.height, result.height);
  } finally {
    const absolute = path.resolve(directory);
    assert.equal(path.dirname(absolute), path.resolve(os.tmpdir()));
    assert.ok(path.basename(absolute).startsWith('jizi-service-'));
    await fs.rm(absolute, { recursive: true, force: true });
  }
});
