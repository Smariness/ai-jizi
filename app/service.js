'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { layout, exportPng, loadManifest, normalizeText, normalizeStyle } = require('../layout');

const ROOT = path.join(__dirname, '..');
const FIELDS = ['text', 'font', 'direction', 'char_size', 'char_gap', 'line_gap', 'grid', 'margin', 'line_length'];

class JiziService {
  constructor(manifestPath = path.join(ROOT, 'docs', 'glyph_manifest.json')) {
    this.manifestPath = manifestPath;
    this.imageCache = new Map();
    this.ready = this.initialize();
  }

  async initialize() {
    const loaded = await loadManifest(this.manifestPath);
    this.manifest = loaded.manifest;
    this.projectRoot = loaded.projectRoot;
    const chars = Object.values(this.manifest.chars);
    this.sources = [...new Set([...Object.keys(this.manifest.fonts || {}), ...chars.flatMap(Object.keys)])];
    this.presets = (await fs.readFile(path.join(this.projectRoot, 'test_texts.txt'), 'utf8'))
      .replace(/^\uFEFF/, '').split(/\r?\n/).map(text => text.trim()).filter(Boolean);
    if (!this.sources.length) throw new Error('本地字库没有可用来源');
  }

  async bootstrap() {
    await this.ready;
    return { sources: this.sources.map(name => ({ name,
      coverage: Object.values(this.manifest.chars).filter(variants => variants[name]).length })),
    characterCount: Object.keys(this.manifest.chars).length, presets: this.presets,
    defaultStyle: { text: this.presets[0] || '', font: this.sources[0], direction: 'vertical',
      char_size: 160, char_gap: 24, line_gap: 40, grid: false, margin: 80, line_length: 5 } };
  }

  async request(payload) {
    await this.ready;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('无效的排版请求');
    const style = Object.fromEntries(FIELDS.filter(key => payload.style?.[key] !== undefined)
      .map(key => [key, payload.style[key]]));
    const normalized = normalizeStyle(style);
    const text = normalizeText(style.text);
    if (!this.sources.includes(style.font)) throw new Error('请选择本地字库中的来源');
    const chars = Array.from(text.replaceAll('\n', ''));
    if (chars.length > 5000) throw new Error('正文最多 5000 字，请分篇生成');
    const selections = {};
    if (payload.selections !== undefined && (!payload.selections || typeof payload.selections !== 'object' || Array.isArray(payload.selections))) {
      throw new Error('候选字选择格式无效');
    }
    for (const [index, source] of Object.entries(payload.selections || {})) {
      if (!/^(0|[1-9]\d*)$/.test(index) || Number(index) >= chars.length || typeof source !== 'string') throw new Error('候选字序号无效');
      if (!this.manifest.chars[chars[Number(index)]]?.[source]) throw new Error('指定的候选字不可用');
      selections[index] = source;
    }
    const missing = [...new Set(chars.filter((char, index) => !this.manifest.chars[char]?.[selections[index] || style.font]))];
    if (missing.length) {
      const error = new Error(`当前来源尚未收录：${missing.join('、')}`);
      error.missing = missing;
      throw error;
    }
    // Renderer 无法传入任意文件路径、manifest 或引擎内部缓存。
    return { ...normalized, text: style.text, selections, elements: payload.placeholders === true
      ? { signature: true, head_seal: true, name_seal: true } : {} };
  }

  async render(payload) {
    const request = await this.request(payload);
    if (!normalizeText(request.text)) return { empty: true, svg: '', cells: [], lines: [], style: request };
    return { ...await layout({ ...request, manifest: this.manifest, projectRoot: this.projectRoot, imageCache: this.imageCache }), empty: false };
  }

  async candidates(char) {
    await this.ready;
    if (typeof char !== 'string' || Array.from(char).length !== 1) throw new Error('请先选中一个字');
    const variants = this.manifest.chars[char];
    if (!variants) throw new Error('这个字暂无候选');
    return Promise.all(Object.entries(variants).map(async ([source, filename]) => {
      if (typeof filename !== 'string' || /^(https?:|data:)/i.test(filename)) throw new Error('候选字必须来自本地字库');
      const absolute = path.isAbsolute(filename) ? filename : path.resolve(this.projectRoot, filename);
      const buffer = await fs.readFile(absolute);
      return { source, image: `data:image/png;base64,${buffer.toString('base64')}` };
    }));
  }

  async export(payload, filename) {
    const result = await this.render(payload);
    if (result.empty) throw new Error('请输入正文后再导出');
    const exported = await exportPng(result, filename);
    return { path: filename, width: exported.width, height: exported.height,
      rendered_text: result.rendered_text, cells: result.cells, style: result.style };
  }
}

module.exports = { JiziService, ROOT };
