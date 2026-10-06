'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const { prepare, ROOT } = require('./prepare_package');

async function main() {
  await prepare();
  const toolchain = path.join(ROOT, 'build', 'toolchain');
  process.env.ELECTRON_BUILDER_NSIS_DIR = path.join(toolchain, 'nsis-3.0.4.1');
  process.env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR = path.join(toolchain, 'nsis-resources-3.4.1');
  process.env.ELECTRON_BUILDER_RCEDIT_PATH = path.join(toolchain, 'rcedit');
  process.env.ELECTRON_BUILDER_7ZIP_PATH = path.join(toolchain, '7za.exe');
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  for (const file of [path.join(process.env.ELECTRON_BUILDER_NSIS_DIR, 'Bin', 'makensis.exe'),
    path.join(process.env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR, 'plugins', 'x86-unicode', 'nsis7z.dll'),
    path.join(process.env.ELECTRON_BUILDER_RCEDIT_PATH, 'rcedit-x64.exe'), process.env.ELECTRON_BUILDER_7ZIP_PATH]) await fs.access(file);
  // 构建阶段只使用显式本地工具；任何意外下载直接失败。
  let attempts = 0;
  globalThis.fetch = () => { attempts++; throw new Error('离线构建禁止 fetch'); };
  for (const protocol of ['node:http', 'node:https']) {
    const api = require(protocol);
    for (const method of ['get', 'request']) api[method] = () => { attempts++; throw new Error(`离线构建禁止 ${protocol}.${method}`); };
  }
  const { build } = require('electron-builder');
  const results = await build({ projectDir: ROOT, config: require('../electron-builder.cjs'), publish: 'never' });
  console.log(`NSIS 构建完成；Node 网络调用尝试 ${attempts}。`);
  await fs.writeFile(path.join(ROOT, 'output', 'b8', 'build_report.json'), JSON.stringify({
    artifacts: results, builder: require('electron-builder/package.json').version,
    electron: require('electron/package.json').version, offline_build: true,
    network_attempts: attempts, architecture: 'x64', target: 'nsis', gpu: 'disabled',
    signed: false, toolchain: 'build/toolchain',
  }, null, 2), 'utf8');
  await require('./verify_package').verify();
}
main().catch(error => { console.error(error); process.exit(1); });
