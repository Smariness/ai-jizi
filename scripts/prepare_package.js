'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const ROOT = path.join(__dirname, '..');
const STAGE = path.join(ROOT, 'build', 'staging');
const FONT_FILES = ['SlideXiaxing.ttf', 'JiangXiZhuoKai.ttf', 'HongLeiXingShu.otf', 'LXGWWenKai-Regular.ttf'];
const APP_FILES = ['main.js', 'preload.js', 'service.js', 'renderer.js', 'index.html', 'styles.css'];
const FORBIDDEN = /庞门|龐門|pangmen|pang.?men.?zheng.?dao/i;

function assertDistributableManifest(manifest) {
  if (manifest.local_only === true || /shufaziti|glyphs_shufaziti|data[\\/]cache/i.test(JSON.stringify(manifest))) {
    throw new Error('shufaziti 字形、索引和缓存仅限本地开发，禁止进入安装包。请使用独立的可分发 manifest。');
  }
}

function portable(filename) {
  if (typeof filename !== 'string' || !filename || /^(https?:|data:)/i.test(filename)) throw new Error('打包仅接受本地图路径');
  const absolute = path.isAbsolute(filename) ? path.resolve(filename) : path.resolve(ROOT, filename);
  const relative = path.relative(ROOT, absolute).replaceAll('\\', '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative) || FORBIDDEN.test(relative)) throw new Error(`路径不可打包：${filename}`);
  if (!/^(glyphs_placeholder|glyph_images|fonts)\//.test(relative)) throw new Error(`图路径超出字库目录：${relative}`);
  return relative;
}

async function copy(relative) {
  const absolute = path.join(ROOT, relative);
  const real = await fs.realpath(absolute);
  const prefix = `${await fs.realpath(ROOT)}${path.sep}`;
  if (!real.startsWith(prefix)) throw new Error(`文件实际路径超出项目：${relative}`);
  const destination = path.join(STAGE, relative);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(absolute, destination);
}

async function prepare() {
  // 只重建本脚本拥有的 staging；拒绝目录联接和指向仓外的实际路径。
  assert.equal(path.dirname(STAGE), path.join(ROOT, 'build'));
  if (await fs.lstat(STAGE).catch(() => null)) {
    assert.equal(await fs.realpath(STAGE), STAGE);
    await fs.rm(STAGE, { recursive: true, force: true });
  }
  await fs.mkdir(STAGE, { recursive: true });
  const original = JSON.parse(await fs.readFile(path.join(ROOT, 'docs', 'glyph_manifest.json'), 'utf8'));
  assert.equal(original.format, 'glyph-manifest-v1');
  assertDistributableManifest(original);
  const manifest = structuredClone(original);
  const images = new Set();
  for (const [source, info] of Object.entries(manifest.fonts || {})) {
    if (FORBIDDEN.test(source)) throw new Error(`禁止打包的来源：${source}`);
    info.path = portable(info.path);
    if (!FONT_FILES.includes(path.basename(info.path))) throw new Error(`字体不在白名单：${info.path}`);
    info.dir = portable(info.dir);
  }
  for (const variants of Object.values(manifest.chars)) {
    for (const [source, filename] of Object.entries(variants)) {
      if (FORBIDDEN.test(source)) throw new Error(`禁止打包的字形来源：${source}`);
      const relative = portable(filename);
      if (!relative.endsWith('.png')) throw new Error('字形必须是 PNG');
      variants[source] = relative;
      images.add(relative);
    }
  }
  for (const file of APP_FILES) await copy(`app/${file}`);
  for (const file of ['layout.js', 'test_texts.txt', 'docs/DATA_NOTICE.txt', 'docs/LICENSE_RECORD.md', 'docs/data_slots.json',
    'fonts/licenses/OFL-LXGWWenKai.txt', 'fonts/licenses/字体内嵌版权.txt']) await copy(file);
  for (const file of FONT_FILES) await copy(`fonts/${file}`);
  for (const file of images) await copy(file);
  // 当前 B8 是占位版。根目录 glyphs.db 是含本地受限来源的研究库；
  // 不得因它恰好存在就捎带打包。未来授权真迹版须显式选择独立分发库。
  await fs.mkdir(path.join(STAGE, 'glyph_images'), { recursive: true });
  await fs.writeFile(path.join(STAGE, 'glyph_images', 'README.md'), '预留真迹透明 PNG 字形目录。数据库及模型尚未到位；准备实际资源和 v1 manifest 后重打包。\n');
  await fs.mkdir(path.join(STAGE, 'docs'), { recursive: true });
  await fs.writeFile(path.join(STAGE, 'docs', 'glyph_manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const appPackage = { name: pkg.name, version: pkg.version, description: pkg.description,
    author: pkg.author, private: true, type: 'commonjs', main: 'app/main.js', dependencies: pkg.dependencies };
  await fs.writeFile(path.join(STAGE, 'package.json'), JSON.stringify(appPackage, null, 2), 'utf8');
  const lock = JSON.parse(await fs.readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
  delete lock.packages[''].devDependencies;
  for (const [key, info] of Object.entries(lock.packages)) if (info.dev === true) delete lock.packages[key];
  await fs.writeFile(path.join(STAGE, 'package-lock.json'), JSON.stringify(lock, null, 2), 'utf8');
  // 从本机缓存安装生产依赖。此步骤不会取得 Electron 或构建工具。
  const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const installed = spawnSync(process.execPath, [npm, 'ci', '--offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: STAGE, stdio: 'inherit', env: process.env });
  if (installed.status !== 0) throw new Error(`生产依赖离线恢复失败：${installed.status}`);

  const resources = path.join(ROOT, 'build', 'resources');
  await fs.mkdir(resources, { recursive: true });
  await fs.writeFile(path.join(resources, 'installer-license.txt'), '\uFEFF' + await fs.readFile(path.join(ROOT, 'docs/DATA_NOTICE.txt'), 'utf8'), 'utf8');
  // 自绘印章图标，不依赖任何额外字体。
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect x="14" y="14" width="228" height="228" rx="28" fill="#9d4335"/><g stroke="#fff8e9" stroke-width="14" fill="none" stroke-linecap="square" stroke-linejoin="miter"><path d="M128 48v14M64 91V76h128v15M88 115h77l-36 28v48M73 154h111M102 192h27"/></g></svg>';
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  const ico = Buffer.alloc(22);
  ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
  ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
  await fs.writeFile(path.join(resources, 'icon.ico'), Buffer.concat([ico, png]));
  const report = { edition: 'placeholder', chars: Object.keys(manifest.chars).length,
    sources: Object.keys(manifest.fonts), images: images.size, fonts: FONT_FILES,
    relative_manifest: true, forbidden_font_included: false,
    research_database_included: false, restricted_source_included: false,
    source_manifest_sha256: crypto.createHash('sha256').update(await fs.readFile(path.join(ROOT, 'docs/glyph_manifest.json'))).digest('hex') };
  await fs.mkdir(path.join(ROOT, 'output', 'b8'), { recursive: true });
  await fs.writeFile(path.join(ROOT, 'output', 'b8', 'staging_report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`B8 staging ready: ${report.chars} 字 / ${report.images} PNG；四字体白名单，相对路径 manifest。`);
  return report;
}

if (require.main === module) prepare().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { prepare, ROOT, STAGE, FONT_FILES, portable, FORBIDDEN, assertDistributableManifest };
