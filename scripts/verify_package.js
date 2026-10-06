'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { ROOT, FONT_FILES, FORBIDDEN } = require('./prepare_package');

async function verify(applicationDir = path.join(ROOT, 'dist', 'win-unpacked')) {
  const asar = await import('@electron/asar');
  const filename = path.join(applicationDir, 'resources', 'app.asar');
  const extract = file => asar.extractFile(filename, path.normalize(file));
  const entries = asar.listPackage(filename).map(file => file.replaceAll('\\', '/').replace(/^\//, ''));
  assert.ok(entries.every(file => !FORBIDDEN.test(file)), '禁止字体不得进入 asar');
  assert.ok(entries.every(file => !/^(.venv|tests|scripts|output)\//.test(file)), '开发/验收文件不得进包');
  const fontEntries = entries.filter(file => /^fonts\/.*\.(ttf|otf)$/i.test(file)).map(file => path.basename(file)).sort();
  assert.deepEqual(fontEntries, [...FONT_FILES].sort());
  for (const file of FONT_FILES) {
    const packedHash = crypto.createHash('sha256').update(extract(`fonts/${file}`)).digest('hex');
    const sourceHash = crypto.createHash('sha256').update(await fs.readFile(path.join(ROOT, 'fonts', file))).digest('hex');
    assert.equal(packedHash, sourceHash, `字体应保留原始文件：${file}`);
  }
  const manifest = JSON.parse(extract('docs/glyph_manifest.json').toString('utf8'));
  assert.equal(manifest.format, 'glyph-manifest-v1');
  let count = 0;
  for (const [char, variants] of Object.entries(manifest.chars)) {
    assert.equal(Object.keys(variants).length, 4, `${char} 应有四候选`);
    for (const file of Object.values(variants)) {
      assert.equal(path.isAbsolute(file), false, '包内 manifest 不得含开发机绝对路径');
      assert.ok(entries.includes(file), `包中缺图：${file}`);
      const image = extract(file);
      const metadata = await sharp(image).metadata();
      assert.equal(metadata.width, 256); assert.equal(metadata.height, 256);
      assert.equal(metadata.hasAlpha, true);
      const alpha = (await sharp(image).stats()).channels[3];
      assert.equal(alpha.min, 0); assert.ok(alpha.max > 0, `应有透明背景和墨迹：${file}`);
      assert.equal(image.subarray(1, 4).toString(), 'PNG'); count++;
    }
  }
  assert.equal(Object.keys(manifest.chars).length, 81); assert.equal(count, 324);
  for (const file of ['app/main.js', 'app/preload.js', 'layout.js', 'test_texts.txt', 'docs/data_slots.json',
    'docs/DATA_NOTICE.txt', 'fonts/licenses/OFL-LXGWWenKai.txt', 'glyph_images/README.md']) assert.ok(entries.includes(file), `缺必备文件：${file}`);
  assert.ok(!entries.includes('glyphs.db') && !entries.includes('encoder.onnx'), '占位版不得伪装存在真迹库/模型');
  const nativeEntries = entries.filter(file => /^node_modules\/@img\/sharp-win32-x64\/lib\/sharp-win32-x64(?:-[\d.]+)?\.node$/.test(file));
  assert.equal(nativeEntries.length, 1, '应包含唯一的 Windows x64 Sharp 模块');
  for (const file of [...nativeEntries,
    'node_modules/@img/sharp-win32-x64/lib/libvips-42.dll',
    'node_modules/@img/sharp-win32-x64/lib/libvips-cpp-8.18.6.dll']) {
    assert.ok(entries.includes(file), `缺原生依赖：${file}`);
    await fs.access(path.join(applicationDir, 'resources', 'app.asar.unpacked', file));
  }
  const pkg = require('../package.json');
  const installer = path.join(ROOT, 'dist', `AI-Jizi-Placeholder-Setup-${pkg.version}-x64.exe`);
  const installerBytes = await fs.readFile(installer);
  assert.equal(installerBytes.subarray(0, 2).toString(), 'MZ');
  const sha256 = crypto.createHash('sha256').update(installerBytes).digest('hex');
  await fs.writeFile(`${installer}.sha256`, `${sha256}  ${path.basename(installer)}\n`, 'utf8');
  const report = { passed: true, installer, sha256, bytes: installerBytes.length,
    asar: filename, asar_entries: entries.length, chars: 81, images: count,
    fonts: fontEntries, forbidden_font_found: false, manifest_paths_relative: true,
    native_runtime_unpacked: true, fake_mccd_files: false,
    glyph_size: [256, 256], transparent_background: true, original_font_bytes_preserved: true,
    reserved: JSON.parse(extract('docs/data_slots.json').toString('utf8')).reserved };
  await fs.writeFile(path.join(ROOT, 'output', 'b8', 'package_report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`包检查通过：81×4 PNG / 相对路径 / 无禁用字体 / native unpacked；SHA256 ${sha256}`);
  return report;
}
if (require.main === module) verify(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { verify };
