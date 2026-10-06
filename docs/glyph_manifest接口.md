# glyph-manifest-v1 接口

项目根目录统一为本文件上级的 `ai-jizi/`。B3 的 `ji.py`、字形导出入口 `export_glyphs.py`、后续 B5 的 `layout.js` 和 B4 的 GUI 均放在此项目目录及其子目录中。

本轮保持既有 manifest 结构和字段类型。示例（路径为本机绝对路径）：

```json
{
  "format": "glyph-manifest-v1",
  "note": "占位字形图，MCCD 到手后同格式替换",
  "fonts": {
    "演示夏行楷": { "path": "字体文件路径", "dir": "图目录路径", "missing": [] }
  },
  "chars": {
    "海": { "演示夏行楷": "单字PNG路径" }
  }
}
```

`chars[输入字符][候选来源名称]` 是单字图路径字符串。当前候选来源是四款字体；以后可换成书家或碑帖名称，排版应使用实际键遍历来源，不硬编码字体名。`fonts` 提供来源信息，排版只依赖 `chars` 中的图路径，不读取字体文件；替换为真迹时可保留来源信息字段以兼容消费者。`note` 为说明文字。

占位字形统一为 256×256 RGBA PNG，墨迹居中，透明背景，各边至少 25 像素留白；文件名为 `U+码点_字符.png`。测试文本保持简体，去标点、空白后按 Unicode 码点排序去重。当前 81 字 × 四字体，cmap 全覆盖，每个字都来自指定字体，导出不使用缺字兜底。

后续 MCCD 接入时，简转繁与候选来源选择应在数据查询/manifest 生成端完成；维持输入字符到候选图路径的映射接口。排版端消费字形图和来源键即可。实际真迹接入与 B5 对接在后续任务验收。

`docs/glyph_export_report.json` 单独记录导出数量、透明图验收、字符输入摘要和每来源覆盖情况，不向 manifest 增加验收字段。全部 cmap 预检及临时图片验证成功后才更新已有图片；manifest 在图片写入后提交。

## 2026-10-06 B1+B2 扩展接口

`docs/glyph_manifest_real.json` 为混合本地数据视图，`docs/glyph_manifest_distributable.json` 为仅允许 origin 的视图；原占位 manifest 保留。`chars` 仍是字符→规范来源名（书家·作品）→PNG 路径字符串，可选 `candidates` 保留同来源多字形/数据库 id/origin/上游原字符，`sources` 保留书家作品与 origin，`aliases` 记录查询别名。路径相对 ai-jizi 根目录。

OpenCC 对整句输入转换一次；数据保留原标签，避免“千里”被二次转换成“千裏”。一简多繁标签不猜字形身份。`爲/為` 等价字形可查。B5、B4 service 已以现有接口消费此扩展版并完成 10 条样张及候选切换验证，代码未改。混合本地 manifest 和 glyphs.db 含 shufaziti，禁止打包；占位版打包已排除自动夹带根目录研究库。完整用法见 [B1B2三源入库与查询](B1B2三源入库与查询.md)。
