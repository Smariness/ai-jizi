'use strict';

// B5：只消费字形 PNG，来源可以是现代字体、书家或碑帖。
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

const DEFAULT_MANIFEST = path.join(__dirname, 'docs', 'glyph_manifest.json');
const STYLE_FIELDS = ['text', 'font', 'direction', 'char_size', 'char_gap', 'line_gap', 'grid', 'margin'];

function normalizeText(text) {
  if (typeof text !== 'string') throw new TypeError('text 必须是字符串');
  return text.replace(/\r\n?/g, '\n').split('\n')
    .map(line => line.replace(/[\p{P}\p{C}\p{Z}\s]/gu, ''))
    .filter(Boolean).join('\n');
}

function number(value, fallback, name, min, max) {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isFinite(result) || result < min || result > max) {
    throw new RangeError(`${name} 必须是 ${min}～${max} 范围内的数字`);
  }
  return result;
}

function normalizeStyle(input = {}) {
  const direction = ({ 'vertical-rtl': 'vertical', 'horizontal-ltr': 'horizontal' })[input.direction]
    || input.direction || 'vertical';
  if (!['vertical', 'horizontal'].includes(direction)) throw new Error('direction 只支持 vertical / horizontal');
  const size = number(input.char_size, 160, 'char_size', 16, 2048);
  const lineLength = number(input.line_length, direction === 'vertical' ? 5 : 10, 'line_length', 1, 200);
  if (!Number.isInteger(lineLength)) throw new Error('line_length 必须是整数');
  if (input.grid !== undefined && typeof input.grid !== 'boolean') throw new TypeError('grid 必须是布尔值');
  if (input.font !== undefined && (typeof input.font !== 'string' || !input.font)) throw new TypeError('font 必须是来源名称');
  const background = input.background === undefined ? '#F7F4EC' : input.background;
  if (background !== null && !/^#[0-9a-f]{6}$/i.test(background)) throw new Error('background 使用 #RRGGBB 或 null');
  return {
    text: input.text, font: input.font, direction, char_size: size,
    char_gap: number(input.char_gap, size * 0.15, 'char_gap', 0, 4096),
    line_gap: number(input.line_gap, size * 0.25, 'line_gap', 0, 4096),
    grid: input.grid ?? false, margin: number(input.margin, size * 0.5, 'margin', 0, 4096),
    line_length: lineLength,
    ink_padding: number(input.ink_padding, size * 0.05, 'ink_padding', 0, size * 0.4),
    background,
  };
}

function splitLines(text, length) {
  const lines = [];
  for (const line of text.split('\n')) {
    const chars = Array.from(line);
    for (let start = 0; start < chars.length; start += length) lines.push(chars.slice(start, start + length));
  }
  return lines;
}

async function loadManifest(filename = DEFAULT_MANIFEST) {
  const absolute = path.resolve(filename);
  const manifest = JSON.parse((await fs.readFile(absolute, 'utf8')).replace(/^\uFEFF/, ''));
  if (manifest.format !== 'glyph-manifest-v1' || !manifest.chars || typeof manifest.chars !== 'object') {
    throw new Error('需要 glyph-manifest-v1 格式及 chars 映射');
  }
  return { manifest, projectRoot: path.dirname(path.dirname(absolute)) };
}

function localPath(filename, projectRoot) {
  if (typeof filename !== 'string' || !filename || /^(https?:|data:)/i.test(filename)) {
    throw new Error('字形路径必须是本地文件路径');
  }
  return path.isAbsolute(filename) ? filename : path.resolve(projectRoot, filename);
}

async function glyphInputs(chars, options, style) {
  let manifest = options.manifest;
  let projectRoot = options.projectRoot || __dirname;
  if (!options.glyphs) {
    if (!manifest) ({ manifest, projectRoot } = await loadManifest(options.manifestPath));
    if (manifest.format !== 'glyph-manifest-v1' || !manifest.chars) throw new Error('manifest 格式错误');
    style.font ??= Object.keys(manifest.fonts || {})[0] || Object.keys(manifest.chars[chars[0]] || {})[0];
    if (!style.font) throw new Error('manifest 没有可用来源');
  }
  if (options.glyphs && (!Array.isArray(options.glyphs) || options.glyphs.length !== chars.length)) {
    throw new Error('glyphs 列表长度必须等于去标点、去空白后的字符数');
  }
  if (options.glyphs) style.font ??= 'provided';
  for (const key of Object.keys(options.selections || {})) {
    if (!/^\d+$/.test(key) || Number(key) >= chars.length) throw new Error(`候选字序号无效：${key}`);
  }
  return chars.map((char, index) => {
    if (options.glyphs) {
      const entry = options.glyphs[index];
      if (entry?.char !== undefined && entry.char !== char) throw new Error(`glyphs[${index}] 字符不一致`);
      const filename = typeof entry === 'string' ? entry : entry?.path;
      return { char, source: entry?.source || style.font || 'provided', path: localPath(filename, projectRoot) };
    }
    const source = options.selections?.[index] ?? style.font;
    const filename = manifest.chars[char]?.[source];
    if (!filename) throw new Error(`字形缺失：${char}，来源 ${source}，序号 ${index}`);
    return { char, source, path: localPath(filename, projectRoot) };
  });
}

async function readInk(filename, cache) {
  const stat = await fs.stat(filename);
  const key = `${filename}|${stat.size}|${stat.mtimeMs}`;
  if (cache.has(key)) return cache.get(key);
  const promise = (async () => {
    const buffer = await fs.readFile(filename);
    const metadata = await sharp(buffer).metadata();
    if (metadata.format !== 'png' || !metadata.hasAlpha) throw new Error(`字形必须是带透明背景的 PNG：${filename}`);
    const { data, info } = await sharp(buffer, { limitInputPixels: 16777216 })
      .toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let left = info.width, top = info.height, right = -1, bottom = -1, transparent = false;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const alpha = data[(y * info.width + x) * info.channels + info.channels - 1];
        if (alpha) {
          left = Math.min(left, x); top = Math.min(top, y);
          right = Math.max(right, x); bottom = Math.max(bottom, y);
        } else transparent = true;
      }
    }
    if (right < left) throw new Error(`字形没有可见墨迹：${filename}`);
    if (!transparent) throw new Error(`字形 PNG 没有透明背景：${filename}`);
    const bbox = { left, top, width: right - left + 1, height: bottom - top + 1 };
    const cropped = await sharp(buffer).extract(bbox).png().toBuffer();
    return { bbox, dataUri: `data:image/png;base64,${cropped.toString('base64')}` };
  })();
  cache.set(key, promise);
  try { return await promise; } catch (error) { cache.delete(key); throw error; }
}

function geometry(lines, style, requested = {}) {
  const enabled = role => requested[role] === true || requested[role]?.enabled === true;
  const size = style.char_size, gap = style.char_gap, lineGap = style.line_gap, margin = style.margin;
  const longest = Math.max(...lines.map(line => line.length));
  const vertical = style.direction === 'vertical';
  const bodyWidth = vertical ? lines.length * size + (lines.length - 1) * lineGap : longest * size + (longest - 1) * gap;
  const bodyHeight = vertical ? longest * size + (longest - 1) * gap : lines.length * size + (lines.length - 1) * lineGap;
  const seal = size * 0.45, signature = size * 0.6;
  const head = enabled('head_seal') ? seal + lineGap : 0;
  const rail = vertical && enabled('signature') ? signature + lineGap : 0;
  const signatureFooter = !vertical && enabled('signature') ? signature + lineGap : 0;
  const nameFooter = enabled('name_seal') ? seal + lineGap : 0;
  const body = { role: 'body', x: margin + rail, y: margin + head, width: bodyWidth, height: bodyHeight, placeholder: false };
  const elements = [body];
  if (head) elements.push({ role: 'head_seal', x: body.x + bodyWidth - seal, y: margin, width: seal, height: seal, placeholder: true });
  if (enabled('signature')) elements.push({ role: 'signature', x: vertical ? margin : body.x,
    y: vertical ? body.y : body.y + bodyHeight + lineGap,
    width: vertical ? signature : bodyWidth, height: vertical ? bodyHeight : signature, placeholder: true });
  if (nameFooter) elements.push({ role: 'name_seal', x: vertical && rail ? margin : body.x,
    y: body.y + bodyHeight + signatureFooter + lineGap, width: seal, height: seal, placeholder: true });
  return { width: margin * 2 + rail + bodyWidth,
    height: margin * 2 + head + bodyHeight + signatureFooter + nameFooter, body, elements };
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
}
const n = value => String(Math.round(value * 1000) / 1000);

function gridSvg(x, y, size) {
  const a = x + 0.5, b = y + 0.5, endX = x + size - 0.5, endY = y + size - 0.5;
  return `<g class="grid" fill="none" stroke="#CDBBA5" stroke-width="1">` +
    `<rect x="${n(a)}" y="${n(b)}" width="${n(size - 1)}" height="${n(size - 1)}"/>` +
    `<path stroke-dasharray="4 4" d="M${n(a)} ${n(b)}L${n(endX)} ${n(endY)}M${n(endX)} ${n(b)}L${n(a)} ${n(endY)}M${n(x + size / 2)} ${n(b)}V${n(endY)}M${n(a)} ${n(y + size / 2)}H${n(endX)}"/></g>`;
}

async function layout(options = {}) {
  const input = { ...options.style, ...options };
  const text = normalizeText(input.text);
  if (!text) throw new Error('去除标点和空白后没有可排版字符');
  const style = normalizeStyle(input);
  const lines = splitLines(text, style.line_length);
  const chars = lines.flat();
  if (chars.length > 5000) throw new Error('单篇最多 5000 字，请拆分文本');
  const inputs = await glyphInputs(chars, options, style);
  const geo = geometry(lines, style, options.elements);
  const cells = [], fragments = [];
  const cache = options.imageCache || new Map();
  let index = 0;
  for (let line = 0; line < lines.length; line++) {
    for (let offset = 0; offset < lines[line].length; offset++, index++) {
      const entry = inputs[index], ink = await readInk(entry.path, cache);
      const size = style.char_size;
      const vertical = style.direction === 'vertical';
      const x = vertical ? geo.body.x + geo.body.width - size - line * (size + style.line_gap)
        : geo.body.x + offset * (size + style.char_gap);
      const y = vertical ? geo.body.y + offset * (size + style.char_gap) : geo.body.y + line * (size + style.line_gap);
      const target = size - 2 * style.ink_padding;
      const scale = Math.min(target / ink.bbox.width, target / ink.bbox.height);
      const width = ink.bbox.width * scale, height = ink.bbox.height * scale;
      const drawBox = { x: x + (size - width) / 2, y: y + (size - height) / 2, width, height };
      const cell = { index, char: entry.char, source: entry.source, line, offset,
        box: { x, y, width: size, height: size }, ink_bbox: ink.bbox, draw_box: drawBox };
      cells.push(cell);
      if (style.grid) fragments.push(gridSvg(x, y, size));
      fragments.push(`<g id="glyph-${index}" data-index="${index}" data-char="${escapeXml(entry.char)}" data-source="${escapeXml(entry.source)}">` +
        `<image x="${n(drawBox.x)}" y="${n(drawBox.y)}" width="${n(width)}" height="${n(height)}" preserveAspectRatio="xMidYMid meet" href="${ink.dataUri}"/></g>`);
    }
  }
  const placeholders = geo.elements.filter(element => element.placeholder).map(element => {
    const label = { signature: '落款占位', head_seal: '引首章占位', name_seal: '名章占位' }[element.role];
    return `<g id="${element.role}" data-role="${element.role}" data-placeholder="true"><title>${label}</title>` +
      `<rect x="${n(element.x + 1)}" y="${n(element.y + 1)}" width="${n(element.width - 2)}" height="${n(element.height - 2)}" fill="none" stroke="${element.role === 'signature' ? '#998A77' : '#A84435'}" stroke-width="1" stroke-dasharray="5 4"/></g>`;
  }).join('');
  const background = style.background === null ? '' : `<rect width="100%" height="100%" fill="${style.background}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${n(geo.width)}" height="${n(geo.height)}" viewBox="0 0 ${n(geo.width)} ${n(geo.height)}">` +
    `<title>集字作品</title>${background}<g id="body" data-direction="${style.direction}">${fragments.join('')}</g>${placeholders}</svg>`;
  return { svg, width: geo.width, height: geo.height, input_text: input.text, rendered_text: chars.join(''),
    lines: lines.map(line => line.join('')), style, cells, elements: geo.elements };
}

async function exportPng(result, filename, options = {}) {
  const width = number(options.width, 2560, 'PNG width', 16, 8192);
  if (!Number.isInteger(width)) throw new Error('PNG width 必须是整数');
  const height = Math.max(1, Math.round(width * result.height / result.width));
  if (width * height > 64000000) throw new Error('导出超过 6400 万像素，请缩小宽度或减少每列字数');
  const density = Math.max(72, Math.ceil(72 * width / result.width));
  const buffer = await sharp(Buffer.from(result.svg), { density }).resize(width, height).png().toBuffer();
  if (filename) {
    await fs.mkdir(path.dirname(path.resolve(filename)), { recursive: true });
    await fs.writeFile(filename, buffer);
  }
  return { width, height, buffer };
}

module.exports = { layout, exportPng, loadManifest, normalizeText, normalizeStyle, STYLE_FIELDS };

if (require.main === module) {
  require('./scripts/layout_cli').main().catch(error => { console.error(`错误：${error.message}`); process.exitCode = 2; });
}
