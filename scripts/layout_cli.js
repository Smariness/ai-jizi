'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { layout, exportPng } = require('../layout');

async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    text: { type: 'string' }, config: { type: 'string' }, manifest: { type: 'string' },
    font: { type: 'string' }, direction: { type: 'string' }, size: { type: 'string' },
    'char-gap': { type: 'string' }, 'line-gap': { type: 'string' }, margin: { type: 'string' },
    'line-length': { type: 'string' }, width: { type: 'string' },
    grid: { type: 'boolean' }, placeholders: { type: 'boolean' },
    out: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('node layout.js --text "海内存知己，天涯若比邻" --font 演示夏行楷 --out output/b5/demo');
    console.log('支持 --config JSON、--direction vertical|horizontal、--size、--char-gap、--line-gap、--margin、--line-length、--grid、--placeholders、--width（默认2560）');
    return;
  }
  if (positionals.length > 1) throw new Error('只接受一个文本参数');
  const config = values.config ? JSON.parse((await fs.readFile(values.config, 'utf8')).replace(/^\uFEFF/, '')) : {};
  const options = { ...config };
  for (const key of ['text', 'font', 'direction']) if (values[key] !== undefined) options[key] = values[key];
  if (values.text === undefined && positionals[0] !== undefined) options.text = positionals[0];
  for (const [flag, field] of Object.entries({ size: 'char_size', 'char-gap': 'char_gap', 'line-gap': 'line_gap',
    margin: 'margin', 'line-length': 'line_length' })) {
    if (values[flag] !== undefined) options[field] = Number(values[flag]);
  }
  if (values.grid !== undefined) options.grid = values.grid;
  if (values.manifest) options.manifestPath = path.resolve(values.manifest);
  if (values.placeholders) options.elements = { signature: true, head_seal: true, name_seal: true };
  const result = await layout(options);
  const prefix = (values.out || path.join(__dirname, '..', 'output', 'b5', 'demo')).replace(/\.(svg|png)$/i, '');
  await fs.mkdir(path.dirname(path.resolve(prefix)), { recursive: true });
  const exported = await exportPng(result, `${prefix}.png`, { width: values.width === undefined ? undefined : Number(values.width) });
  await fs.writeFile(`${prefix}.svg`, result.svg, 'utf8');
  const { svg, ...report } = result;
  await fs.writeFile(`${prefix}.json`, JSON.stringify({ ...report, png: { width: exported.width, height: exported.height } }, null, 2), 'utf8');
  console.log(`已生成 ${path.resolve(prefix)}.svg + .png（${exported.width}×${exported.height}，${result.cells.length} 字）`);
}

module.exports = { main };
if (require.main === module) main().catch(error => { console.error(`错误：${error.message}`); process.exitCode = 2; });
