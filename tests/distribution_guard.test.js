'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertDistributableManifest } = require('../scripts/prepare_package');

test('restricted provenance is rejected even when the image path looks distributable', () => {
  const value = { format: 'glyph-manifest-v1', chars: { 海: { '颜真卿·多宝塔碑': 'glyph_images/clean.png' } },
    candidates: { 海: { '颜真卿·多宝塔碑': [{ origin: 'shufaziti' }] } } };
  assert.throws(() => assertDistributableManifest(value), /禁止进入安装包/);
  assert.throws(() => assertDistributableManifest({local_only: true}), /禁止进入安装包/);
});

test('accepted placeholder manifest remains distributable', () => {
  const value = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs/glyph_manifest.json'), 'utf8'));
  assert.doesNotThrow(() => assertDistributableManifest(value));
});
