'use strict';

const byId = id => document.getElementById(id);
const controls = {
  text: byId('text-input'), font: byId('source-select'), direction: byId('direction-select'),
  char_size: byId('char-size'), char_gap: byId('char-gap'), line_gap: byId('line-gap'),
  margin: byId('margin'), line_length: byId('line-length'), grid: byId('grid-toggle'),
};
const state = { result: null, selections: {}, selectedIndex: 0, renderTicket: 0, candidateTicket: 0,
  pending: true, exporting: false, zoom: 1, flatText: '', defaults: null };
let renderTimer, toastTimer;
const flatText = text => text.replace(/[\p{P}\p{C}\p{Z}\s]/gu, '');

function payload() {
  const style = {};
  for (const [key, input] of Object.entries(controls)) {
    style[key] = key === 'grid' ? input.checked : input.type === 'number' ? input.valueAsNumber : input.value;
  }
  return { style, selections: { ...state.selections }, placeholders: byId('placeholders-toggle').checked };
}

function setStyle(style) {
  for (const [key, input] of Object.entries(controls)) {
    if (key === 'grid') input.checked = style[key];
    else input.value = style[key];
  }
  updateLabels();
}

function updateLabels() {
  const vertical = controls.direction.value === 'vertical';
  byId('line-gap-label').textContent = vertical ? '列距' : '行距';
  byId('line-length-label').textContent = vertical ? '每列字数' : '每行字数';
  byId('character-count').textContent = `${Array.from(flatText(controls.text.value)).length} 字`;
}

function updateButtons() {
  const valid = state.result && !state.result.empty && !state.pending;
  byId('export-button').disabled = !valid || state.exporting;
  byId('reset-glyph').disabled = !valid || !Object.hasOwn(state.selections, state.selectedIndex);
  for (const button of byId('candidate-list').querySelectorAll('button')) button.disabled = !valid;
}

function status(message, error = false) {
  byId('render-status').textContent = message;
  byId('render-status').classList.toggle('error', error);
}

function clearPreview(message, error = false) {
  state.result = null;
  state.candidateTicket++;
  byId('preview-document').replaceChildren();
  byId('preview-document').hidden = true;
  byId('preview-empty').hidden = false;
  byId('preview-empty').querySelector('h3').textContent = error ? '暂时无法生成作品' : '在左侧写下正文';
  byId('preview-empty').querySelector('p').textContent = error ? message : '作品会在这里呈现';
  byId('preview-summary').textContent = '';
  byId('selected-char').textContent = '—';
  byId('selected-position').textContent = '点选正文中的字';
  byId('selected-source').textContent = '比较不同来源的写法';
  byId('candidate-count').textContent = '';
  byId('candidate-list').replaceChildren();
  status(message, error);
  updateButtons();
}

function resizePreview() {
  if (!state.result) return;
  const stage = byId('preview-stage');
  const fit = Math.max(0.02, Math.min((stage.clientWidth - 52) / state.result.width,
    (stage.clientHeight - 52) / state.result.height));
  const scale = fit * state.zoom;
  byId('preview-document').style.width = `${state.result.width * scale}px`;
  byId('preview-document').style.height = `${state.result.height * scale}px`;
  byId('zoom-value').textContent = state.zoom === 1 ? '适应画布' : `${Math.round(scale * 100)}%`;
}

function highlightSelection() {
  const svg = byId('preview-document').querySelector('svg');
  if (!svg || !state.result) return;
  svg.querySelector('[data-preview-selection]')?.remove();
  const cell = state.result.cells[state.selectedIndex];
  if (!cell) return;
  const box = cell.box;
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  const attrs = { x: box.x + 1, y: box.y + 1, width: box.width - 2, height: box.height - 2,
    fill: 'none', stroke: '#9D4335', 'stroke-width': 2, 'stroke-dasharray': '6 4',
    'pointer-events': 'none', 'data-preview-selection': String(cell.index) };
  for (const [name, value] of Object.entries(attrs)) rect.setAttribute(name, value);
  svg.append(rect);
}

async function selectCell(index) {
  const cell = state.result?.cells[index];
  if (!cell || state.pending) return;
  state.selectedIndex = index;
  highlightSelection();
  byId('selected-char').textContent = cell.char;
  byId('selected-position').textContent = `第 ${index + 1} 字 · ${cell.char}`;
  byId('selected-source').textContent = cell.source;
  const list = byId('candidate-list');
  // 切到另一个字后立即撤掉旧按钮，避免加载期间替换上一个位置。
  list.replaceChildren();
  byId('candidate-count').textContent = '载入中';
  const ticket = ++state.candidateTicket;
  let response;
  try { response = await window.jizi.candidates(cell.char); }
  catch (error) { response = { ok: false, message: error.message }; }
  if (ticket !== state.candidateTicket || !state.result) return;
  list.replaceChildren();
  if (!response.ok) {
    list.textContent = response.message;
    byId('candidate-count').textContent = '';
    return;
  }
  byId('candidate-count').textContent = `${response.candidates.length} 种`;
  for (const candidate of response.candidates) {
    const button = document.createElement('button');
    button.className = 'candidate-card';
    button.dataset.source = candidate.source;
    button.setAttribute('aria-label', `将第 ${index + 1} 字 ${cell.char} 替换为 ${candidate.source}`);
    button.setAttribute('aria-pressed', candidate.source === state.result.cells[index].source ? 'true' : 'false');
    const image = document.createElement('img');
    image.src = candidate.image;
    image.alt = `${cell.char} · ${candidate.source}`;
    const label = document.createElement('span');
    label.className = 'source-name';
    label.textContent = candidate.source;
    button.append(image, label);
    button.addEventListener('click', () => {
      if (state.pending) return;
      if (candidate.source === controls.font.value) delete state.selections[index];
      else state.selections[index] = candidate.source;
      render();
    });
    list.append(button);
  }
  updateButtons();
}

async function render() {
  clearTimeout(renderTimer);
  const ticket = ++state.renderTicket;
  state.candidateTicket++;
  state.pending = true;
  updateButtons();
  status('正在生成…');
  updateLabels();
  try {
    const response = await window.jizi.render(payload());
    if (ticket !== state.renderTicket) return;
    state.pending = false;
    byId('input-error').hidden = response.ok;
    if (!response.ok) {
      byId('input-error').textContent = response.message;
      clearPreview(response.message, true);
      return;
    }
    if (response.empty) { clearPreview('请输入正文'); return; }
    state.result = response;
    byId('preview-empty').hidden = true;
    byId('preview-document').hidden = false;
    byId('preview-document').innerHTML = response.svg;
    byId('preview-summary').textContent = `${response.cells.length} 字 · ${response.lines.length} ${response.style.direction === 'vertical' ? '列' : '行'}`;
    const count = Object.keys(state.selections).length;
    status(count ? `已生成 · 已替换 ${count} 字` : '已生成 · 字形就绪');
    for (const group of byId('preview-document').querySelectorAll('[data-index]')) {
      group.setAttribute('tabindex', '0');
      group.setAttribute('role', 'button');
      group.setAttribute('aria-label', `第 ${Number(group.dataset.index) + 1} 字 ${group.dataset.char}，${group.dataset.source}`);
    }
    if (state.selectedIndex >= response.cells.length) state.selectedIndex = 0;
    resizePreview();
    updateButtons();
    await selectCell(state.selectedIndex);
  } catch (error) {
    if (ticket !== state.renderTicket) return;
    state.pending = false;
    byId('input-error').hidden = false;
    byId('input-error').textContent = error.message;
    clearPreview(error.message, true);
  }
}

function scheduleRender() {
  state.renderTicket++;
  state.candidateTicket++;
  state.pending = true;
  updateButtons();
  updateLabels();
  status('正在生成…');
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 180);
}

controls.text.addEventListener('input', () => {
  const current = flatText(controls.text.value);
  if (current !== state.flatText) { state.selections = {}; state.selectedIndex = 0; state.flatText = current; }
  byId('sample-select').value = '';
  state.zoom = 1;
  scheduleRender();
});
controls.font.addEventListener('change', () => { state.selections = {}; render(); });
controls.direction.addEventListener('change', () => {
  const next = controls.direction.value === 'vertical' ? 5 : 10;
  if ([5, 10].includes(controls.line_length.valueAsNumber)) controls.line_length.value = next;
  state.zoom = 1;
  render();
});
for (const key of ['char_size', 'char_gap', 'line_gap', 'margin', 'line_length']) controls[key].addEventListener('input', scheduleRender);
controls.grid.addEventListener('change', render);
byId('placeholders-toggle').addEventListener('change', render);
byId('reset-style').addEventListener('click', () => {
  setStyle({ ...state.defaults, text: controls.text.value });
  state.selections = {};
  state.zoom = 1;
  byId('placeholders-toggle').checked = false;
  render();
});
byId('reset-glyph').addEventListener('click', () => { delete state.selections[state.selectedIndex]; render(); });
byId('preview-document').addEventListener('click', event => {
  if (state.pending || !state.result) return;
  const group = event.target.closest('[data-index]');
  if (group) { selectCell(Number(group.dataset.index)); return; }
  const svg = byId('preview-document').querySelector('svg');
  const matrix = svg?.getScreenCTM();
  if (!matrix) return;
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  const cell = state.result.cells.find(({ box }) => point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height);
  if (cell) selectCell(cell.index);
});
byId('preview-document').addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const group = event.target.closest('[data-index]');
  if (group) { event.preventDefault(); selectCell(Number(group.dataset.index)); }
});
byId('zoom-in').addEventListener('click', () => { state.zoom = Math.min(4, state.zoom * 1.2); resizePreview(); });
byId('zoom-out').addEventListener('click', () => { state.zoom = Math.max(0.25, state.zoom / 1.2); resizePreview(); });
byId('fit-preview').addEventListener('click', () => { state.zoom = 1; resizePreview(); });
new ResizeObserver(resizePreview).observe(byId('preview-stage'));

byId('export-button').addEventListener('click', async () => {
  if (state.pending || !state.result || state.exporting) return;
  state.exporting = true;
  updateButtons();
  byId('export-button').textContent = '正在导出…';
  try {
    const response = await window.jizi.exportPng(payload());
    if (!response.ok) throw new Error(response.message);
    if (!response.canceled) {
      clearTimeout(toastTimer);
      byId('toast').textContent = `已导出：${response.path}（${response.width} × ${response.height}）`;
      byId('toast').hidden = false;
      toastTimer = setTimeout(() => { byId('toast').hidden = true; }, 7000);
    }
  } catch (error) {
    byId('toast').textContent = error.message;
    byId('toast').hidden = false;
  } finally {
    state.exporting = false;
    byId('export-button').innerHTML = '导出 PNG <span aria-hidden="true">↗</span>';
    updateButtons();
  }
});

async function start() {
  const response = await window.jizi.bootstrap();
  if (!response.ok) throw new Error(response.message);
  state.defaults = response.defaultStyle;
  for (const source of response.sources) {
    const option = document.createElement('option');
    option.value = source.name; option.textContent = source.name;
    controls.font.append(option);
  }
  response.presets.forEach((text, index) => {
    const option = document.createElement('option');
    option.value = String(index); option.textContent = text;
    byId('sample-select').append(option);
  });
  byId('sample-select').addEventListener('change', () => {
    const text = response.presets[Number(byId('sample-select').value)];
    if (byId('sample-select').value === '' || text === undefined) return;
    controls.text.value = text;
    state.flatText = flatText(text);
    state.selections = {}; state.selectedIndex = 0; state.zoom = 1;
    render();
  });
  byId('library-info').textContent = `本地字库 · ${response.characterCount} 字 · ${response.sources.length} 种来源`;
  setStyle(response.defaultStyle);
  state.flatText = flatText(controls.text.value);
  await render();
}

start().catch(error => { state.pending = false; clearPreview(`字库载入失败：${error.message}`, true); });
