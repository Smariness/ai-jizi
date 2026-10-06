'use strict';
const path = require('node:path');
const pkg = require('./package.json');

module.exports = {
  appId: 'cn.ai-jizi.placeholder',
  productName: '集字工作台（占位版）',
  electronVersion: pkg.devDependencies.electron,
  electronDist: path.join(__dirname, 'node_modules', 'electron', 'dist'),
  directories: { app: 'build/staging', output: 'dist', buildResources: 'build/resources' },
  asar: true,
  asarUnpack: ['node_modules/@img/**/*', 'node_modules/sharp/**/*'],
  files: ['**/*', '!package-lock.json', '!node_modules/**/test/**', '!node_modules/**/tests/**'],
  extraResources: [{ from: 'docs/DATA_NOTICE.txt', to: '数据与授权说明.txt' },
    { from: 'docs/LICENSE_RECORD.md', to: '字体授权核对台账.md' }],
  compression: 'maximum',
  npmRebuild: false,
  buildDependenciesFromSource: false,
  electronLanguages: ['zh-CN', 'en-US'],
  publish: null,
  toolsets: { nsis: '0.0.0', winCodeSign: '1.1.0' },
  win: { target: [{ target: 'nsis', arch: ['x64'] }], executableName: 'AI-Jizi',
    icon: 'build/resources/icon.ico', signExecutable: false },
  nsis: {
    guid: 'e3f2c2f4-e88d-4f9f-8f9a-b8aeae1a0021',
    artifactName: 'AI-Jizi-Placeholder-Setup-${version}-x64.${ext}',
    oneClick: false, perMachine: false, allowElevation: false,
    allowToChangeInstallationDirectory: true, selectPerMachineByDefault: false,
    createDesktopShortcut: true, createStartMenuShortcut: true,
    shortcutName: '集字工作台（占位版）',
    deleteAppDataOnUninstall: false, runAfterFinish: false, packElevateHelper: false,
    installerLanguages: ['zh_CN', 'en_US'], language: '2052',
    license: 'build/resources/installer-license.txt',
  },
};
