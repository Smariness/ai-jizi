'use strict';
// B1/B2 integration proof using B5's existing public interface unchanged.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { layout, exportPng, normalizeText, loadManifest } = require('../layout');
const { JiziService } = require('../app/service');
const ROOT = path.join(__dirname, '..');

async function main() {
  const manifestPath = path.join(ROOT, 'docs/glyph_manifest_real.json');
  const { manifest, projectRoot } = await loadManifest(manifestPath);
  const texts = (await fs.readFile(path.join(ROOT, 'test_texts.txt'), 'utf8')).trim().split(/\r?\n/);
  const directory = path.join(ROOT, 'output/b1_b2/layout');
  await fs.mkdir(directory, { recursive: true });
  const results = [], imageCache = new Map();
  for (const [i, text] of texts.entries()) {
    const chars = [...normalizeText(text).replaceAll('\n', '')];
    const selections = {};
    for (const [index, char] of chars.entries()) {
      const available = Object.keys(manifest.chars[char] || {});
      assert.ok(available.length, `missing real glyph: ${char}`);
      // A deterministic test fixture, not B6/B7 style scoring.
      selections[index] = available.includes('颜真卿·多宝塔碑') ? '颜真卿·多宝塔碑' : available[0];
    }
    const result = await layout({ text, manifest, projectRoot, imageCache, selections,
      font: selections[0], char_size: 128, margin: 64, line_length: 5 });
    const prefix = path.join(directory, `${String(i + 1).padStart(2, '0')}_real`);
    await fs.writeFile(`${prefix}.svg`, result.svg, 'utf8');
    await exportPng(result, `${prefix}.png`, { width: 1280 });
    const columnHeads = result.cells.filter(cell => cell.offset === 0);
    for (let j = 1; j < columnHeads.length; j++) assert.ok(columnHeads[j-1].box.x > columnHeads[j].box.x);
    for (const cell of result.cells) {
      const b = cell.box, d = cell.draw_box;
      assert.ok(!/[\p{P}\p{Z}]/u.test(cell.char));
      assert.ok(d.x >= b.x && d.y >= b.y && d.x + d.width <= b.x + b.width + 1e-7
        && d.y + d.height <= b.y + b.height + 1e-7);
      assert.ok(result.svg.includes(`data-index="${cell.index}"`));
      assert.ok(result.svg.includes(`data-char="${cell.char}"`));
      assert.equal(cell.source, selections[cell.index]);
    }
    results.push({ text, svg: `${prefix}.svg`, png: `${prefix}.png`, cells: result.cells,
      right_to_left: true, no_overflow: true, no_punctuation: true });
  }
  // Use the accepted B4 service with its existing manifest constructor.
  const service = new JiziService(manifestPath);
  const bootstrap = await service.bootstrap();
  const candidates = await service.candidates('海');
  assert.ok(candidates.length > 4 && candidates.every(c => c.image.startsWith('data:image/png;base64,')));
  const gui = await service.render({ style: { text: '海海', font: candidates[0].source }, selections: { 1: candidates[1].source } });
  assert.equal(gui.cells[0].source, candidates[0].source);
  assert.equal(gui.cells[1].source, candidates[1].source);
  const report = { passed: true, manifest: manifestPath, layout_code_changed: false,
    gui_service_code_changed: false, test_texts: results.length, gui_sources: bootstrap.sources.length,
    candidate_switch: true, results };
  await fs.writeFile(path.join(ROOT, 'output/b1_b2/layout_report.json'), JSON.stringify(report, null, 2));
  console.log(`Real-data integration PASS: ${results.length}/10 SVG+PNG, ${bootstrap.sources.length} GUI sources, candidate switch.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
