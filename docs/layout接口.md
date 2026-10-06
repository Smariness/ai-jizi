# B5：layout.js 接口与验收

项目根目录：`C:/Users/admin/WorkBuddy/2026-10-03-19-58-03/ai-jizi/`。运行环境为 Node.js 22+；图像依赖 sharp 固定为 0.35.4，`package-lock.json` 固定依赖树。运行时只读取本地文件，SVG 的字形图全部内嵌，不读取 TTF、不请求网络。

## 运行

```powershell
node layout.js --text "海内存知己，天涯若比邻" --font 演示夏行楷 --out output/b5/demo
node layout.js --config docs/b5_style_example.json --out output/b5/from_config
node layout.js --text "海内存知己，天涯若比邻" --font 演示夏行楷 --direction horizontal --out output/b5/horizontal_demo
node layout.js --text "海内存知己" --font 演示夏行楷 --grid --placeholders --out output/b5/template_demo
npm test
npm run verify:b5
npm run verify:b5 -- --offline-check
```

首次部署依赖用 `npm ci --ignore-scripts --no-audit --no-fund`；本机已安装。默认 manifest 路径基于 `layout.js` 位置，默认输出位于本项目的 `output/b5/demo.*`。`--out` 指定文件前缀，同时生成 `.svg`、`.png`、`.json`。PNG 默认宽度为 2560 像素，高度按 SVG 比例计算；`--width` 可显式修改导出宽度。SVG 自身使用逻辑排版尺寸。

## JavaScript 调用

```js
const { layout, exportPng } = require('./layout');
const result = await layout({
  text: '海内存知己，天涯若比邻',
  font: '演示夏行楷',
  direction: 'vertical',
  char_size: 160, char_gap: 24, line_gap: 40, grid: false, margin: 80,
  line_length: 5,
});
// result.svg 是可直接预览的完整 SVG 字符串。
await exportPng(result, 'output/b5/作品.png');
// 后续 GUI 可取 Buffer，再由桌面应用保存对话框写入文件。
const { buffer } = await exportPng(result, undefined, { width: 2560 });
```

返回对象包括 `svg`、`width`、`height`、`style`、`rendered_text`、`lines`、`cells`、`elements`。`cells[index]` 记录字符、来源、行列位置、字身框 `box`、原图墨迹 `ink_bbox`、归一化绘制框 `draw_box`。SVG 中每个字包含 `id="glyph-N"`、`data-index`、`data-char`、`data-source`，供 B4 后续绑定点击事件。

## 样式 JSON

基本字段遵守共同约定：`text, font, direction, char_size, char_gap, line_gap, grid, margin`。支持顶层字段或 `style` 对象；同名顶层字段覆盖 `style` 字段。JSON 示例见 `docs/b5_style_example.json`。

`font` 表示通用来源名称，允许字体、书家或碑帖名称；未指定时取 manifest 的首个来源。默认 `direction=vertical`，竖排列内从上到下、列从右到左；`horizontal` 为行内从左到右、行从上到下。默认字号 160、字距字号的 15%、行/列距字号的 25%、外边距字号的 50%。数值单位为逻辑像素，PNG 导出时整体等比缩放。

扩展字段 `line_length` 控制每列或每行最多字数，竖排默认 5，横排默认 10。换行强制开启新列或新行，空行忽略。`ink_padding` 默认为字号的 5%；`background` 默认为 `#F7F4EC`，设为 `null` 可导出透明背景。

正文默认去除 Unicode 标点、空白和控制字符，占位期保持输入简体。缺字或指定来源不存在时直接报错，当前引擎不自动改变文字或候选来源。

## 数据接口与候选替换

默认读取 `docs/glyph_manifest.json` 的 `chars[字符][来源]`。`manifestPath` 可指定其他 manifest；也可传 `{manifest, projectRoot}`。绝对图路径直接读取，相对图路径相对于项目根目录。

还支持跳过 manifest，直接传入图路径列表：

```js
await layout({
  text: '海内',
  glyphs: [
    { char: '海', source: '某碑帖', path: '/absolute/海.png' },
    '/absolute/内.png',
  ],
});
await layout({ text: '海内', font: '演示夏行楷', selections: { 1: '江西拙楷' } });
```

列表长度和顺序按去标点、去空白后的字符计算（换行不占索引），每个字符对应一张图。`selections` 按同一零起始序号指定其他来源。来源字符串只用于查询与标记，未写死四款字体；测试使用自建“王羲之”来源和异尺寸 PNG 验证了同一引擎可读取新数据。

字形必须为带透明背景且有可见墨迹的 PNG；引擎扫描 alpha>0 的像素得到墨迹包围盒，裁掉原图留白，再按长宽比缩放到统一字身框内并居中，保留 `ink_padding`。真迹原图如仍有纸色背景，须由数据准备阶段处理成透明图。PNG 编码后的裁切图以内嵌 data URI 写入 SVG，因此 SVG 复制到其他目录后仍可预览。`imageCache` 可传 Map 复用图像分析，缓存键包含文件路径、大小和修改时间。

## 占位元素

```js
await layout({
  text: '海内存知己', font: '演示夏行楷',
  elements: { signature: true, head_seal: true, name_seal: true },
});
```

正文是 `body`；`signature` 为落款区，`head_seal` 为引首章，`name_seal` 为名章。启用时保留空间并输出带角色标记和标题的虚线框；这些是占位框，暂不绘制落款文字或印章图像。竖排落款在正文左侧，引首章在上方，名章在下方；横排落款和名章依次置于正文下方。默认不启用，避免改变十条正文验收样张。

## 自测证据与人工验收

`npm run verify:b5` 生成 `output/b5/01_演示夏行楷.*` 至 `10_演示夏行楷.*`，每组包括 SVG、2560px 宽 PNG、布局 JSON。证据汇总为 `output/b5/acceptance_report.json`；逐图检查去标点后字符完整、竖排列首由右向左、墨迹绘制框不越界，并对最终 PNG 逐字检查实际墨迹存在且不触及字身框边缘。

`output/b5/contact_sheet.png` 按测试文本顺序排列，第一行 1～5，第二行 6～10。附加样张 `horizontal.svg/.png` 展示横排，`placeholders.svg/.png` 展示米字格及三个占位框。

`--offline-check` 在导入引擎之前禁用进程中的 HTTP、HTTPS、Socket 连接和 fetch API，再执行全部十条验收与附加样张，报告记录网络 API 是否禁用及尝试次数。这验证运行时无需网络；真机断网验收留在后续桌面应用验收环节。

人工请看：从右边首列开始是否读到原文、列首是否无标点、字形是否完整、列间是否留出间隔。自动自测通过后仍由颜钰验收；本轮未实现 GUI、章法优化或真迹数据库接入。
